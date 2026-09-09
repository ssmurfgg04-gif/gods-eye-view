/**
 * @module layerAccess
 * @description Live-forwarding lazy accessors for data-layer modules.
 *
 * src/ui.js needs to CALL INTO layers (focus a CCTV camera, read tracked
 * flight info, hand camera ownership back), but statically importing every
 * layer module dragged all 17 implementations into the eager boot graph —
 * defeating lazy registration. These accessors keep the exact call-site
 * shapes (`layer.focusCamera?.(id)`, `typeof layer.subscribe === 'function'`)
 * while forwarding to the CURRENT module implementation, whatever it is:
 *
 * - before the layer loads, every property read resolves to a safe no-op
 *   function (optional-call sites no-op; strict-equality sites see false),
 * - after DataLayerManager swaps the real module in (eager register or lazy
 *   load), property reads forward to it with correct `this` binding,
 * - `subscribe`-style wiring done too early is re-run via the manager's
 *   'module-loaded' change event (see StyleManager.attachDataManager).
 *
 * The registry is written ONLY by the manager (single writer, no cycles:
 * this module imports nothing).
 */

/** @type {Map<string, object>} layerId → live module implementation. */
const _liveModules = new Map();

/** Internal: manager-only registration of a live layer module. */
export function setLiveLayerModule(layerId, module) {
  if (!layerId || !module) return;
  _liveModules.set(layerId, module);
}

/** Internal: manager-only removal (layer destroyed). */
export function deleteLiveLayerModule(layerId) {
  _liveModules.delete(layerId);
}

/** Direct read of the live module (null before load). */
export function getLiveLayerModule(layerId) {
  return _liveModules.get(layerId) || null;
}

const _noop = () => undefined;
// Awaiting a proxy must not look like awaiting a thenable.
const NON_CALLABLE_KEYS = new Set(['then', 'catch', 'finally', Symbol.toPrimitive, Symbol.toStringTag]);

/**
 * Create a stable lazy accessor object for one layer.
 * @param {string} layerId
 * @returns {object} Proxy that forwards to the live module when loaded.
 */
export function createLazyLayerAccessor(layerId) {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string' || NON_CALLABLE_KEYS.has(prop)) return undefined;
      const module = _liveModules.get(layerId);
      if (module) {
        const value = module[prop];
        if (typeof value === 'function') return value.bind(module);
        return value;
      }
      // Unloaded: safe no-op for any property read. Call sites using
      // `layer.fn?.()` or `layer.fn?.() === true` behave exactly like a
      // module that declines the request.
      return _noop;
    },
    has(_target, prop) {
      const module = _liveModules.get(layerId);
      return module ? prop in module : false;
    },
  });
}
