/**
 * @module feedScheduler
 * @description One owner for every periodic feed poll in the app.
 *
 * Before this module existed, each data layer ran its own `setInterval`
 * against rate-limited providers: no shared backoff, no visibility
 * coordination, and bursts of enable-time polls that all fired at the same
 * wall-clock instant. That is exactly how credit-governor-shaped outages and
 * 429 cascades start (see manager.js M1 note, OpenSky double-poll).
 *
 * Contract:
 * - **Jittered cadence** — every job's first tick is spread within its first
 *   interval window, and steady-state ticks carry ±8% jitter so N layers
 *   never align into a thundering herd.
 * - **Failure backoff** — a tick that rejects (or returns `{ok:false}`)
 *   doubles the job's effective interval up to `maxBackoffMs`, and resets to
 *   the base interval after `backoffRecoverySuccesses` consecutive successes.
 *   A provider outage therefore degrades poll pressure exponentially instead
 *   of hammering a dying endpoint.
 * - **Visibility pause** — while `document.hidden` is true, ticks are skipped
 *   (never queued in a burst): a hidden tab polls for nobody. On
 *   `visibilitychange` back to visible, the next tick is pulled forward so
 *   the user does not stare at stale data for a full interval.
 * - **No overlapping ticks** — if a tick is still in flight when the next is
 *   due (a slow upstream), the due tick is skipped, not queued. Polls never
 *   pile up behind a slow response.
 * - **Diagnostics** — `getFeedSchedulerDiagnostics()` reports every job's
 *   cadence, backoff multiplier, last result, and circuit state for the
 *   debug console.
 * - **Circuit breaker** (feed health) — every tick is gated by the shared
 *   feed-health tracker: while a feed's circuit is OPEN the network call is
 *   skipped entirely (serve-stale keeps the layer alive), and while a probe
 *   is due the tick IS the probe. Skips are not failures — the breaker
 *   already rendered its verdict; backoff must not double-punish.
 *
 * The scheduler is deliberately framework-free and node-testable: it uses
 * `setTimeout` chains (not `setInterval`) so each hop can recompute delay,
 * and it only touches `document` when one exists. Health wiring is
 * constructor-injected so isolated tests can disable or fake it.
 */

import { createFeedHealth, feedHealth } from './feedHealth.js';

/** @constant {number} Fraction of interval used as jitter (±). */
const JITTER_FRACTION = 0.08;
/** @constant {number} Minimum absolute jitter in ms so near-zero intervals still de-align. */
const MIN_JITTER_MS = 150;
/** @constant {number} Cap on backoff growth. */
const DEFAULT_MAX_BACKOFF_MS = 10 * 60 * 1000;
/** @constant {number} Successes required before backoff resets. */
const DEFAULT_RECOVERY_SUCCESSES = 2;
/** @constant {number} Multiplier applied per consecutive failure. */
const BACKOFF_MULTIPLIER = 2;
/** @constant {number} Diagnostics cap for last tick outcomes per job. */
const HISTORY_CAP = 8;

/**
 * @typedef {object} FeedSchedulerJob
 * @property {string} id Stable owner id, e.g. 'earthquakes'.
 * @property {number} intervalMs Base cadence.
 * @property {() => (void|boolean|Promise<void|boolean>)} tick Async poll body.
 *   Return `false` (or reject) to register a failure for backoff purposes.
 * @property {number} [maxBackoffMs] Backoff ceiling for this job.
 * @property {boolean} [pauseWhenHidden=true] Skip ticks while the tab is hidden.
 * @property {number} [initialDelayMs] Override the jittered first-fire delay.
 * @property {() => void} [onError] Failure hook (layers keep their own chips).
 * @property {string} [healthId] Feed-health circuit identity. Defaults to
 *   the job id; pass a shared id to make several jobs share one circuit
 *   (e.g. a layer's poll + its stats refresh hitting the same provider).
 */

