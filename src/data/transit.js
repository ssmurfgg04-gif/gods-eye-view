/**
 * @module transit
 * @description Live public transit — buses, trams, metros, trains and ferries
 * from open GTFS-Realtime VehiclePositions feeds, moving on the globe.
 *
 * One point primitive per vehicle, colored by mode. Feeds are polled through
 * the server-side `/api/transit` proxy (registered URLs only, never
 * client-supplied), and only the feeds whose coverage circle contains the
 * camera's look-at point are polled — so a session over Boston costs one MBTA
 * request every 15 s and nothing for Norway.
 *
 * Motion: each poll gives every vehicle a new fix; the point then glides from
 * where it was drawn to the new fix over the next poll interval. That is one
 * interval behind real time (the same trade the flights layer makes) and
 * buys smooth motion with no extrapolation snap-back. Vehicles missing from
 * two consecutive polls are removed.
 *
 * Height: points sit on sampled terrain/mesh height (once per ~0.002° cell,
 * bounded per poll — never per frame) and always render through the mesh so
 * a bus under a 3D building roof still shows.
 */

import * as Cesium from 'cesium';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import { registerSpriteCollection, restoreSpriteOrder } from './spriteOrder.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';
import { registerDynamicCredit, transitFeedCredit } from './dataCredits.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  TRANSIT_FEED_REGISTRY,
  TRANSIT_MODE_ICON,
  transitFeedsInRange,
  transitModeFor,
} from './transitFeeds.js';

export const TRANSIT_SELECTED_OVERLAY_SOURCE_ID = 'transit-selected';
export const TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: true,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});
let _overlayHost = DEFAULT_OVERLAY_HOST;

// --- Polling / activation ---
/** Poll interval (ms). Also the glide duration between two fixes. */
export const TRANSIT_POLL_MS = 15_000;
/** Camera altitude (m) above which the layer idles: a national fleet still reads at 3,000 km. */
const ACTIVATION_ALTITUDE_M = 3_000_000;
const ACTIVATION_ENTER_ALTITUDE_M = ACTIVATION_ALTITUDE_M - 150_000;
const ACTIVATION_EXIT_ALTITUDE_M = ACTIVATION_ALTITUDE_M + 150_000;
/** Debounce (ms) for camera-change proximity checks. */
const CAMERA_DEBOUNCE_MS = 340;
/** Extra coverage radius (km) granted to a feed that is already active, so it does not flap at the edge. */
const RANGE_SLACK_KM = 40;
/** Hard cap on rendered vehicles across all active feeds. */
const MAX_VEHICLES_TOTAL = 15_000;
/** A vehicle absent from this many consecutive polls is removed. */
const MISSED_POLLS_TO_DROP = 2;
/** Feed fixes older than this (s) are ignored — a parked bus reporting yesterday's position. */
const VEHICLE_MAX_AGE_S = 10 * 60;

// --- Height sampling ---
/** Vertical lift (m) above the sampled surface. */
const HEIGHT_LIFT_M = 3;
/** Above this camera altitude (m) a few metres of terrain height are invisible — skip sampling. */
const HEIGHT_SAMPLE_MAX_ALTITUDE_M = 60_000;
/** Sampling budget per poll; the rest render at the ellipsoid until a later poll. */
const HEIGHT_SAMPLES_PER_POLL = 300;
/** Height cache cell size (deg) — about 200 m. */
const HEIGHT_CELL_DEG = 0.002;
const HEIGHT_CACHE_MAX = 20_000;

// --- Rendering ---
const POINT_PIXEL_SIZE = 7;
const SELECTED_PIXEL_SIZE = 13;
const POINT_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(20_000, 1.0, 2_500_000, 0.45);
const OUTLINE_COLOR = Cesium.Color.BLACK.withAlpha(0.4);
const SELECTED_OUTLINE_COLOR = Cesium.Color.CYAN;
/** Mode palette: distinct at a glance, none reused by flights (white/cyan), military (amber), or vessels. */
export const TRANSIT_MODE_COLORS = Object.freeze({
  bus: '#4ade80',
  tram: '#fbbf24',
  subway: '#f87171',
  rail: '#c084fc',
  ferry: '#38bdf8',
  unknown: '#cbd5e1',
});
const MODE_CESIUM_COLORS = Object.fromEntries(
  Object.entries(TRANSIT_MODE_COLORS).map(([mode, css]) => [mode, Cesium.Color.fromCssColorString(css).withAlpha(0.95)]),
);

