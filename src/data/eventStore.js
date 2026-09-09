/**
 * @module eventStore
 * @description Append-only, bounded event log with snapshot compaction and
 * time-travel queries — "rewind the planet" as a data primitive.
 *
 * The MILLION-X MEMORY bet: right now every layer's history is exactly one
 * snapshot deep — the previous poll is destroyed the moment the next one
 * lands (`entities.removeAll()` + rebuild). That means no scrubbing back to
 * "what did the world look like 20 minutes ago", no post-hoc "when did this
 * event first appear", no audit trail of what the console showed when. An
 * append-only store with replay fixes the *shape* of the problem:
 *
 * - **Append-only ring buffer** — every layer mutation is an event
 *   `{at, type, layerId, payload}` in a bounded ring (oldest events fall off
 *   the front; the horizon is capacity, by design, so "temporal depth" has a
 *   memory bill you can read off one number).
 * - **Snapshot compaction** — every `snapshotEvery` deltas per layer, the
 *   store folds current state and appends a synthetic snapshot event, so a
 *   `stateAt(t)` replay only walks the deltas since the nearest snapshot
 *   instead of the whole history.
 * - **stateAt(t, layerId)** — fold the last snapshot at-or-before `t` plus
 *   the subsequent deltas ≤ t: the layer's world state as of any moment
 *   inside the horizon.
 * - **Bus recorder** — `ensureBusRecorderInstalled()` subscribes the store to
 *   the event bus once (module-level idempotence) so layers that publish
 *   `layer:*` envelopes get recorded without each layer wiring the store by
 *   hand, and without double-recording when several layers boot.
 *
 * State-shape convention (deliberately dumb, so any layer can adopt): the
 * folded state is `{count, ids, meta}` — 'snapshot' replaces it, 'add'/
 * 'remove' union/subtract `ids`, 'update' shallow-merges `meta`, 'clear'
 * zeroes it. Layers needing richer replay publish bigger snapshot payloads;
 * the fold contract stays the same.
 *
 * Pure data structures, injectable clock, no DOM — Node-testable.
 */

import { gevEventBus } from '../core/eventBus.js';

/** @constant {number} Default ring buffer capacity (events). */
const DEFAULT_CAPACITY = 2048;
/** @constant {number} Synthetic snapshot cadence (deltas per layer). */
const DEFAULT_SNAPSHOT_EVERY = 24;
/** @constant {number} id list cap per event payload (bounded memory). */
const IDS_CAP = 512;

/**
 * @typedef {'snapshot'|'add'|'update'|'remove'|'clear'} LayerEventType
 */

/**
 * @typedef {object} LayerEvent
 * @property {number} at Epoch ms.
 * @property {LayerEventType} type
 * @property {string} layerId
 * @property {*} payload Convention: snapshot → full state; add/remove →
 *   {ids, count?}; update → {meta}; clear → {}.
 * @property {number} seq Store-assigned sequence number (monotonic).
 * @property {boolean} [synthetic] True for store-materialized snapshots.
 */

const LAYER_EVENT_TYPES = new Set(['snapshot', 'add', 'update', 'remove', 'clear']);

/**
 * Build one layer-event envelope (validated, defensive defaults). This is the
 * shape layers publish onto the bus; the store recorder accepts exactly it.
 * @param {LayerEventType} type
 * @param {string} layerId
 * @param {*} payload
 * @param {number} [at]
 * @returns {LayerEvent}
 */
export function createLayerEvent(type, layerId, payload, at) {
  const now = Date.now();
  return {
    at: Number.isFinite(at) ? at : now,
    type: LAYER_EVENT_TYPES.has(type) ? type : 'update',
    layerId: String(layerId ?? 'unknown'),
    payload: payload ?? {},
    seq: 0, // assigned by the store
  };
}

