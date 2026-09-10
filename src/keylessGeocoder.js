/**
 * @module keylessGeocoder
 * @description Keyless forward-geocode fallback via Photon (komoot, over
 * OpenStreetMap) — the free path when Google cannot answer.
 *
 * Forward search is Google-only without this module: `searchAndFlyTo` threw,
 * the annotation resolver returned null (silent unanchored annotation), and
 * the Radio layer threw (surfaced as a failed voice turn). This adapter is
 * reached when there is no Google key AND when a key exists but Google
 * declines — an unenabled Geocoding API answers HTTP 200 with
 * `REQUEST_DENIED`, so the empty result (not an exception) is the detector.
 *
 * The adapter normalises into the shape the Google path already produces
 * (`lat`/`lon`, label, Google-style `types`, `{southwest, northeast}`
 * bounds, canonical `primaryName`), so `geocodeNavigationMode`,
 * `regionFramingPlan` and the region-swath cap keep running on unchanged
 * inputs. Three translations are load-bearing (each found against the live
 * service, pinned by tests):
 *
 * 1. Google's `bounds` PREFERS results inside the box; Photon's `bbox`
 *    FILTERS to it. The view centre is therefore sent as Photon's `lat`/`lon`
 *    proximity bias, and a biased answer is accepted only when a candidate
 *    LEADS WITH the searched name (unaccented) — otherwise the query re-runs
 *    unbiased. Bias decides which match wins, never what counts as a match.
 * 2. Photon's `extent` is `[west, north, east, south]`, not `[w,s,e,n]`.
 * 3. A specific OSM `key=value` beats the coarse `type`: a lake reported as
 *    `water=lake` / `type:'other'` must not frame at building range, and a
 *    square reported as `type:'locality'` must not frame as a whole city.
 *
 * Deliberately NOT exported: the country (Photon reports it in the feature's
 * own language — `Việt Nam`, `日本` — which would trip closed country
 * matchers downstream; the composed label still names it), and reverse
 * geocoding (the street-label reader needs Google's ranked
 * `address_components`, which Photon `/reverse` cannot reproduce).
 *
 * An outage is not a verdict: answered misses are memoised, unanswered ones
 * (network/timeout/abort) are never cached, so a blip does not poison the
 * session. The adapter never throws — failure, timeout and empty all resolve
 * to null, which every caller already reads as "not found".
 */

export const PHOTON_SEARCH_URL = 'https://photon.komoot.io/api/';

/** Per-request timeout: an opportunistic fallback, never worth a long wait. */
export const KEYLESS_GEOCODE_TIMEOUT_MS = 6000;

/** Answered-miss memo ceiling — bounded, LRU-evicted by insertion order. */
export const KEYLESS_GEOCODE_CACHE_MAX = 60;

/**
 * Attribution record for the fallback path, shaped for `registerDynamicCredit`
 * (`src/data/dataCredits.js`). Registered by call sites that own a viewer.
 */
export const KEYLESS_GEOCODER_CREDIT = Object.freeze({
  key: 'geocode-fallback-photon',
  html:
    'Keyless place search by ' +
    '<a href="https://photon.komoot.io/" target="_blank" rel="noopener">Photon</a> ' +
    '(komoot, data ' +
    '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>, ODbL 1.0)',
});

const _answeredCache = new Map();
const _inFlight = new Map();

/** Test seam: reset memo and in-flight maps. */
export function _resetKeylessGeocoderForTest() {
  _answeredCache.clear();
  _inFlight.clear();
}

/**
 * Whether the adapter holds an answered outcome (hit or definitive miss)
 * for a query — i.e. the last attempt got a verdict, not an outage.
 * Entry points use this with `geocodeMissIsDefinitive` to decide whether a
 * miss may be memoised.
 * @param {string} query
 * @param {{lat:number, lon:number}|null} [near]
 * @returns {boolean}
 */
export function keylessGeocoderAnswered(query, near = null) {
  return _answeredCache.has(cacheKeyFor(String(query || ''), near));
}

/** Compare names unaccented so `Hue` and `Huế` are one name. */
export function normalizePlaceName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** A candidate leads with the query (not merely contains it). */
export function nameLeadsWith(candidateName, query) {
  const name = normalizePlaceName(candidateName);
  const q = normalizePlaceName(query);
  return Boolean(name && q) && name.startsWith(q);
}