/** Throttle (ms) for re-anchoring the selected vehicle's card while it glides. */
const SELECTED_CARD_REFRESH_MS = 250;

// --- Module state ---
let _viewer = null;
let _points = null;
let _enabled = false;
let _cameraChangedAttached = false;
let _cameraDebounceTimer = null;
let _altitudeGateOpen = false;
let _generation = 0;
let _preRenderRemove = null;
let _renderHeld = false;
let _clickHandler = null;

/** @type {Map<string, object>} feedId → registry entry currently polled */
let _activeFeeds = new Map();
/** @type {Map<string, {count:number, lastUpdate:number|null, error:string|null, stale:boolean, pollSeq:number, loading:boolean}>} */
let _feedStatus = new Map();
/** @type {Map<string, {controller: AbortController, promise: Promise<void>}>} feedId → request in flight */
let _inFlight = new Map();
/** @type {Map<string, object>} vehicle key → runtime entry */
let _vehicles = new Map();
/** @type {Map<string, number>} height cell → sampled height (m) */
let _heightCache = new Map();
let _selectedKey = null;
let _selectedCardAt = 0;
/** @type {{ refreshLayerStats?: () => void }|null} Manager handle for out-of-tick panel repaints. */
let _dataManager = null;
let _lastUpdate = null;
let _error = null;
let _limitWarned = false;

const _scratchCartesian = new Cesium.Cartesian3();

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Stable key for a vehicle across polls.
 * @param {string} feedId
 * @param {string} vehicleId
 * @returns {string}
 */
export function transitVehicleKey(feedId, vehicleId) {
  return `${feedId}:${vehicleId}`;
}

/**
 * Where a gliding vehicle is drawn at `now`: linear between its last drawn
 * fix and its newest fix over one poll interval, clamped at the ends.
 * @param {{from:{lat:number,lon:number}, to:{lat:number,lon:number}, tStart:number, tEnd:number}} entry
 * @param {number} now ms
 * @returns {{lat:number, lon:number, settled:boolean}}
 */
export function interpolatedVehiclePosition(entry, now) {
  const { from, to, tStart, tEnd } = entry;
  if (!from || tEnd <= tStart || now >= tEnd) return { lat: to.lat, lon: to.lon, settled: true };
  if (now <= tStart) return { lat: from.lat, lon: from.lon, settled: false };
  const t = (now - tStart) / (tEnd - tStart);
  return {
    lat: from.lat + (to.lat - from.lat) * t,
    lon: from.lon + (to.lon - from.lon) * t,
    settled: false,
  };
}

/**
 * Whether a feed fix is too old to draw.
 * @param {object} record Normalized vehicle record (`timestamp` in epoch seconds or null).
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isStaleVehicleFix(record, nowMs) {
  if (!Number.isFinite(record?.timestamp)) return false; // feeds without per-vehicle timestamps are trusted
  return nowMs / 1000 - record.timestamp > VEHICLE_MAX_AGE_S;
}

/**
 * Build the human lines of the selection card from a vehicle record.
 * @param {object} feed Registry entry.
 * @param {object} record Normalized vehicle record.
 * @param {string} mode Resolved transit mode.
 * @param {number} nowMs
 * @returns {{title:string, details:string[]}}
 */
