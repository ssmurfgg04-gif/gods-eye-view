/**
 * @module adaptiveQuality
 * @description Dynamic render-quality manager: FPS-driven resolution/MSAA
 * tiers plus a low-end hardware profile.
 *
 * PERFORMANCE.md's stress scenes (Snow 42 FPS, Noir 47, combined operational
 * 39.9, dense detection 34.4) all run the same fixed-cost pipeline: full
 * devicePixelRatio resolution, 4× MSAA, and the full postprocess chain —
 * regardless of whether the machine can actually sustain it. This module
 * makes those costs adaptive:
 *
 * - **FPS sampling** happens on `scene.postRender` timestamps (works under
 *   the idle render governor: idle simply pauses sampling with it).
 * - **Tiers** step `viewer.resolutionScale` 1.0 → 0.85 → 0.75 and MSAA
 *   4/2/1, with hysteresis (consecutive windows, not single dips) and a
 *   cooldown so a style crossfade cannot oscillate the resolution.
 * - **Low-end profile** (URL `?profile=low`, `<6 GB deviceMemory`, ≤4
 *   logical cores, or mobile UA) starts at the reduced tier, cutting the
 *   fixed GPU tax before the first frame instead of after the first stall.
 *   The profile is also readable by label/detection budgets via
 *   `getLowEndProfile()` / `getLabelBudgetScale()`.
 *
 * The module is deliberately conservative: it only touches three Cesium
 * knobs (resolutionScale, msaaSamples, globe.maximumScreenSpaceError) and
 * never fights the user's manual style choices.
 */

/** @constant {number} Rolling FPS window length, ms. */
const FPS_WINDOW_MS = 2000;
/** @constant {number} Consecutive bad windows required before a demotion. */
const DEMOTE_WINDOWS = 3;
/** @constant {number} Consecutive good windows required before a promotion. */
const PROMOTE_WINDOWS = 6;
/** @constant {number} Minimum time between tier switches, ms. */
const TIER_COOLDOWN_MS = 5000;
/** @constant {number} FPS below which a window counts as "bad". */
const FPS_FLOOR = 34;
/** @constant {number} FPS above which a window counts as "good". */
const FPS_CEILING = 52;
/**
 * @typedef {'high'|'medium'|'low'} QualityTier
 */

/** Tier parameter table. */
const TIERS = Object.freeze({
  high: Object.freeze({ resolutionScale: 1.0, msaaSamples: 4, tileError: 2 }),
  medium: Object.freeze({ resolutionScale: 0.85, msaaSamples: 2, tileError: 2 }),
  low: Object.freeze({ resolutionScale: 0.75, msaaSamples: 1, tileError: 4 }),
});

const TIER_ORDER = Object.freeze(['low', 'medium', 'high']);

/**
 * Detect the low-end profile: explicit opt-in (`?profile=low`), constrained
 * hardware, or a phone-class UA. `?profile=high` forces the full-quality
 * path regardless of heuristics. Every signal is advisory; false negatives
 * just mean adaptive tiering starts at "high" and demotes on evidence.
 * @param {Location} [location]
 * @param {Navigator} [navigatorRef]
 * @returns {boolean}
 */
export function detectLowEndProfile(
  location = (typeof window !== 'undefined' ? window.location : null),
  navigatorRef = (typeof navigator !== 'undefined' ? navigator : null),
) {
  try {
    if (location && /[?&]profile=low\b/.test(location.search || '')) return true;
    if (location && /[?&]profile=high\b/.test(location.search || '')) return false;
  } catch { /* cross-origin access */ }
  if (!navigatorRef) return false;
  const memory = Number(navigatorRef.deviceMemory);
  if (Number.isFinite(memory) && memory > 0 && memory < 6) return true;
  const cores = Number(navigatorRef.hardwareConcurrency);
  if (Number.isFinite(cores) && cores > 0 && cores <= 4) return true;
  const ua = navigatorRef.userAgent || '';
  return /Android|iPhone|Mobile\b/i.test(ua);
}

/** @type {QualityTier} */
let _tier = 'high';
let _installed = false;
let _lowEnd = false;
let _viewer = null;
let _removePostRender = null;
const _state = {
  windowStart: 0,
  frames: 0,
  badWindows: 0,
  goodWindows: 0,
  lastSwitchAt: 0,
};
const _listeners = new Set();

/**
 * Install adaptive quality management on a viewer.
 * @param {Cesium.Viewer} viewer
 * @param {{initialTier?: QualityTier, lowEnd?: boolean}} [options]
 * @returns {{dispose(): void, getTier(): QualityTier, setTier(t: QualityTier): void}}
 */