/**
 * Map Photon properties to Google-style geocode `types`.
 * A specific OSM key=value beats the coarse Photon `type`.
 * @param {object} props - Photon feature `properties`.
 * @returns {Array<string>} Google-style type tokens (possibly empty).
 */
export function photonTypes(props = {}) {
  const key = String(props.osm_key || '').toLowerCase();
  const value = String(props.osm_value || '').toLowerCase();
  const type = String(props.type || '').toLowerCase();

  // Water bodies must frame as areas, never precise points (a lake mapped
  // only by its coarse type framed at building range, over open water).
  if (key === 'water' || value === 'lake' || value === 'water'
    || (key === 'natural' && (value === 'water' || value === 'bay' || value === 'strait'))
    || key === 'waterway') {
    return ['natural_feature', 'establishment'];
  }
  // Town squares reported as `type:'locality'` must not frame as cities.
  if (value === 'square' || value === 'plaza'
    || (key === 'place' && (value === 'square' || value === 'plaza'))) {
    return ['point_of_interest', 'establishment'];
  }
  if (value === 'university' || key === 'amenity' && value === 'university') {
    return ['university', 'point_of_interest', 'establishment'];
  }
  if (key === 'aeroway' || value === 'aerodrome' || value === 'airport') {
    return ['airport', 'point_of_interest', 'establishment'];
  }
  if (value === 'park' || key === 'leisure' || value === 'national_park') {
    return ['park', 'tourist_attraction', 'point_of_interest', 'establishment'];
  }
  if (key === 'tourism' || value === 'attraction' || value === 'museum' || value === 'monument') {
    return ['tourist_attraction', 'point_of_interest', 'establishment'];
  }
  if (key === 'amenity' || key === 'shop' || key === 'office') {
    return ['point_of_interest', 'establishment'];
  }
  if (value === 'country' || (key === 'place' && value === 'country')) {
    return ['country', 'political'];
  }
  if (value === 'state' || value === 'province' || value === 'region') {
    return ['administrative_area_level_1', 'political'];
  }
  if (value === 'county' || value === 'district') {
    return ['administrative_area_level_2', 'political'];
  }
  if (['city', 'town', 'village', 'hamlet', 'municipality'].includes(value)
    || (key === 'place' && ['city', 'town', 'village'].includes(value))) {
    return ['locality', 'political'];
  }
  if (['suburb', 'neighbourhood', 'neighborhood', 'quarter', 'borough'].includes(value)) {
    return ['neighborhood', 'political'];
  }
  if (value === 'postcode' || key === 'postal_code') {
    return ['postal_code'];
  }
  if (type === 'street' || key === 'highway') {
    return ['route'];
  }
  if (type === 'house') {
    return ['premise'];
  }
  if (type === 'locality') {
    return ['locality', 'political'];
  }
  return ['point_of_interest', 'establishment'];
}

/**
 * Convert Photon's `extent` ([west, north, east, south]) to the geocode
 * `{southwest, northeast}` bounds shape. Returns null when absent/invalid —
 * callers then fly to the point, never a nonsense box.
 * @param {Array<number>|null} extent
 * @returns {{southwest:{lat:number,lng:number},northeast:{lat:number,lng:number}}|null}
 */
export function photonExtentToBounds(extent) {
  if (!Array.isArray(extent) || extent.length < 4) return null;
  const [west, north, east, south] = extent.map(Number);
  if (![west, north, east, south].every(Number.isFinite)) return null;
  if (south > north || west > east) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  return {
    southwest: { lat: south, lng: west },
    northeast: { lat: north, lng: east },
  };
}

/**
 * Compose a short label from Photon properties (city + region + country).
 * The country stays in the label even though it is not re-exported as a field.
 */
export function photonLabel(props = {}) {
  const parts = [
    props.name,
    props.city || props.town || props.village,
    props.state || props.county,
    props.country,
  ].map((part) => String(part || '').trim()).filter(Boolean);
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  return unique.slice(0, 3).join(', ') || String(props.name || '').slice(0, 120) || 'Unnamed place';
}

/**
 * Normalise one Photon feature into the shared place shape.
 * @param {object} feature - Raw Photon GeoJSON feature.
 * @returns {null|{lat:number, lon:number, label:string, types:Array, viewport:object|null, primaryName:string|null, source:string}}
 */