/** Deep-ish clone: enough for JSON-safe layer state payloads. */
function clonePayload(payload) {
  if (payload == null || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map(clonePayload);
  const out = {};
  for (const key of Object.keys(payload)) out[key] = clonePayload(payload[key]);
  return out;
}

/** Deep-ish clone: enough for JSON-safe layer state payloads. */
function cloneState(state) {
  if (!state || typeof state !== 'object') return { count: 0, ids: [], meta: {} };
  const ids = Array.isArray(state.ids) ? state.ids.slice(0, IDS_CAP) : [];
  return {
    count: Number.isFinite(state.count) ? state.count : ids.length,
    ids,
    meta: state.meta && typeof state.meta === 'object' ? { ...state.meta } : {},
  };
}

/** Fold one event into a state accumulator (mutates acc, returns it). */
function foldEvent(state, event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  switch (event?.type) {
    case 'snapshot':
      return cloneState(payload);
    case 'add': {
      const incoming = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
      const merged = state.ids.filter((id) => !incoming.includes(id)).concat(incoming).slice(0, IDS_CAP);
      state.ids = merged;
      state.count = Number.isFinite(payload.count) ? payload.count : merged.length;
      break;
    }
    case 'remove': {
      const outgoing = new Set(Array.isArray(payload.ids) ? payload.ids.map(String) : []);
      state.ids = state.ids.filter((id) => !outgoing.has(id));
      state.count = Number.isFinite(payload.count) ? payload.count : state.ids.length;
      break;
    }
    case 'update':
      state.meta = { ...state.meta, ...(payload.meta && typeof payload.meta === 'object' ? payload.meta : {}) };
      if (Number.isFinite(payload.count)) state.count = payload.count;
      break;
    case 'clear':
      state.ids = [];
      state.count = 0;
      state.meta = {};
      break;
    default:
      break;
  }
  return state;
}

/**
 * @typedef {object} EventStoreOptions
 * @property {number} [capacity] Ring size.
 * @property {number} [snapshotEvery] Synthetic snapshot cadence.
 * @property {() => number} [now] Clock.
 */

/**
 * Build an isolated event store.
 * @param {EventStoreOptions} [options]
 */
export function createEventStore(options = {}) {
  // `== null` guards, NOT `Number(x) ?? default` — Number(undefined) is
  // NaN (not nullish), which would silently unbound the ring.
  const capacity = options.capacity == null
    ? DEFAULT_CAPACITY
    : Math.max(1, Math.floor(Number(options.capacity) || 1));
  const snapshotEvery = options.snapshotEvery == null
    ? DEFAULT_SNAPSHOT_EVERY
    : Math.max(1, Math.floor(Number(options.snapshotEvery) || 1));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /** @type {LayerEvent[]} */
  const events = [];
  let seq = 0;
  /** @type {Map<string, number>} Deltas since last synthetic snapshot, per layer. */
  const deltasSinceSnapshot = new Map();

  function record(event) {
    if (!event || typeof event !== 'object' || !LAYER_EVENT_TYPES.has(event.type)) return null;
    const entry = {
      at: Number.isFinite(event.at) ? event.at : now(),
      type: event.type,
      layerId: String(event.layerId ?? 'unknown'),
      payload: event.payload ?? {},
      seq: (seq += 1),
      synthetic: false,
    };
    events.push(entry);
    if (events.length > capacity) events.splice(0, events.length - capacity);

    // Compaction: materialize a synthetic snapshot for this layer once its
    // delta backlog exceeds the cadence, so stateAt() stays O(snapshotEvery).
    if (entry.type !== 'snapshot') {
      const backlog = (deltasSinceSnapshot.get(entry.layerId) ?? 0) + 1;
      deltasSinceSnapshot.set(entry.layerId, backlog);
      if (backlog >= snapshotEvery) {
        // Materialize as of the RECORDED event time, not the store clock —
        // an injected test clock can lag behind event timestamps.
        const folded = stateAt(entry.at, { layerId: entry.layerId, includeSynthetic: true });
        deltasSinceSnapshot.set(entry.layerId, 0);
        events.push({
          at: entry.at,
          type: 'snapshot',
          layerId: entry.layerId,
          payload: folded.state,
          seq: (seq += 1),
          synthetic: true,
        });
        if (events.length > capacity) events.splice(0, events.length - capacity);
      }
    } else {
      deltasSinceSnapshot.set(entry.layerId, 0);
    }
    return entry;
  }

  /**
   * Filtered read of the log. Pure — returns plain copies, never the ring.
   * @param {{since?: number, until?: number, layerId?: string, type?: LayerEventType,
   *   includeSynthetic?: boolean, limit?: number}} [filter]
   * @returns {LayerEvent[]}
   */
  function query(filter = {}) {
    const includeSynthetic = filter.includeSynthetic === true;
    const limit = Number.isFinite(filter.limit) ? Math.max(0, Math.floor(filter.limit)) : Infinity;
    const out = [];
    for (const event of events) {
      if (!includeSynthetic && event.synthetic) continue;
      if (Number.isFinite(filter.since) && event.at < filter.since) continue;
      if (Number.isFinite(filter.until) && event.at > filter.until) continue;
      if (filter.layerId !== undefined && event.layerId !== filter.layerId) continue;
      if (filter.type !== undefined && event.type !== filter.type) continue;
      // Payload is cloned so callers cannot reach into the ring.
      out.push({ ...event, payload: clonePayload(event.payload) });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Reconstruct a layer's state as of time `t` (folds the newest snapshot at
   * or before `t`, then every subsequent delta ≤ t). Returns a zeroed state
   * when the layer is unknown or outside the retention horizon.
   * @param {number} t Epoch ms.
   * @param {{layerId?: string, includeSynthetic?: boolean}} [options]
   * @returns {{layerId: string|null, at: number, state: {count: number, ids: string[], meta: object}}}
   */
  function stateAt(t, options = {}) {
    const layerId = options.layerId;
    const includeSynthetic = options.includeSynthetic !== false;
    const since = [];
    let snapshotIndex = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.at > t) continue;
      if (layerId !== undefined && event.layerId !== layerId) continue;
      if (event.type === 'snapshot' && (includeSynthetic || !event.synthetic)) {
        snapshotIndex = i;
        break;
      }
      // Delta at-or-before t: candidate for post-snapshot folding.
      if (event.type !== 'snapshot') since.unshift(event);
    }
    if (snapshotIndex === -1) {
      // No snapshot in horizon: fold every retained delta for the layer.
      let state = { count: 0, ids: [], meta: {} };
      const ordered = layerId === undefined
        ? []
        : events.filter((e) => e.layerId === layerId && e.at <= t && e.type !== 'snapshot');
      for (const event of ordered) state = foldEvent(state, event);
      return { layerId: layerId ?? null, at: t, state: cloneState(state) };
    }
    const snapshot = events[snapshotIndex];
    let state = cloneState(snapshot.payload);
    for (const event of since) {
      if (event.at > t) continue; // belt-and-braces: fold only ≤ t
      state = foldEvent(state, event);
    }
    return { layerId: snapshot.layerId, at: t, state: cloneState(state) };
  }

  function diagnostics() {
    const perLayer = new Map();
    for (const event of events) {
      const entry = perLayer.get(event.layerId) ?? { events: 0, snapshots: 0, lastAt: 0, lastType: null };
      entry.events += 1;
      if (event.type === 'snapshot') entry.snapshots += 1;
      entry.lastAt = event.at;
      entry.lastType = event.type;
      perLayer.set(event.layerId, entry);
    }
    return Object.freeze({
      capacity,
      length: events.length,
      seq,
      snapshotEvery,
      layers: Object.freeze([...perLayer.entries()].map(([layerId, entry]) => Object.freeze({
        layerId,
        ...entry,
      }))),
    });
  }

  /** Test seam. */
  function reset() {
    events.length = 0;
    seq = 0;
    deltasSinceSnapshot.clear();
  }

  return Object.freeze({ record, query, stateAt, diagnostics, reset });
}

