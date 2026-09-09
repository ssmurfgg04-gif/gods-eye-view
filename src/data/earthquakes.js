import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { fetchWithCache } from './feedCache.js';
import { gevEventBus } from '../core/eventBus.js';
import {
  assessProvenance,
  attachProvenance,
  createProvenanceRecord,
  reviseProvenance,
  summarizeProvenance,
} from './provenance.js';
import { createLayerEvent, ensureBusRecorderInstalled } from './eventStore.js';
import { selectWithinRelevanceBudget } from '../core/relevance.js';

/**
 * USGS earthquake discs — last 24 hours, M2.5+.
 *
 * Ellipse axes are STATIC (plain numbers), redefined only when a poll brings
 * new data. They must never become a `CallbackProperty` again: every entity
 * here is a `CLAMP_TO_GROUND` ellipse, and a per-frame axis re-tessellates its
 * ground primitive on EVERY frame. Measured on the shipped 58-event feed
 * (2026-08-20 QA hunt, parked camera over SF at 40 km):
 *
 *   58 discs, callback axes → 32.4 ms/frame, 30 fps
 *   58 discs, static axes   →  1.4 ms/frame, 60 fps
 *
 * The former ±15 % radius "pulse" was DROPPED to buy that back: an
 * imperceptible breathing wobble on a translucent ground disc is not worth
 * rebuilding 58 ground primitives 60 times a second. With no per-frame
 * animator left, the layer also no longer holds the render governor
 * continuous — the manager's `layer-tick` / `layer-visibility` requests
 * already cover every discrete mutation this layer makes.
 *
 * This layer is the reference adopter of the four MILLION-X subsystems:
 * every successful poll stamps feed-level provenance, tracks per-event
 * magnitude revisions in a persistent ledger, publishes a snapshot event on
 * the bus (recorded into the timeline store), and ranks its label cohort by
 * relevance (severity × recency) instead of raw magnitude.
 */

const API_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

export const EARTHQUAKE_OVERLAY_SOURCE_ID = 'earthquakes';
export const EARTHQUAKE_OVERLAY_COHORT_LIMIT = 96;
export const EARTHQUAKE_OVERLAY_COLLISION_CAPACITY = 48;

/**
 * Trust policy for the feed-level provenance verdict: USGS "all day" is a
 * 24 h window, so 26 h of observed age is the honest staleness bound; a
 * serve-stale poll carries 0.5 confidence, direct fetches 0.9.
 */
export const EARTHQUAKE_PROVENANCE_POLICY = Object.freeze({
  maxAgeMs: 26 * 60 * 60 * 1000,
  minConfidence: 0.4,
});

/**
 * Relevance curve for the label cohort: magnitude on its natural range
 * (M2.5 floor — anything below is filtered anyway; M8 ceiling), 6 h recency
 * half-life (the feed's 24 h horizon spans four half-lives: a fresh M4
 * outranks a 12 h-old M6, which is the point of a LIVE console).
 */
const EARTHQUAKE_RELEVANCE_OPTIONS = Object.freeze({
  // Number.isFinite(null) is false — no coercion, so "no signal" never
  // masquerades as "epoch zero" (the Number(null) === 0 trap).
  observedAtOf: (entry) => (Number.isFinite(entry?.observedAt) ? entry.observedAt : null),
  severityOf: (entry) => (Number.isFinite(entry?.magnitude) ? entry.magnitude : null),
  severityRange: Object.freeze([2.5, 8]),
});

/**
 * Revision ledger cap: the 24 h feed carries a few hundred events/day; the
 * ledger remembers identities across polls so magnitude corrections are
 * detected, not silently overwritten. Bounded so a pathological feed cannot
 * grow it forever.
 */
const EVENT_LEDGER_CAP = 2048;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/**
 * Color by depth:
 *  - Shallow (<70km): Red
 *  - Intermediate (70-300km): Orange
 *  - Deep (>300km): Yellow
 */