class FeedSchedulerImpl {
  /**
   * @param {{health?: object|null}} [options] Health tracker consulted
   *   before/after each tick. Pass `null` to disable (hermetic tests);
   *   defaults to the module singleton. Inject a `createFeedHealth()`
   *   instance for isolated breaker tests.
   */
  constructor(options = {}) {
    /** @type {Map<string, FeedSchedulerJob & {timer, state}>} */
    this._jobs = new Map();
    this._visibilityListenersInstalled = false;
    this._now = () => Date.now();
    this._health = options.health === null ? null : (options.health ?? feedHealth);
  }

  /** Test seam: inject a clock. */
  _setClock(now) {
    if (typeof now === 'function') this._now = now;
  }

  _ensureVisibilityListeners() {
    if (this._visibilityListenersInstalled || typeof document === 'undefined') return;
    this._visibilityListenersInstalled = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._pullForwardAll();
    });
  }

  /**
   * Register (or replace) a periodic job. Re-registering the same id stops
   * the previous chain first — that is the scheduler's arm/disarm pair.
   * @param {FeedSchedulerJob} job
   * @returns {() => void} Cancel function (also available as cancel(id)).
   */
  schedule(job) {
    if (!job || typeof job.id !== 'string' || !job.id) throw new Error('Feed job requires a stable id');
    if (typeof job.tick !== 'function') throw new Error(`Feed job ${job.id} requires a tick function`);
    if (!(Number(job.intervalMs) > 0)) throw new Error(`Feed job ${job.id} requires a positive intervalMs`);
    this.cancel(job.id);
    const entry = {
      ...job,
      intervalMs: Number(job.intervalMs),
      maxBackoffMs: Number(job.maxBackoffMs) > 0 ? Number(job.maxBackoffMs) : DEFAULT_MAX_BACKOFF_MS,
      pauseWhenHidden: job.pauseWhenHidden !== false,
      backoffMs: 0,
      consecutiveFailures: 0,
      successesSinceBackoff: 0,
      inFlight: false,
      lastTickAt: 0,
      lastResult: 'pending',
      history: [],
      timer: null,
      cancelled: false,
    };
    this._jobs.set(job.id, entry);
    this._ensureVisibilityListeners();
    const firstDelay = Number.isFinite(job.initialDelayMs) && job.initialDelayMs >= 0
      ? job.initialDelayMs
      : this._jitter(entry.intervalMs);
    this._arm(entry, firstDelay);
    return () => this.cancel(job.id);
  }

  /** Stop a job. Safe when unknown/already stopped. */
  cancel(id) {
    const entry = this._jobs.get(id);
    if (!entry) return false;
    entry.cancelled = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    this._jobs.delete(id);
    return true;
  }

  cancelAll() {
    for (const id of [...this._jobs.keys()]) this.cancel(id);
  }

  /** True when the job exists and has not been cancelled. */
  isActive(id) {
    return this._jobs.has(id);
  }

  /** Current effective interval (base + active backoff), for diagnostics. */
  effectiveIntervalMs(id) {
    const entry = this._jobs.get(id);
    if (!entry) return 0;
    return Math.min(entry.intervalMs + entry.backoffMs, entry.maxBackoffMs);
  }

  _jitter(intervalMs) {
    const span = Math.max(intervalMs * JITTER_FRACTION, MIN_JITTER_MS);
    return Math.max(0, intervalMs - span + Math.random() * span * 2);
  }

  _arm(entry, delayMs) {
    if (entry.cancelled) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this._runTick(entry), Math.max(0, delayMs));
  }

  /** Hidden-tab skip: pull the next tick forward to ~immediately on reveal. */
  _pullForwardAll() {
    for (const entry of this._jobs.values()) {
      if (entry.cancelled || entry.inFlight) continue;
      this._arm(entry, this._jitter(250));
    }
  }

  async _runTick(entry) {
    if (entry.cancelled) return;
    if (entry.pauseWhenHidden && typeof document !== 'undefined' && document.hidden) {
      // Retry shortly after the likely reveal instead of queueing work.
      this._arm(entry, 1000);
      return;
    }
    if (entry.inFlight) {
      // Slow upstream: skip this due tick entirely, never queue a second.
      this._arm(entry, this._jitter(entry.intervalMs));
      return;
    }
    // Circuit breaker (feed health): while the feed's circuit is open, the
    // tick never touches the network — serve-stale in feedCache keeps the
    // layer visually alive, and the skip is NOT a failure sample (the breaker
    // already knows; backoff must not double-punish one outage). When the
    // cool-down elapses the gate flips to half-open and this tick becomes the
    // single probe.
    const healthId = entry.healthId ?? entry.id;
    if (this._health) {
      const gate = this._health.shouldAttempt(healthId);
      if (!gate.attempt) {
        entry.lastResult = 'circuit-open';
        this._health.noteCircuitSkip(healthId);
        this._arm(entry, Math.max(gate.retryInMs, this._jitter(entry.intervalMs)));
        return;
      }
    }
    entry.inFlight = true;
    entry.lastTickAt = this._now();
    const tickStartedAt = this._now();
    let ok = true;
    let error = null;
    try {
      const result = await entry.tick();
      if (result === false) ok = false;
    } catch (thrown) {
      ok = false;
      error = thrown;
    } finally {
      entry.inFlight = false;
    }
    if (this._health) {
      this._health.recordResult(healthId, {
        ok,
        durationMs: Math.max(0, this._now() - tickStartedAt),
      });
    }
    entry.lastResult = ok ? 'ok' : (error ? 'error' : 'rejected');
    entry.history.push({ at: this._now(), ok });
    if (entry.history.length > HISTORY_CAP) entry.history.shift();
    if (ok) {
      entry.consecutiveFailures = 0;
      if (entry.backoffMs > 0) {
        entry.successesSinceBackoff += 1;
        if (entry.successesSinceBackoff >= DEFAULT_RECOVERY_SUCCESSES) {
          entry.backoffMs = 0;
          entry.successesSinceBackoff = 0;
        }
      }
    } else {
      entry.consecutiveFailures += 1;
      entry.successesSinceBackoff = 0;
      // Exponential backoff, doubling per consecutive failure, capped.
      entry.backoffMs = Math.min(
        entry.intervalMs * (BACKOFF_MULTIPLIER ** Math.min(entry.consecutiveFailures, 10)),
        entry.maxBackoffMs,
      );
      if (typeof entry.onError === 'function') {
        try {
          entry.onError(error);
        } catch {
          // A failing error hook must not take down the scheduler.
        }
      }
    }
    const next = this._jitter(Math.min(entry.intervalMs + entry.backoffMs, entry.maxBackoffMs));
    this._arm(entry, next);
  }

  getFeedSchedulerDiagnostics() {
    const jobs = [];
    for (const entry of this._jobs.values()) {
      jobs.push({
        id: entry.id,
        intervalMs: entry.intervalMs,
        effectiveIntervalMs: this.effectiveIntervalMs(entry.id),
        backoffMs: entry.backoffMs,
        consecutiveFailures: entry.consecutiveFailures,
        lastTickAt: entry.lastTickAt,
        lastResult: entry.lastResult,
        inFlight: entry.inFlight,
        healthId: entry.healthId ?? entry.id,
        circuit: this._health ? this._health.shouldAttempt(entry.healthId ?? entry.id).state : 'off',
      });
    }
    return Object.freeze({ jobs: Object.freeze(jobs) });
  }
}

const scheduler = new FeedSchedulerImpl();

export const feedScheduler = scheduler;
export function scheduleFeed(job) {
  return scheduler.schedule(job);
}
export function cancelFeed(id) {
  return scheduler.cancel(id);
}
export function getFeedSchedulerDiagnostics() {
  return scheduler.getFeedSchedulerDiagnostics();
}
/**
 * Test seam: build an isolated scheduler. Each instance gets a FRESH health
 * tracker so breaker tests hermetically control the clock, and the module
 * singletons stay clean. Pass `{health: null}` to disable breaker gating
 * entirely, or `{health: createFeedHealth({...})}` for a configured one.
 */
export function createFeedScheduler(options = {}) {
  if (options && options.health !== undefined) {
    return new FeedSchedulerImpl(options);
  }
  return new FeedSchedulerImpl({ health: createFeedHealth() });
}
