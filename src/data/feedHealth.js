/**
 * @module feedHealth
 * @description Per-feed health telemetry and a circuit breaker for outbound
 * polling — the self-healing half of feed resilience.
 *
 * The MILLION-X RESILIENCE bet: feedScheduler already degrades poll
 * *pressure* (jitter, backoff, visibility pause). What it cannot know is
 * whether the feed is *actually down* or just slow — backoff treats every
 * failure identically and recovers blindly on the next scheduled attempt.
 * Health telemetry closes that loop:
 *
 * - **EWMA stats per feed** — success rate and latency, exponentially
 *   weighted, so the last few attempts dominate without a sliding window's
 *   memory cost. The snapshot is honest enough to drive UI ("USGS: 99.8 %
 *   · 210 ms") and stable enough not to flap.
 * - **Circuit breaker** — CLOSED (normal) → OPEN (feed believed down: N
 *   consecutive failures, or sustained ≥75 % failure EWMA with enough
 *   samples) → HALF-OPEN (one probe after a cool-down) → CLOSED on success,
 *   re-OPEN with an *escalated* cool-down on probe failure. Trips double the
 *   next cool-down up to a 10-minute cap, so a hard-down provider sees
 *   exponentially less traffic instead of a fixed drumbeat.
 * - **Scheduler integration** — `shouldAttempt()` gates each tick: while a
 *   circuit is OPEN, the scheduler skips the network call entirely (the
 *   feedCache's serve-stale keeps the layer visually alive), and the skip is
 *   *not* counted as a failure — the breaker already knows; piling backoff
 *   on top of an open circuit is double punishment for one crime.
 * - **Stale tracking** — a serve-stale response counts as success for the
 *   breaker (the cache did its job) but lands in its own `staleShare` EWMA,
 *   so "nominally fine but quietly stale" is visible in diagnostics.
 *
 * State machine notes: OPEN→HALF_OPEN is evaluated lazily inside
 * `shouldAttempt` (no timers — a hidden tab consumes nothing, consistent
 * with the scheduler's visibility pause). All thresholds are injectable and
 * the clock is a seam: fully Node-testable.
 */

/** @constant {number} Consecutive failures before a circuit opens. */
const DEFAULT_FAILURE_THRESHOLD = 5;
/** @constant {number} Minimum samples before the EWMA failure rate may trip. */
const DEFAULT_MIN_SAMPLES = 8;
/** @constant {number} EWMA failure rate at/above which a circuit opens. */
const DEFAULT_FAILURE_RATE_THRESHOLD = 0.75;
/** @constant {number} Base cool-down for an open circuit, ms. */
const DEFAULT_COOLDOWN_MS = 60_000;
/** @constant {number} Maximum escalated cool-down, ms (10 minutes). */
const DEFAULT_MAX_COOLDOWN_MS = 10 * 60_000;
/** @constant {number} EWMA alpha for success rate. */
const DEFAULT_SUCCESS_ALPHA = 0.3;
/** @constant {number} EWMA alpha for latency. */
const DEFAULT_LATENCY_ALPHA = 0.2;
/** @constant {number} EWMA alpha for stale share. */
const DEFAULT_STALE_ALPHA = 0.2;

/**
 * @typedef {'closed'|'open'|'half-open'} CircuitState
 */

/**
 * @typedef {object} FeedHealthOptions
 * @property {() => number} [now] Clock (default Date.now).
 * @property {number} [failureThreshold]
 * @property {number} [minSamples]
 * @property {number} [failureRateThreshold]
 * @property {number} [cooldownMs]
 * @property {number} [maxCooldownMs]
 * @property {number} [successAlpha]
 * @property {number} [latencyAlpha]
 * @property {number} [staleAlpha]
 */

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build an isolated feed-health tracker.
 * @param {FeedHealthOptions} [options]
 */