function depthColor(depthKm) {
  if (depthKm < 70) return Cesium.Color.RED;
  if (depthKm < 300) return Cesium.Color.ORANGE;
  return Cesium.Color.YELLOW;
}

/**
 * Build the source-owned presentation for one ambient magnitude label.
 * Magnitude formatting deliberately remains here instead of moving into the
 * shared renderer.
 * @param {object} input
 * @param {string} input.id Stable USGS or deterministic fallback id.
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the pulse.
 * @param {number} input.magnitude USGS magnitude.
 * @param {string} input.accent Source-owned depth-band color.
 * @param {number} [input.observedAt] USGS event origin time (epoch ms) — the
 *   recency signal for relevance-ranked cohort selection.
 * @returns {object}
 */
export function createEarthquakeOverlayEntry({ id, position, magnitude, accent, observedAt = null }) {
  const mag = Number(magnitude);
  return {
    id: String(id),
    position,
    variant: 'label',
    title: `M${mag.toFixed(1)}`,
    accent,
    priority: Math.round(mag * 1000),
    // Relevance signals (additive; ignored by the overlay renderer):
    // magnitude is the severity domain, observedAt drives recency decay.
    magnitude: mag,
    observedAt: observedAt != null && Number.isFinite(Number(observedAt)) ? Number(observedAt) : null,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Keep the MOST RELEVANT events (severity × recency decay — see
 * src/core/relevance.js), with stable identity as the tie-break. When no
 * entry carries relevance signals (legacy callers, tests), the original
 * magnitude-priority ordering applies verbatim: relevance upgrades this
 * layer, it never ambushes it.
 * @param {Array<object>} entries
 * @param {number} [limit]
 * @param {{now?: () => number}} [options] Clock seam for tests.
 * @returns {Array<object>}
 */
export function selectEarthquakeOverlayCohort(
  entries,
  limit = EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  options = {},
) {
  const cap = Math.max(0, Math.min(
    EARTHQUAKE_OVERLAY_COHORT_LIMIT,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(entries) || cap === 0) return [];
  const relevanceSelection = selectWithinRelevanceBudget(entries, cap, {
    ...EARTHQUAKE_RELEVANCE_OPTIONS,
    now: options.now,
  });
  if (relevanceSelection) return relevanceSelection;
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}

/**
 * Map one earthquake's raw plain values to a JSON-safe analyst record
 * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
 * fields are null, never NaN/undefined. Falls back to an index-based id
 * when the USGS event id is absent.
 * @param {Object|null|undefined} raw - Plain values pulled off the entity:
 *   {id, mag, place, time, depth, lat, lon}.
 * @param {number} [index=0] - Position in the snapshot (fallback id only).
 * @returns {{id: string, magnitude: number|null, depthKm: number|null,
 *   lat: number|null, lon: number|null, timeMs: number|null, place: string|null}}
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  return {
    id: text(raw?.id) || `QUAKE-${String(index).padStart(4, '0')}`,
    magnitude: num(raw?.mag),
    depthKm: num(raw?.depth),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    timeMs: num(raw?.time), // USGS epoch ms
    place: text(raw?.place),
  };
}

export function createEarthquakesLayer({ overlayHost = DEFAULT_OVERLAY_HOST } = {}) {
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
/** True when the served snapshot came from the stale cache (feed outage). */
let _servingStale = false;
  let _enabled = false;
  /**
   * Trust ledger (MILLION-X provenance): usgsId → { mag, record }. Survives
   * across polls — entity rebuilds are visual, the ledger is the memory —
   * so a USGS magnitude correction (M4.2 → M4.5) becomes a first-class
   * revision instead of a silent overwrite.
   * @type {Map<string, {mag: number, record: object}>}
   */
  const _eventLedger = new Map();
  /** Feed-level provenance record for the freshest successful poll. */
  let _feedProvenance = null;
  /** Total magnitude revisions observed this session (diagnostics). */
  let _revisionCount = 0;

  const layer = {
  id: 'earthquakes',
  name: 'Earthquakes (24h)',
  icon: '🌋',
  source: 'USGS',
  updateInterval: 60000,

  init(viewer) {
    _dataSource = new Cesium.CustomDataSource('earthquakes');
    _dataSource.show = false;
    viewer.dataSources.add(_dataSource);
    _count = 0;
    _lastUpdate = null;
    _lastError = null;
    _enabled = false;
    overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
    // Timeline spine (MILLION-X memory): install the singleton bus→store
    // recorder once; every layer:* event this layer publishes from here on
    // is recorded into the replayable timeline.
    ensureBusRecorderInstalled();
    console.log('[Data:Earthquakes] Initialized');
  },

  enable(viewer) {
    _enabled = true;
    // No continuous-render hold: the discs are static geometry now, so the
    // layer has no per-frame animator to keep the render loop alive for.
    if (_dataSource) _dataSource.show = true;
    overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, true);
  },

  disable(viewer) {
    _enabled = false;
    _servingStale = false;
    if (_dataSource) _dataSource.show = false;
    overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
    overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
  },

  async update(viewer) {
    try {
      // Serve-stale feed cache (perf): within TTL the cached snapshot
      // answers directly; on a USGS/network failure the last good snapshot
      // is served marked stale instead of blanking the layer. Provider
      // hiccups become "slightly old data", never "no data".
      const result = await fetchWithCache(API_URL, {
        // TTL below the 60 s poll cadence so every poll revalidates; the
        // cache answers from memory only within this window or on failure.
        ttlMs: 30_000,
        maxStaleMs: 10 * 60_000,
      });
      if (!result.ok && !result.stale) {
        _lastError = `USGS HTTP ${result.status}`;
        console.warn(`[Data:Earthquakes] API returned ${result.status}`);
        return false;
      }
      const geojson = result.json;
      if (!geojson || !Array.isArray(geojson.features)) {
        _lastError = 'Malformed USGS response';
        return false;
      }
      _servingStale = Boolean(result.stale);

      // PR #198 (snapshot validation): validate the ENTIRE snapshot before
      // touching the live entity set. The old code removed all entities and
      // then threw on the first malformed feature (missing geometry,
      // non-finite magnitude, non-array coordinates), leaving the layer
      // permanently blank until the next successful poll. A bad snapshot now
      // keeps the previous render intact.
      const validFeatures = [];
      for (const feature of geojson.features) {
        if (!feature || !feature.geometry) continue;
        const coordinates = feature.geometry.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
        const [lon, lat, depthKm] = coordinates;
        const mag = Number(feature.properties?.mag);
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(mag)) continue;
        if (lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
        validFeatures.push(feature);
      }
      if (!validFeatures.length && geojson.features.length) {
        _lastError = 'USGS snapshot failed validation — keeping prior entities';
        console.warn('[Data:Earthquakes] Snapshot rejected by validation; retained previous entities');
        return false;
      }

      _dataSource.entities.removeAll();
      let count = 0;
      const overlayEntries = [];

      // --- Trust ledger diff (MILLION-X provenance) ------------------------
      // Reconcile this snapshot against the persistent ledger BEFORE the
      // visual rebuild: new events, aged-out events, and magnitude
      // corrections all become explicit facts.
      const nowMs = Date.now();
      const seenIds = new Set();
      const addedIds = [];
      const removedIds = [];
      const revisions = [];
      let newestObservedAt = 0;

      for (const feature of validFeatures) {
        const [lon, lat, depthKm] = feature.geometry.coordinates;
        const properties = feature.properties || {};
        const mag = Number(properties.mag);
        const place = properties.place;
        const time = properties.time;
        // `time != null` first: Number(null) is 0, which would forge an
        // epoch-zero event and pin its relevance to the decay floor.
        const observedAt = time != null && Number.isFinite(Number(time)) ? Number(time) : null;

        if (mag < 2.5) continue; // Skip micro-quakes

        const usgsId = feature.id != null ? String(feature.id) : null;
        if (usgsId != null) {
          seenIds.add(usgsId);
          const prior = _eventLedger.get(usgsId);
          if (!prior) {
            addedIds.push(usgsId);
            _eventLedger.set(usgsId, {
              mag,
              record: createProvenanceRecord({
                source: 'USGS',
                feedId: 'earthquakes',
                subjectId: usgsId,
                fetchedAt: nowMs,
                observedAt: Number.isFinite(observedAt) ? observedAt : nowMs,
                confidence: result.stale ? 0.5 : 0.9,
              }),
            });
          } else if (prior.mag !== mag) {
            // USGS revised the magnitude: mint revision n+1 off the prior
            // record — the correction chain is append-only history.
            const previousMag = prior.mag;
            const corrected = reviseProvenance(prior.record, {
              at: nowMs,
              corrections: [{ field: 'mag', from: previousMag, to: mag }],
            });
            prior.mag = mag;
            prior.record = corrected;
            revisions.push({ id: usgsId, field: 'mag', from: previousMag, to: mag });
            _revisionCount += 1;
          } else if (result.stale) {
            // Serving a stale snapshot for an unchanged event: refresh the
            // fetch timestamp so age reporting stays honest.
            prior.record = createProvenanceRecord({
              source: 'USGS',
              feedId: 'earthquakes',
              subjectId: usgsId,
              fetchedAt: nowMs,
              observedAt: Number.isFinite(observedAt) ? observedAt : nowMs,
              confidence: 0.5,
            });
          }
        }
        if (Number.isFinite(observedAt) && observedAt > newestObservedAt) newestObservedAt = observedAt;

        count++;
        const baseRadius = Math.pow(2, mag) * 1000;
        const color = depthColor(depthKm || 0);
        const isSignificant = mag >= 5.0;
        const fillAlpha = isSignificant ? 0.4 : 0.3;
        const outlineAlpha = isSignificant ? 1.0 : 0.8;

        const position = Cesium.Cartesian3.fromDegrees(lon, lat);
        const stableId = feature.id || `event-${count}`;
        const entity = _dataSource.entities.add({
          id: `earthquake:${stableId}`,
          position,
          ellipse: {
            // Static axes — see the module header. A CallbackProperty here
            // re-tessellates the clamped ground geometry every frame.
            semiMajorAxis: baseRadius,
            semiMinorAxis: baseRadius,
            material: new Cesium.ColorMaterialProperty(
              color.withAlpha(fillAlpha)
            ),
            outline: true,
            outlineColor: color.withAlpha(outlineAlpha),
            outlineWidth: isSignificant ? 3 : 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
          properties: {
            // Analyst seam (additive): the USGS event id (e.g. "us7000abcd").
            usgsId: feature.id ?? null,
            mag,
            place,
            time,
            depth: depthKm,
          },
        });
        // Evidence rides with the entity (WeakMap: no serialization impact).
        if (usgsId != null) {
          attachProvenance(entity, _eventLedger.get(usgsId).record);
        }
        overlayEntries.push(createEarthquakeOverlayEntry({
          id: String(stableId),
          position,
          magnitude: mag,
          accent: color.toCssColorString(),
          observedAt: Number.isFinite(observedAt) ? observedAt : null,
        }));
      }
      for (const ledgerId of _eventLedger.keys()) {
        if (!seenIds.has(ledgerId)) {
          removedIds.push(ledgerId);
          _eventLedger.delete(ledgerId);
        }
      }
      // Bound the ledger against a pathological feed.
      while (_eventLedger.size > EVENT_LEDGER_CAP) {
        const oldestKey = _eventLedger.keys().next().value;
        _eventLedger.delete(oldestKey);
      }

      // Feed-level provenance: one record describing THIS snapshot's origin,
      // confidence, and freshness — the answer to "should I believe what the
      // globe is showing me right now?"
      _feedProvenance = createProvenanceRecord({
        source: 'USGS',
        feedId: 'earthquakes',
        fetchedAt: nowMs,
        observedAt: newestObservedAt > 0 ? newestObservedAt : nowMs,
        confidence: result.stale ? 0.5 : 0.9,
      });

      let cohort = [];
      if (_enabled) {
        cohort = selectEarthquakeOverlayCohort(overlayEntries);
        overlayHost.setEntries(
          EARTHQUAKE_OVERLAY_SOURCE_ID,
          cohort,
          {
            cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
            collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          },
        );
      }

      // --- Timeline publish (MILLION-X memory + latency) ------------------
      // One snapshot event per successful poll: what the world looked like,
      // who appeared/disappeared, what got corrected. The singleton
      // bus→store recorder (installed at init) files it into the replayable
      // timeline; future consumers (HUD, voice briefings) can subscribe to
      // the same channel with zero additional polling.
      gevEventBus.publish(
        'layer:earthquakes:update',
        createLayerEvent('snapshot', 'earthquakes', {
          count,
          ids: cohort.map((entry) => entry.id),
          meta: {
            added: addedIds.length,
            removed: removedIds.length,
            revised: revisions.length,
            revisionTotal: _revisionCount,
            stale: _servingStale,
            lastUpdate: nowMs,
            provenance: summarizeProvenance(_feedProvenance, { now: nowMs }),
          },
        }, nowMs),
      );

      _count = count;
      _lastUpdate = Date.now();
      _lastError = null;
      console.log(`[Data:Earthquakes] Updated: ${_count} events (M2.5+)${revisions.length ? `, ${revisions.length} magnitude revision(s)` : ''}`);
      return true;

    } catch (e) {
      console.warn('[Data:Earthquakes] Fetch error:', e);
      _lastError = 'USGS network error';
      return false;
    }
  },

  destroy(viewer) {
    _enabled = false;
    overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
    overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
    if (_dataSource) {
      viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
    }
    _count = 0;
    _lastUpdate = null;
    _lastError = null;
    _servingStale = false;
    // Trust state dies with the layer instance: a re-created layer starts a
    // fresh revision ledger rather than inheriting stale identity memory.
    _eventLedger.clear();
    _feedProvenance = null;
    _revisionCount = 0;
  },

  /**
   * Snapshot the layer's in-memory earthquake records as plain JSON-safe
   * objects for the analyst query engine. On-demand only (called at most
   * once per spoken query) — zero per-frame cost, no listeners, no caching.
   * Returns [] while the layer is disabled or empty.
   * @param {number} [maxCount=2000] - Maximum records to return (truncation).
   * @returns {Array<Object>} See mapAnalystRecord for the record shape.
   */
  getAnalystRecords(maxCount = 2000) {
    if (!_dataSource || !_dataSource.show) return [];
    const entities = _dataSource.entities.values;
    if (!entities.length) return [];
    const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
    const now = Cesium.JulianDate.now();
    const result = [];
    for (const entity of entities) {
      if (result.length >= limit) break;
      const cartesian = entity.position ? entity.position.getValue(now) : null;
      const carto = cartesian ? Cesium.Cartographic.fromCartesian(cartesian) : null;
      const p = entity.properties;
      result.push(mapAnalystRecord({
        id: p?.usgsId?.getValue(now) ?? null,
        mag: p?.mag?.getValue(now),
        place: p?.place?.getValue(now),
        time: p?.time?.getValue(now),
        depth: p?.depth?.getValue(now),
        lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
        lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
      }, result.length));
    }
    return result;
  },

  getStats() {
    const verdict = _feedProvenance
      ? assessProvenance(_feedProvenance, EARTHQUAKE_PROVENANCE_POLICY)
      : null;
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      error: _lastError,
      // The manager's feed-state chip renders STALE from this flag — a
      // provider outage shows honestly as old data instead of nominal.
      stale: _servingStale,
      // MILLION-X trust/attention surface (additive): revisions observed,
      // a human-readable provenance line, and the policy verdict.
      revisedEvents: _revisionCount,
      provenance: _feedProvenance ? summarizeProvenance(_feedProvenance) : null,
      feedState: verdict ? verdict.verdict : null,
    };
  },
  };
  return layer;
}

const earthquakesLayer = createEarthquakesLayer();

export default earthquakesLayer;