export function normalizePhotonFeature(feature) {
  const coords = feature?.geometry?.coordinates;
  const lon = Number(coords?.[0]);
  const lat = Number(coords?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const props = feature?.properties || {};
  return {
    lat,
    lon,
    label: photonLabel(props),
    types: photonTypes(props),
    viewport: photonExtentToBounds(props.extent),
    // Canonical feature name for OSM footprint scoring (beats matching on
    // the user's raw words, where incidental locality tokens can win).
    primaryName: String(props.name || '').trim() || null,
    source: 'photon',
  };
}

function cacheKeyFor(query, near) {
  const q = normalizePlaceName(query);
  const bias = near && Number.isFinite(near.lat) && Number.isFinite(near.lon)
    ? `|${near.lat.toFixed(2)},${near.lon.toFixed(2)}`
    : '';
  return `${q}${bias}`;
}

function cacheWriteAnswered(key, place) {
  _answeredCache.set(key, place);
  if (_answeredCache.size > KEYLESS_GEOCODE_CACHE_MAX) {
    const oldest = _answeredCache.keys().next();
    if (!oldest.done) _answeredCache.delete(oldest.value);
  }
}

async function photonQuery(params, { fetchFn, signal, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const url = `${PHOTON_SEARCH_URL}?${new URLSearchParams(params)}`;
    const response = await fetchFn(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response?.ok) return null; // answered with refusal — a verdict, not data
    const body = await response.json();
    const features = Array.isArray(body?.features) ? body.features : [];
    return features;
  } catch {
    return undefined; // unanswered (network/timeout/abort) — NOT a verdict
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Whether a not-found may be memoised: only when every source consulted
 * actually answered. An unanswered source is a blip, not "no such place".
 * @param {Array<boolean>} answered - Per-source answered flags.
 * @returns {boolean} True when the miss is definitive.
 */
export function geocodeMissIsDefinitive(answered) {
  if (!Array.isArray(answered) || answered.length === 0) return false;
  return answered.every(Boolean);
}

/**
 * Keyless forward geocode via Photon.
 *
 * @param {string} query - Place name to resolve.
 * @param {object} [options]
 * @param {{lat:number, lon:number}|null} [options.near] - View-centre
 *   proximity bias. Decides which match wins, never what counts as one.
 * @param {AbortSignal} [options.signal]
 * @param {(url:string, init?:object)=>Promise<Response>} [options.fetchFn]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.limit]
 * @returns {Promise<null|object>} Normalised place, or null (miss OR outage —
 *   callers must apply `geocodeMissIsDefinitive` before memoising a miss).
 */
export async function forwardGeocodeKeyless(query, options = {}) {
  const clean = String(query || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const {
    near = null,
    signal = null,
    fetchFn = fetch,
    timeoutMs = KEYLESS_GEOCODE_TIMEOUT_MS,
    limit = 5,
  } = options;

  const key = cacheKeyFor(clean, near);
  if (_answeredCache.has(key)) return _answeredCache.get(key);
  if (_inFlight.has(key)) return _inFlight.get(key);

  const request = (async () => {
    try {
      if (signal?.aborted) return null;
      const biased = near && Number.isFinite(near.lat) && Number.isFinite(near.lon);
      if (biased) {
        const features = await photonQuery({
          q: clean,
          limit: String(Math.max(1, Math.min(10, Number(limit) || 5))),
          lat: String(near.lat),
          lon: String(near.lon),
        }, { fetchFn, signal, timeoutMs });
        if (features === undefined) return null; // unanswered — no verdict
        const winner = features
          .map(normalizePhotonFeature)
          .find((place) => place && place.primaryName && nameLeadsWith(place.primaryName, clean));
        if (winner) {
          cacheWriteAnswered(key, winner);
          return winner;
        }
        // Biased pass found no name-led match: re-run unbiased rather than
        // accept a distance-led wrong-continent answer.
      }
      const features = await photonQuery({
        q: clean,
        limit: String(Math.max(1, Math.min(10, Number(limit) || 5))),
      }, { fetchFn, signal, timeoutMs });
      if (features === undefined) return null; // unanswered — no verdict
      const head = clean.split(',')[0].trim() || clean;
      const places = features.map(normalizePhotonFeature).filter(Boolean);
      const winner = places.find((place) => place.primaryName && nameLeadsWith(place.primaryName, head))
        || places[0]
        || null;
      // Cache answered outcomes (hit or definitive miss) — never outages.
      cacheWriteAnswered(key, winner);
      return winner;
    } catch {
      return null;
    } finally {
      if (_inFlight.get(key) === request) _inFlight.delete(key);
    }
  })();
  _inFlight.set(key, request);
  return request;
}