export function buildTransitSelectionCopy(feed, record, mode, nowMs) {
  const icon = TRANSIT_MODE_ICON[mode] || TRANSIT_MODE_ICON.unknown;
  const routeLabel = record.routeId ? `Route ${record.routeId}` : (record.label ? `Vehicle ${record.label}` : `Vehicle ${record.id}`);
  const title = `${icon} ${routeLabel}`;
  const details = [`${feed.name} · ${feed.region}`];
  const motion = [];
  if (Number.isFinite(record.speedMps)) motion.push(`${Math.round(record.speedMps * 3.6)} km/h`);
  if (Number.isFinite(record.bearing)) motion.push(`hdg ${Math.round(record.bearing)}°`);
  if (motion.length) details.push(motion.join(' · '));
  const state = [];
  if (record.status === 'STOPPED_AT' && record.stopId) state.push(`Stopped at stop ${record.stopId}`);
  else if (record.status === 'INCOMING_AT' && record.stopId) state.push(`Arriving at stop ${record.stopId}`);
  else if (record.status === 'IN_TRANSIT_TO' && record.stopId) state.push(`Next stop ${record.stopId}`);
  if (record.occupancy && record.occupancy !== 'NO_DATA_AVAILABLE') state.push(record.occupancy.toLowerCase().replaceAll('_', ' '));
  if (state.length) details.push(state.join(' · '));
  if (record.label && record.routeId) details.push(`Vehicle ${record.label}`);
  if (Number.isFinite(record.timestamp)) {
    const ageS = Math.max(0, Math.round(nowMs / 1000 - record.timestamp));
    details.push(ageS < 90 ? `Reported ${ageS} s ago` : `Reported ${Math.round(ageS / 60)} min ago`);
  }
  return { title, details };
}

/**
 * Shared-host card for the selected vehicle.
 * @param {string} key
 * @param {Cesium.Cartesian3} position
 * @param {{title:string, details:string[]}} copy
 * @param {string} mode
 * @returns {object}
 */