export function installAdaptiveQuality(viewer, options = {}) {
  if (_installed || !viewer?.scene) return null;
  _installed = true;
  _viewer = viewer;
  _lowEnd = options.lowEnd ?? detectLowEndProfile();
  _tier = options.initialTier ?? (_lowEnd ? 'low' : 'high');
  applyTier(_tier);
  const scene = viewer.scene;
  _removePostRender = scene.postRender.addEventListener(() => {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!_state.windowStart) {
      _state.windowStart = now;
      return;
    }
    _state.frames += 1;
    if (now - _state.windowStart < FPS_WINDOW_MS) return;
    // Close the window and classify it.
    const seconds = (now - _state.windowStart) / 1000;
    const fps = _state.frames / Math.max(seconds, 1e-6);
    _state.windowStart = now;
    _state.frames = 0;
    if (fps <= 0) return;
    if (fps < FPS_FLOOR) {
      _state.badWindows += 1;
      _state.goodWindows = 0;
    } else if (fps > FPS_CEILING) {
      _state.goodWindows += 1;
      _state.badWindows = 0;
    } else {
      // Hysteresis dead-band: neither counts.
      _state.badWindows = 0;
      _state.goodWindows = 0;
    }
    maybeSwitchTier(now);
  });
  return {
    dispose: disposeAdaptiveQuality,
    getTier: () => _tier,
    setTier: (tier) => {
      if (!TIERS[tier]) return;
      _tier = tier;
      applyTier(_tier);
      notifyTierChange('manual');
    },
  };
}

function maybeSwitchTier(now) {
  if (now - _state.lastSwitchAt < TIER_COOLDOWN_MS) return;
  let next = null;
  if (_state.badWindows >= DEMOTE_WINDOWS) {
    next = TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(_tier) - 1)];
    _state.badWindows = 0;
  } else if (_state.goodWindows >= PROMOTE_WINDOWS && _tier !== 'high') {
    next = TIER_ORDER[Math.min(TIER_ORDER.length - 1, TIER_ORDER.indexOf(_tier) + 1)];
    _state.goodWindows = 0;
  }
  if (!next || next === _tier) return;
  _tier = next;
  _state.lastSwitchAt = now;
  applyTier(_tier);
  notifyTierChange('adaptive');
}

function applyTier(tier) {
  const params = TIERS[tier];
  const scene = _viewer?.scene;
  if (!scene) return;
  try {
    scene.msaaSamples = params.msaaSamples;
    _viewer.resolutionScale = params.resolutionScale;
    if (scene.globe) scene.globe.maximumScreenSpaceError = params.tileError;
  } catch (error) {
    // A Cesium build without one of the knobs must not break tiering.
    console.warn('[Quality] tier apply error:', error);
  }
}

function notifyTierChange(reason) {
  for (const listener of _listeners) {
    try {
      listener({ tier: _tier, reason });
    } catch {
      // listener errors never affect rendering
    }
  }
}

/**
 * Subscribe to tier changes.
 * @param {(change: {tier: QualityTier, reason: string}) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onQualityTierChange(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/** Current tier (without installing anything). */
export function getQualityTier() {
  return _tier;
}

/** Whether the low-end profile is active. */
export function getLowEndProfile() {
  return _lowEnd;
}

/** Label/detection budgets scale by tier: fewer labels when GPU is tight. */
export function getLabelBudgetScale() {
  if (_lowEnd) return 0.5;
  if (_tier === 'low') return 0.6;
  if (_tier === 'medium') return 0.85;
  return 1;
}

/** Diagnostics for the debug console. */
export function getAdaptiveQualityDiagnostics() {
  return Object.freeze({
    installed: _installed,
    tier: _tier,
    lowEnd: _lowEnd,
    resolutionScale: TIERS[_tier].resolutionScale,
    msaaSamples: TIERS[_tier].msaaSamples,
  });
}

/** Test seam: reset all module state. */
export function _resetAdaptiveQualityForTest() {
  disposeAdaptiveQuality();
  _tier = 'high';
  _lowEnd = false;
  _state.windowStart = 0;
  _state.frames = 0;
  _state.badWindows = 0;
  _state.goodWindows = 0;
  _state.lastSwitchAt = 0;
  _listeners.clear();
}

function disposeAdaptiveQuality() {
  try { _removePostRender?.(); } catch { /* already removed */ }
  _removePostRender = null;
  _viewer = null;
  _installed = false;
}
