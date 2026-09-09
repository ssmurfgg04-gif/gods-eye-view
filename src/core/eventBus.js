/**
 * @module eventBus
 * @description Synchronous, replay-aware publish/subscribe bus — the
 * microsecond-latency spine between data layers and every future consumer.
 *
 * The MILLION-X LATENCY bet: today the app moves information by *polling and
 * reach-through* — a layer updates, then whoever cares must already have a
 * reference and re-read state on its own clock. That is O(wait) latency, and
 * it is the reason a globe that "just fetched new data" can still show a stale
 * HUD panel for a full render cycle. An event bus inverts the contract: the
 * moment data lands, every interested subsystem knows — same tick, zero
 * scheduled delay. Poll ticks become the *ingestion* mechanism, not the
 * *distribution* mechanism, which is the architectural prerequisite for any
 * future streaming push (SSE/websocket feeds can publish into the same bus
 * without a single consumer changing).
 *
 * Design decisions, in order of how often they get questioned:
 * - **Synchronous dispatch.** A listener sees the event before `publish()`
 *   returns. No task queue, no batching window: propagation cost is a loop
 *   over a Set, i.e. microseconds. (Backpressure is the *publisher's*
 *   problem, same as the render governor's requestRender coalescing.)
 * - **Bounded replay buffer per channel.** Lazy-loaded modules arrive *late*
 *   by design (the whole perf wave was about deferring code). A subscriber
 *   may pass `{replay: true}` to receive the last `replayDepth` buffered
 *   events immediately on subscribe — a module loaded five minutes in still
 *   sees the last five minutes of history instead of a cold void.
 * - **Coalescing in the buffer only.** Bursts with the same `coalesceKey`
 *   merge into one buffered entry (latest payload wins, `mergedCount`
 *   accumulates). Listeners are never dropped — dispatch stays lossless;
 *   only *memory* is bounded, because an unbounded replay buffer is a leak
 *   wearing a feature's clothes.
 * - **Listener isolation.** A throwing listener is logged and skipped. The
 *   bus is infrastructure: one bad consumer must not sever the spine for
 *   everyone downstream of it.
 *
 * Channel naming convention: `domain:subject:aspect` — e.g.
 * `layer:earthquakes:update`. Subscribers match exactly, by `prefix:*`
 * wildcard, or with a RegExp. Node-testable: no DOM, no timers, injectable
 * clock for replay timestamps.
 */

/** @constant {number} Default replay buffer depth per channel. */
const DEFAULT_REPLAY_DEPTH = 32;
/** @constant {number} Diagnostics cap: channels reported per snapshot. */
const DIAG_CHANNELS_CAP = 64;

/**
 * @typedef {object} BusEvent
 * @property {string} channel Channel this event was published on.
 * @property {*} payload Published payload (owned by the publisher; treat as
 *   read-only downstream).
 * @property {number} at Epoch-ish ms from the bus clock (test-injectable).
 * @property {string|null} coalesceKey Merge key for burst coalescing.
 * @property {number} mergedCount How many burst publishes merged into this
 *   buffered entry (1 = standalone).
 */

/**
 * @typedef {object} EventBusOptions
 * @property {number} [replayDepth] Per-channel replay buffer depth.
 * @property {() => number} [now] Clock (defaults to Date.now).
 */

/**
 * Build an isolated event bus.
 * @param {EventBusOptions} [options]
 */