export function createFeedHealth(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const failureThreshold = Math.max(1, finiteOr(options.failureThreshold, DEFAULT_FAILURE_THRESHOLD));
  const minSamples = Math.max(1, finiteOr(options.minSamples, DEFAULT_MIN_SAMPLES));
  const failureRateThreshold = finiteOr(options.failureRateThreshold, DEFAULT_FAILURE_RATE_THRESHOLD);
  const cooldownMs = Math.max(1, finiteOr(options.cooldownMs, DEFAULT_COOLDOWN_MS));
  const maxCooldownMs = Math.max(cooldownMs, finiteOr(options.maxCooldownMs, DEFAULT_MAX_COOLDOWN_MS));
  const successAlpha = Math.min(1, Math.max(0.01, finiteOr(options.successAlpha, DEFAULT_SUCCESS_ALPHA)));
  const latencyAlpha = Math.min(1, Math.max(0.01, finiteOr(options.latencyAlpha, DEFAULT_LATENCY_ALPHA)));
  const staleAlpha = Math.min(1, Math.max(0.01, finiteOr(options.staleAlpha, DEFAULT_STALE_ALPHA)));

  /**
   * @typedef {object} FeedHealthEntry
   * @property {CircuitState} state
   * @property {number} consecutiveFailures
   * @property {number} consecutiveSuccesses
   * @property {number} samples Total recorded results.
   * @property {number} successEwma 0..1.
   * @property {number} latencyEwmaMs
   * @property {number} staleShareEwma 0..1.
   * @property {number} trips Lifetime circuit opens.
   * @property {number} openedAt Epoch ms of the last OPEN transition.
   * @property {number} cooldownUntil Epoch ms — earliest HALF_OPEN probe.
   * @property {number} skipCount Ticks skipped while OPEN (diagnostics).
   */
  /** @type {Map<string, FeedHealthEntry>} */
  const feeds = new Map();

  function entry(feedId) {
    let record = feeds.get(feedId);
    if (!record) {
      record = {
        state: 'closed',
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        samples: 0,
        successEwma: 1,
        latencyEwmaMs: 0,
        staleShareEwma: 0,
        trips: 0,
        openedAt: 0,
        cooldownUntil: 0,
        skipCount: 0,
      };
      feeds.set(feedId, record);
    }
    return record;
  }

  /**
   * May we hit this feed right now? While OPEN, answers no and reports when
   * the HALF_OPEN probe becomes due (the scheduler arms its next tick at
   * max(retryInMs, jittered interval) — the breaker, not the backoff, owns
   * the schedule while the circuit is open).
   * @param {string} feedId
   * @returns {{attempt: boolean, state: CircuitState, probe: boolean, retryInMs: number}}
   */
  function shouldAttempt(feedId) {
    const record = entry(String(feedId ?? 'unknown'));
    const currentTime = now();
    if (record.state === 'open') {
      if (currentTime >= record.cooldownUntil) {
        record.state = 'half-open';
        return { attempt: true, state: 'half-open', probe: true, retryInMs: 0 };
      }
      const retryInMs = Math.max(0, record.cooldownUntil - currentTime);
      return { attempt: false, state: 'open', probe: false, retryInMs };
    }
    return { attempt: true, state: record.state, probe: record.state === 'half-open', retryInMs: 0 };
  }

  /**
   * Record one feed result and run breaker transitions.
   * @param {string} feedId
   * @param {{ok: boolean, durationMs?: number, stale?: boolean}} result
   * @returns {{from: CircuitState, to: CircuitState, tripped: boolean, recovered: boolean}}
   */
  function recordResult(feedId, result = {}) {
    const record = entry(String(feedId ?? 'unknown'));
    const ok = result.ok === true;
    const durationMs = Math.max(0, finiteOr(result.durationMs, 0));
    const from = record.state;

    record.samples += 1;
    record.successEwma = record.samples === 1
      ? (ok ? 1 : 0)
      : successAlpha * (ok ? 1 : 0) + (1 - successAlpha) * record.successEwma;
    if (ok && durationMs > 0) {
      record.latencyEwmaMs = record.samples === 1
        ? durationMs
        : latencyAlpha * durationMs + (1 - latencyAlpha) * record.latencyEwmaMs;
    }
    if (ok && result.stale === true) {
      record.staleShareEwma = record.samples === 1
        ? 1
        : staleAlpha * 1 + (1 - staleAlpha) * record.staleShareEwma;
    } else if (ok) {
      record.staleShareEwma = record.samples === 1
        ? 0
        : staleAlpha * 0 + (1 - staleAlpha) * record.staleShareEwma;
    }

    if (ok) {
      record.consecutiveFailures = 0;
      record.consecutiveSuccesses += 1;
    } else {
      record.consecutiveSuccesses = 0;
      record.consecutiveFailures += 1;
    }

    let to = from;
    let tripped = false;
    let recovered = false;

    if (from === 'half-open') {
      if (ok) {
        to = 'closed';
        recovered = true;
        record.consecutiveFailures = 0;
      } else {
        to = 'open';
        record.openedAt = now();
        // Escalated cool-down: 2^(trips) × base, capped.
        record.cooldownUntil = record.openedAt
          + Math.min(maxCooldownMs, cooldownMs * (2 ** Math.min(record.trips, 6)));
      }
    } else if (from === 'closed') {
      const failureRate = 1 - record.successEwma;
      const hardTrip = record.consecutiveFailures >= failureThreshold;
      const ewmaTrip = record.samples >= minSamples && failureRate >= failureRateThreshold;
      if (hardTrip || ewmaTrip) {
        to = 'open';
        tripped = true;
        record.trips += 1;
        record.openedAt = now();
        record.cooldownUntil = record.openedAt
          + Math.min(maxCooldownMs, cooldownMs * (2 ** Math.min(record.trips - 1, 6)));
      }
    }
    record.state = to;
    return { from, to, tripped, recovered };
  }

  /**
   * A scheduler tick was skipped because the circuit was OPEN. Counted for
   * diagnostics; deliberately NOT a failure sample — the breaker already
   * rendered its verdict.
   * @param {string} feedId
   */
  function noteCircuitSkip(feedId) {
    const record = entry(String(feedId ?? 'unknown'));
    record.skipCount += 1;
  }

  /**
   * Frozen diagnostics for the debug console / health UI.
   * @returns {object}
   */
  function getFeedHealthSnapshot() {
    const reports = [];
    for (const [feedId, record] of feeds) {
      const currentTime = now();
      reports.push(Object.freeze({
        feedId,
        state: record.state,
        consecutiveFailures: record.consecutiveFailures,
        samples: record.samples,
        successRate: Number(record.successEwma.toFixed(3)),
        latencyMs: Number(record.latencyEwmaMs.toFixed(0)),
        staleShare: Number(record.staleShareEwma.toFixed(3)),
        trips: record.trips,
        skipCount: record.skipCount,
        retryInMs: record.state === 'open' ? Math.max(0, record.cooldownUntil - currentTime) : 0,
      }));
    }
    return Object.freeze({ feeds: Object.freeze(reports) });
  }

  /** Test seam: forget every feed. */
  function reset() {
    feeds.clear();
  }

  return Object.freeze({
    shouldAttempt,
    recordResult,
    noteCircuitSkip,
    getFeedHealthSnapshot,
    reset,
  });
}

/**
 * The application feed-health singleton — the scheduler consults this
 * instance for every managed layer poll.
 */
export const feedHealth = createFeedHealth();

/** Test seam: reset the module singleton. */
export function _resetFeedHealthForTest() {
  feedHealth.reset();
}