/**
 * The application timeline singleton. Layers publish `layer:*` events onto
 * the bus; the recorder below feeds this store; the debug facade exposes it.
 */
export const layerEventStore = createEventStore();

/**
 * Subscribe `store` to layer events on `bus`. Pure plumbing — always attaches
 * a fresh recorder and returns its detach. The recorder validates envelope
 * shape defensively: bus noise that is not a layer event is ignored, never
 * thrown, so a malformed publisher cannot corrupt the timeline.
 * @param {{subscribe: Function, publish?: Function}} bus
 * @param {{record: Function}} store
 * @returns {() => void} Detach.
 */
export function attachBusRecorder(bus, store) {
  if (!bus || typeof bus.subscribe !== 'function' || !store || typeof store.record !== 'function') {
    return () => {};
  }
  return bus.subscribe('layer:*', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (LAYER_EVENT_TYPES.has(payload.type)) store.record(payload);
  });
}

/** Singleton bus-recorder installation guard. */
let _busRecorderInstalled = false;

/**
 * Install the ONE production recorder (gevEventBus → layerEventStore).
 * Idempotent at module level: any layer's init may call it, the first call
 * wins, and later calls are no-ops — so multiple lazy layers booting in any
 * order cannot double-record the same event into the timeline.
 * @returns {() => void} Detach (test seam; production never detaches).
 */
export function ensureBusRecorderInstalled() {
  if (_busRecorderInstalled) return () => {};
  // Static singleton wiring: eventBus never imports this module, so the
  // dependency stays acyclic (depcruise no-cycles rule).
  const detach = attachBusRecorder(gevEventBus, layerEventStore);
  _busRecorderInstalled = true;
  return () => {
    detach();
    _busRecorderInstalled = false;
  };
}