export function createEventBus(options = {}) {
  // `== null` guard, NOT `Number(x) ?? default` — Number(undefined) is NaN
  // (not nullish), which would silently disable the replay buffer.
  const replayDepth = options.replayDepth == null
    ? DEFAULT_REPLAY_DEPTH
    : Math.max(0, Math.floor(Number(options.replayDepth) || 0));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /** @type {Map<string, {buffer: BusEvent[], publishCount: number, coalescedCount: number, lastAt: number}>} */
  const channels = new Map();
  /**
   * Subscriber records. Pattern is either an exact channel string, a
   * `prefix:*` wildcard, a RegExp, or `'*'` (everything).
   * @type {Set<{match: (channel: string) => boolean, handler: Function, label: string}>}
   */
  const subscribers = new Set();

  function channelState(channel) {
    let state = channels.get(channel);
    if (!state) {
      state = { buffer: [], publishCount: 0, coalescedCount: 0, lastAt: 0 };
      channels.set(channel, state);
    }
    return state;
  }

  function matcherFor(pattern) {
    if (pattern === '*') {
      return { match: () => true, label: '*' };
    }
    if (typeof pattern === 'string') {
      if (pattern.endsWith(':*')) {
        const prefix = pattern.slice(0, -1); // keep the trailing ':'
        return { match: (c) => c.startsWith(prefix), label: pattern };
      }
      return { match: (c) => c === pattern, label: pattern };
    }
    if (pattern instanceof RegExp) {
      return { match: (c) => pattern.test(c), label: String(pattern) };
    }
    return null;
  }

  /**
   * Publish an event. Dispatch is synchronous; returns the number of
   * listeners notified (a return value keeps the bus observable in tests
   * without fake listeners on the singleton).
   * @param {string} channel
   * @param {*} payload
   * @param {{coalesceKey?: string}} [meta]
   * @returns {number}
   */
  function publish(channel, payload, meta = {}) {
    if (typeof channel !== 'string' || !channel) return 0;
    const state = channelState(channel);
    const at = now();
    state.publishCount += 1;
    state.lastAt = at;

    // --- Buffer with burst coalescing (memory bound, not dispatch bound). ---
    const coalesceKey = typeof meta.coalesceKey === 'string' ? meta.coalesceKey : null;
    if (replayDepth > 0) {
      const last = state.buffer[state.buffer.length - 1];
      if (coalesceKey && last && last.coalesceKey === coalesceKey) {
        last.payload = payload;
        last.at = at;
        last.mergedCount += 1;
        state.coalescedCount += 1;
      } else {
        const event = { channel, payload, at, coalesceKey, mergedCount: 1 };
        state.buffer.push(event);
        if (state.buffer.length > replayDepth) state.buffer.shift();
      }
    }

    // --- Synchronous fan-out. ---
    let notified = 0;
    for (const subscriber of subscribers) {
      if (!subscriber.match(channel)) continue;
      notified += 1;
      try {
        subscriber.handler(payload, { channel, at, coalesceKey });
      } catch (error) {
        // The spine survives a bad consumer; the console is the audit trail.
        console.warn('[eventBus] subscriber error on', channel, error);
      }
    }
    return notified;
  }

  /**
   * Subscribe to a channel pattern.
   * @param {string|RegExp} pattern Exact channel, `prefix:*` wildcard, `'*'`,
   *   or RegExp.
   * @param {(payload: *, meta: {channel: string, at: number}) => void} handler
   * @param {{replay?: boolean}} [options] `replay: true` immediately feeds
   *   this subscriber the channel's buffered history (exact-channel pattern
   *   only — wildcards replay nothing, deliberately: a wildcard subscriber
   *   asking for "everything, historically" is unbounded by definition).
   * @returns {() => void} Unsubscribe.
   */
  function subscribe(pattern, handler, options = {}) {
    if (typeof handler !== 'function') return () => {};
    const matcher = matcherFor(pattern);
    if (!matcher) return () => {};
    const record = { match: matcher.match, handler, label: matcher.label };
    subscribers.add(record);

    if (options.replay && typeof pattern === 'string' && !pattern.endsWith(':*') && pattern !== '*') {
      const history = channels.get(pattern)?.buffer ?? [];
      for (const event of history) {
        try {
          handler(event.payload, { channel: event.channel, at: event.at, coalesceKey: event.coalesceKey });
        } catch (error) {
          console.warn('[eventBus] replay dispatch error on', pattern, error);
        }
      }
    }
    return () => {
      subscribers.delete(record);
    };
  }

  /** Buffered history for an exact channel (frozen copy). */
  function replay(channel) {
    if (typeof channel !== 'string') return [];
    const history = channels.get(channel)?.buffer ?? [];
    return Object.freeze(history.slice());
  }

  /** Diagnostics: bus shape without exposing live payloads. */
  function diagnostics() {
    const channelReports = [];
    for (const [channel, state] of channels) {
      channelReports.push(Object.freeze({
        channel,
        publishCount: state.publishCount,
        coalescedCount: state.coalescedCount,
        bufferDepth: state.buffer.length,
        lastAt: state.lastAt,
      }));
      if (channelReports.length >= DIAG_CHANNELS_CAP) break;
    }
    return Object.freeze({
      channels: Object.freeze(channelReports),
      channelCount: channels.size,
      subscriberCount: subscribers.size,
      replayDepth,
    });
  }

  /** Test seam: drop all subscribers and buffered history. */
  function reset() {
    subscribers.clear();
    channels.clear();
  }

  return Object.freeze({
    publish,
    subscribe,
    replay,
    diagnostics,
    reset,
  });
}

/**
 * The application bus singleton. Every lazy-loaded layer and deferred
 * subsystem reaches the SAME instance through this export (module identity),
 * which is what makes late subscription + replay meaningful.
 */
export const gevEventBus = createEventBus();