export function createTransitSelectedOverlayEntry(key, position, copy, mode) {
  if (!key || !position) return null;
  return {
    id: String(key),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: copy.title,
    details: copy.details,
    accent: TRANSIT_MODE_COLORS[mode] || TRANSIT_MODE_COLORS.unknown,
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

// ---------------------------------------------------------------------------
// Camera helpers
// ---------------------------------------------------------------------------

function getCameraAltitude(viewer) {
  const carto = viewer?.camera?.positionCartographic;
  return carto && Number.isFinite(carto.height) ? carto.height : Infinity;
}

function getCameraCenterLatLon(viewer) {
  const rect = viewer?.camera?.computeViewRectangle?.(viewer.scene.globe?.ellipsoid);
  if (rect) {
    const center = Cesium.Rectangle.center(rect);
    return { lat: Cesium.Math.toDegrees(center.latitude), lon: Cesium.Math.toDegrees(center.longitude) };
  }
  const carto = viewer?.camera?.positionCartographic;
  if (carto) return { lat: Cesium.Math.toDegrees(carto.latitude), lon: Cesium.Math.toDegrees(carto.longitude) };
  return null;
}

function altitudeGateOpen(altitude) {
  if (_altitudeGateOpen) return altitude <= ACTIVATION_EXIT_ALTITUDE_M;
  return altitude <= ACTIVATION_ENTER_ALTITUDE_M;
}

// ---------------------------------------------------------------------------
// Height
// ---------------------------------------------------------------------------

function heightCellKey(lat, lon) {
  return `${Math.round(lat / HEIGHT_CELL_DEG)}:${Math.round(lon / HEIGHT_CELL_DEG)}`;
}

/**
 * Sampled surface height for a vehicle, from a per-cell cache. `budget` is a
 * mutable counter shared by one poll so sampling stays bounded.
 * @returns {number} metres above the ellipsoid (0 when unsampled)
 */
function surfaceHeightFor(lat, lon, budget) {
  const key = heightCellKey(lat, lon);
  const cached = _heightCache.get(key);
  if (cached !== undefined) return cached;
  if (budget.remaining <= 0) return 0;
  const scene = _viewer?.scene;
  if (!scene?.sampleHeightSupported || getCameraAltitude(_viewer) > HEIGHT_SAMPLE_MAX_ALTITUDE_M) return 0;
  budget.remaining -= 1;
  let height = 0;
  try {
    const sampled = scene.sampleHeight(Cesium.Cartographic.fromDegrees(lon, lat));
    if (Number.isFinite(sampled)) height = sampled;
  } catch { /* tiles not ready — render at the ellipsoid for now */ }
  if (_heightCache.size >= HEIGHT_CACHE_MAX) _heightCache.clear();
  _heightCache.set(key, height);
  return height;
}

function positionFor(lat, lon, heightM, out) {
  return Cesium.Cartesian3.fromDegrees(lon, lat, heightM + HEIGHT_LIFT_M, undefined, out);
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

function feedStatus(feedId) {
  let status = _feedStatus.get(feedId);
  if (!status) {
    status = { count: 0, lastUpdate: null, error: null, stale: false, pollSeq: 0, loading: false };
    _feedStatus.set(feedId, status);
  }
  return status;
}

function removeVehicle(key) {
  const entry = _vehicles.get(key);
  if (!entry) return;
  if (_selectedKey === key) _clearSelection();
  if (_points && entry.point) _points.remove(entry.point);
  _vehicles.delete(key);
}

function removeFeedVehicles(feedId) {
  for (const [key, entry] of _vehicles) {
    if (entry.feedId === feedId) removeVehicle(key);
  }
}

function applySnapshot(feed, snapshot, { stale }) {
  const now = Date.now();
  const status = feedStatus(feed.id);
  status.pollSeq += 1;
  const pollSeq = status.pollSeq;
  const budget = { remaining: HEIGHT_SAMPLES_PER_POLL };
  let seen = 0;

  for (const record of snapshot.vehicles || []) {
    if (isStaleVehicleFix(record, now)) continue;
    const key = transitVehicleKey(feed.id, record.id);
    const mode = transitModeFor(feed, record.routeId);
    let entry = _vehicles.get(key);
    if (entry) {
      const drawn = interpolatedVehiclePosition(entry, now);
      entry.from = { lat: drawn.lat, lon: drawn.lon };
      entry.to = { lat: record.lat, lon: record.lon };
      entry.tStart = now;
      entry.tEnd = now + TRANSIT_POLL_MS;
      if (entry.mode !== mode) {
        entry.mode = mode;
        if (_selectedKey !== key) entry.point.color = MODE_CESIUM_COLORS[mode];
      }
      if (entry.heightM === 0) entry.heightM = surfaceHeightFor(record.lat, record.lon, budget);
    } else {
      if (_vehicles.size >= MAX_VEHICLES_TOTAL) {
        if (!_limitWarned) {
          _limitWarned = true;
          console.warn(`[Data:Transit] vehicle cap ${MAX_VEHICLES_TOTAL} reached — extra vehicles are not rendered`);
        }
        continue;
      }
      const heightM = surfaceHeightFor(record.lat, record.lon, budget);
      const point = _points.add({
        id: key,
        position: positionFor(record.lat, record.lon, heightM),
        color: MODE_CESIUM_COLORS[mode],
        pixelSize: POINT_PIXEL_SIZE,
        outlineColor: OUTLINE_COLOR,
        outlineWidth: 1,
        scaleByDistance: POINT_SCALE_BY_DISTANCE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      entry = {
        key,
        feedId: feed.id,
        point,
        mode,
        heightM,
        from: null,
        to: { lat: record.lat, lon: record.lon },
        tStart: now,
        tEnd: now,
        record,
        pollSeq,
      };
      _vehicles.set(key, entry);
    }
    entry.record = record;
    entry.pollSeq = pollSeq;
    seen += 1;
  }

  // Drop vehicles this feed stopped reporting.
  for (const [key, entry] of _vehicles) {
    if (entry.feedId === feed.id && pollSeq - entry.pollSeq >= MISSED_POLLS_TO_DROP) removeVehicle(key);
  }

  status.count = seen;
  status.lastUpdate = now;
  status.error = null;
  status.stale = stale === true;
  status.loading = false;
  _lastUpdate = now;
  _error = null;
  if (_viewer) registerDynamicCredit(_viewer, transitFeedCredit(feed));
  if (_selectedKey && _vehicles.get(_selectedKey)?.feedId === feed.id) _refreshSelectedCard(true);
  syncRenderHold();
  governorRequestRender('transit-poll');
  _dataManager?.refreshLayerStats?.();
}

/**
 * Poll one feed. A request already in flight is younger than one poll
 * interval, so a second caller (enable() and the manager's first update()
 * both ask within the same tick) awaits that request instead of aborting it —
 * the manager's first update then settles with data on the globe.
 * @param {object} feed Registry entry.
 * @param {number} generation Enable generation the poll belongs to.
 * @returns {Promise<void>}
 */
function pollFeed(feed, generation) {
  if (!_enabled || generation !== _generation) return Promise.resolve();
  const existing = _inFlight.get(feed.id);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const status = feedStatus(feed.id);
  status.loading = status.count === 0;
  const promise = (async () => {
    try {
      const response = await fetch(`/api/transit/vehicles/${encodeURIComponent(feed.id)}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`transit proxy HTTP ${response.status}`);
      const snapshot = await response.json();
      if (!_enabled || generation !== _generation || !_activeFeeds.has(feed.id)) return;
      applySnapshot(feed, snapshot, { stale: response.headers.get('x-gev-cache') === 'STALE-ERROR' });
    } catch (error) {
      if (error?.name === 'AbortError') return;
      if (generation !== _generation) return;
      console.warn(`[Data:Transit] ${feed.id} poll failed:`, error?.message || error);
      status.error = `${feed.name} feed unavailable`;
      status.loading = false;
      _error = status.error;
      _dataManager?.refreshLayerStats?.();
    } finally {
      if (_inFlight.get(feed.id)?.controller === controller) _inFlight.delete(feed.id);
    }
  })();
  _inFlight.set(feed.id, { controller, promise });
  return promise;
}

function abortAllInFlight() {
  for (const { controller } of _inFlight.values()) controller.abort();
  _inFlight.clear();
}

// ---------------------------------------------------------------------------
// Proximity / activation
// ---------------------------------------------------------------------------

function runProximityCheck() {
  if (!_enabled || !_viewer) return;
  const altitude = getCameraAltitude(_viewer);
  _altitudeGateOpen = altitudeGateOpen(altitude);
  const center = _altitudeGateOpen ? getCameraCenterLatLon(_viewer) : null;
  const desired = new Map();
  if (center) {
    for (const feed of transitFeedsInRange(center.lat, center.lon)) desired.set(feed.id, feed);
    // Hysteresis: a feed already active stays active a little past its edge.
    for (const feed of transitFeedsInRange(center.lat, center.lon, RANGE_SLACK_KM)) {
      if (_activeFeeds.has(feed.id)) desired.set(feed.id, feed);
    }
  }
  for (const feedId of _activeFeeds.keys()) {
    if (!desired.has(feedId)) {
      _inFlight.get(feedId)?.controller.abort();
      _inFlight.delete(feedId);
      _activeFeeds.delete(feedId);
      _feedStatus.delete(feedId);
      removeFeedVehicles(feedId);
    }
  }
  for (const [feedId, feed] of desired) {
    if (!_activeFeeds.has(feedId)) {
      _activeFeeds.set(feedId, feed);
      void pollFeed(feed, _generation);
    }
  }
  syncRenderHold();
  governorRequestRender('transit-proximity');
}

function onCameraChanged() {
  clearTimeout(_cameraDebounceTimer);
  _cameraDebounceTimer = setTimeout(() => {
    _cameraDebounceTimer = null;
    runProximityCheck();
  }, CAMERA_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

function syncRenderHold() {
  const shouldHold = _enabled && _vehicles.size > 0;
  if (shouldHold && !_renderHeld) {
    holdContinuousRender('transit');
    _renderHeld = true;
  } else if (!shouldHold && _renderHeld) {
    releaseContinuousRender('transit');
    _renderHeld = false;
  }
}

function onPreRender() {
  if (!_enabled || _vehicles.size === 0) return;
  const now = Date.now();
  for (const entry of _vehicles.values()) {
    if (!entry.from || now >= entry.tEnd) {
      if (entry.from) {
        // Settle exactly on the fix once, then stop touching the primitive.
        entry.point.position = positionFor(entry.to.lat, entry.to.lon, entry.heightM, _scratchCartesian);
        entry.from = null;
      }
      continue;
    }
    const { lat, lon } = interpolatedVehiclePosition(entry, now);
    entry.point.position = positionFor(lat, lon, entry.heightM, _scratchCartesian);
  }
  if (_selectedKey && now - _selectedCardAt >= SELECTED_CARD_REFRESH_MS) _refreshSelectedCard(false);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function _refreshSelectedCard(force) {
  const entry = _selectedKey ? _vehicles.get(_selectedKey) : null;
  if (!entry) return;
  const now = Date.now();
  if (!force && now - _selectedCardAt < SELECTED_CARD_REFRESH_MS) return;
  _selectedCardAt = now;
  const feed = _activeFeeds.get(entry.feedId) || TRANSIT_FEED_REGISTRY.find((f) => f.id === entry.feedId);
  if (!feed) return;
  const copy = buildTransitSelectionCopy(feed, entry.record, entry.mode, now);
  const card = createTransitSelectedOverlayEntry(entry.key, Cesium.Cartesian3.clone(entry.point.position), copy, entry.mode);
  if (card) _overlayHost.setEntries(TRANSIT_SELECTED_OVERLAY_SOURCE_ID, [card], TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS);
}

function _clearSelection() {
  const entry = _selectedKey ? _vehicles.get(_selectedKey) : null;
  if (entry?.point) {
    entry.point.pixelSize = POINT_PIXEL_SIZE;
    entry.point.outlineColor = OUTLINE_COLOR;
    entry.point.outlineWidth = 1;
  }
  _selectedKey = null;
  _overlayHost.clearSource(TRANSIT_SELECTED_OVERLAY_SOURCE_ID);
}

function _selectVehicle(key) {
  _clearSelection();
  const entry = _vehicles.get(key);
  if (!entry?.point) return;
  _selectedKey = key;
  entry.point.pixelSize = SELECTED_PIXEL_SIZE;
  entry.point.outlineColor = SELECTED_OUTLINE_COLOR;
  entry.point.outlineWidth = 2;
  _refreshSelectedCard(true);
  governorRequestRender('transit-select');
}

function _onKeyDown(event) {
  if (event.key === 'Escape' && _selectedKey) _clearSelection();
}

function _installClickHandler(viewer) {
  if (_clickHandler) return;
  _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    if (picked) {
      const primitiveId = picked.primitive?.id;
      if (typeof primitiveId === 'string' && _vehicles.has(primitiveId)) {
        _selectVehicle(primitiveId);
        return;
      }
      if (typeof picked.id === 'string' && _vehicles.has(picked.id)) {
        _selectVehicle(picked.id);
        return;
      }
    }
    if (_selectedKey) _clearSelection();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  document.addEventListener('keydown', _onKeyDown);
}

function _removeClickHandler() {
  if (_clickHandler) {
    _clickHandler.destroy();
    _clickHandler = null;
  }
  document.removeEventListener('keydown', _onKeyDown);
}

// ---------------------------------------------------------------------------
// Layer module
// ---------------------------------------------------------------------------

const transitLayer = {
  id: 'transit',
  name: 'Transit',
  icon: '🚌',
  source: 'GTFS-RT',
  updateInterval: TRANSIT_POLL_MS,

  /**
   * Create the point collection. Called once at bootstrap.
   * @param {Cesium.Viewer} viewer
   */
  init(viewer) {
    _viewer = viewer;
    _points = new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT });
    viewer.scene.primitives.add(_points);
    registerSpriteCollection('transit', _points);
    _points.show = false;
    _enabled = false;
    _activeFeeds = new Map();
    _feedStatus = new Map();
    _inFlight = new Map();
    _vehicles = new Map();
    _heightCache = new Map();
    _selectedKey = null;
    _lastUpdate = null;
    _error = null;
    _limitWarned = false;
    _altitudeGateOpen = false;
    _overlayHost.setVisible(TRANSIT_SELECTED_OVERLAY_SOURCE_ID, false);
    restoreSpriteOrder(viewer);
    console.log(`[Data:Transit] Initialized with ${TRANSIT_FEED_REGISTRY.length} GTFS-RT feeds`);
  },

  /**
   * Show vehicles, watch the camera, and poll every feed in range.
   * @param {Cesium.Viewer} viewer
   */
  enable(viewer) {
    _enabled = true;
    _generation += 1;
    _error = null;
    _points.show = true;
    _overlayHost.setVisible(TRANSIT_SELECTED_OVERLAY_SOURCE_ID, true);
    _installClickHandler(viewer);
    registerPickOwner('transit', (pickedId) => _vehicles.has(pickedId));
    if (!_cameraChangedAttached) {
      viewer.camera.changed.addEventListener(onCameraChanged);
      viewer.camera.percentageChanged = Math.min(viewer.camera.percentageChanged || 1, 0.05);
      _cameraChangedAttached = true;
    }
    if (!_preRenderRemove) _preRenderRemove = viewer.scene.preRender.addEventListener(onPreRender);
    runProximityCheck();
    restoreSpriteOrder(viewer);
  },

  /**
   * Hide everything, stop polling, drop all vehicles.
   * @param {Cesium.Viewer} viewer
   */
  disable(viewer) {
    _enabled = false;
    _generation += 1;
    clearTimeout(_cameraDebounceTimer);
    _cameraDebounceTimer = null;
    _clearSelection();
    _overlayHost.setVisible(TRANSIT_SELECTED_OVERLAY_SOURCE_ID, false);
    _removeClickHandler();
    unregisterPickOwner('transit');
    if (_cameraChangedAttached) {
      viewer.camera.changed.removeEventListener(onCameraChanged);
      _cameraChangedAttached = false;
    }
    if (_preRenderRemove) {
      _preRenderRemove();
      _preRenderRemove = null;
    }
    abortAllInFlight();
    _activeFeeds.clear();
    _feedStatus.clear();
    _vehicles.clear();
    _points?.removeAll();
    _points.show = false;
    _altitudeGateOpen = false;
    syncRenderHold();
  },

  /**
   * Manager tick (every TRANSIT_POLL_MS): re-poll every active feed.
   * @returns {Promise<void>}
   */
  async update() {
    if (!_enabled || _activeFeeds.size === 0) return;
    const generation = _generation;
    await Promise.all([..._activeFeeds.values()].map((feed) => pollFeed(feed, generation)));
  },

  getStats() {
    const active = [..._activeFeeds.values()];
    const statuses = active.map((feed) => feedStatus(feed.id));
    const loading = statuses.some((s) => s.loading);
    const stale = statuses.length > 0 && statuses.every((s) => s.stale);
    const anyError = statuses.find((s) => s.error)?.error || null;
    const count = _vehicles.size;
    if (_enabled && active.length === 0) {
      return {
        count: 0,
        lastUpdate: _lastUpdate,
        error: null,
        source: 'GTFS-RT',
        status: 'zoom-in',
        coverage: _altitudeGateOpen
          ? `No feed here yet · ${TRANSIT_FEED_REGISTRY.length} regions available`
          : `Fly below ${Math.round(ACTIVATION_ALTITUDE_M / 1000).toLocaleString()} km to a covered region`,
      };
    }
    return {
      count,
      lastUpdate: _lastUpdate,
      error: count === 0 ? anyError : null,
      degraded: count > 0 && Boolean(anyError),
      loading: loading && count === 0,
      loadingLabel: loading && count === 0 ? `Loading ${active.map((f) => f.name).join(', ')}` : undefined,
      stale,
      source: 'GTFS-RT',
      coverage: active.map((f) => `${f.name} ${feedStatus(f.id).count}`).join(' · '),
      feeds: active.map((f) => f.id),
    };
  },

  /**
   * Keep a manager handle so proximity polls can repaint the panel row when
   * their data lands between ticks.
   * @param {object} dataManager DataLayerManager instance.
   */
  attachDataManager(dataManager) {
    _dataManager = dataManager;
  },

  /**
   * Tear down the collection entirely.
   * @param {Cesium.Viewer} viewer
   */
  destroy(viewer) {
    if (_enabled) this.disable(viewer);
    if (_points) {
      viewer.scene.primitives.remove(_points);
      _points = null;
    }
    _overlayHost.clearSource(TRANSIT_SELECTED_OVERLAY_SOURCE_ID);
    _heightCache.clear();
    _viewer = null;
  },
};

/** Test seam: swap the shared overlay host. */
export function _setTransitOverlayHostForTest(host) {
  _overlayHost = host || DEFAULT_OVERLAY_HOST;
}

export default transitLayer;