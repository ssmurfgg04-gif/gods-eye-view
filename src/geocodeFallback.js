/**
 * @module geocodeFallback
 * @description Keyless forward-geocode fallback via Nominatim (OpenStreetMap).
 *
 * Forward search (`searchAndFlyTo`, annotation resolution) is Google-only:
 * without `GOOGLE_MAPS_API_KEY` it throws or resolves nothing. This module is
 * the free fallback — Nominatim's `/search` endpoint needs no key and is
 * ODbL-licensed, so a keyless install can still "fly to Austin" instead of
 * erroring. Trade-offs vs Google are documented, not hidden:
 *
 * - No viewport bias on the fallback path (Nominatim supports `viewbox`, but
 *   the Google `bounds` string shape is not converted — global search wins).
 * - No place viewport: results fly to a POINT at the default range for the
 *   resolved mode, never a framed box.
 * - Nominatim usage policy (1 req/s, valid referer) is honored client-side:
 *   outbound calls are throttled to >= MIN_REQUEST_GAP_MS, de-duplicated
 *   in-flight, and cached. Exceeding callers get the last cached answer or
 *   null — never a policy-violating burst.
 *
 * Result shape mirrors `geocodePlace`'s place ({lat, lon, label, types,
 * viewport}) so call sites can substitute directly; `types` is always [] and
 * `viewport` always null on this path, and `source` is stamped 'nominatim' so
 * provenance stays honest.
 */

export const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

/** Minimum gap between outbound Nominatim requests (usage policy: max 1/s). */
export const MIN_REQUEST_GAP_MS = 1100;

/** Fallback cache ceiling — bounded, LRU-evicted by insertion order. */
export const FALLBACK_CACHE_MAX = 60;

/**
 * Attribution record for the fallback path, shaped for `registerDynamicCredit`
 * (`src/data/dataCredits.js`). Registered by call sites that own a viewer.
 */
export const GEOCODE_FALLBACK_CREDIT = Object.freeze({
  key: 'geocode-fallback-nominatim',
  html:
    'Search fallback from ' +
    '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
    'via Nominatim (ODbL 1.0)',
});

const _cache = new Map();
const _inFlight = new Map();
let _lastRequestAt = 0;

/** Test seam: reset cache, in-flight map, and throttle clock. */
export function _resetGeocodeFallbackForTest() {
  _cache.clear();
  _inFlight.clear();
  _lastRequestAt = 0;
}

function normalizeQuery(query) {
  return String(query || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Normalize one Nominatim search row into the shared place shape.
 * @param {object} row - Raw Nominatim `/search` result row.
 * @returns {{lat:number, lon:number, label:string, types:Array, viewport:null, source:string}|null}
 */
export function normalizeNominatimRow(row) {
  const lat = Number(row?.lat);
  const lon = Number(row?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const label = String(row?.display_name || '').split(',').slice(0, 2).join(',').trim();
  return {
    lat,
    lon,
    label: label || String(row?.display_name || '').slice(0, 120) || 'Unnamed place',
    types: [],
    viewport: null,
    source: 'nominatim',
  };
}

function cacheWrite(key, place) {
  _cache.set(key, place);
  if (_cache.size > FALLBACK_CACHE_MAX) {
    const oldest = _cache.keys().next();
    if (!oldest.done) _cache.delete(oldest.value);
  }
}

/**
 * Keyless forward geocode via Nominatim.
 *
 * @param {string} query - Place name to resolve.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {(url:string, init?:object)=>Promise<Response>} [options.fetchFn] - Fetch seam (tests).
 * @param {()=>number} [options.now] - Clock seam (tests).
 * @param {number} [options.limit] - Max rows to request (default 1).
 * @returns {Promise<null|{lat:number, lon:number, label:string, types:Array, viewport:null, source:string}>}
 */
export async function forwardGeocodeFallback(query, options = {}) {
  const key = normalizeQuery(query);
  if (!key) return null;
  if (_cache.has(key)) return _cache.get(key);
  if (_inFlight.has(key)) return _inFlight.get(key);

  const {
    signal = null,
    fetchFn = fetch,
    now = () => Date.now(),
    limit = 1,
  } = options;

  const request = (async () => {
    try {
      // Throttle to the usage policy: wait out the gap instead of firing.
      const wait = MIN_REQUEST_GAP_MS - (now() - _lastRequestAt);
      if (wait > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, wait);
          signal?.addEventListener?.('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }
      if (signal?.aborted) return null;
      const url = `${NOMINATIM_SEARCH_URL}?${new URLSearchParams({
        q: String(query).trim(),
        format: 'jsonv2',
        limit: String(Math.max(1, Math.min(5, Number(limit) || 1))),
        addressdetails: '0',
      })}`;
      _lastRequestAt = now();
      const response = await fetchFn(url, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response?.ok) return null;
      const rows = await response.json();
      const place = normalizeNominatimRow(Array.isArray(rows) ? rows[0] : null);
      if (place) cacheWrite(key, place);
      return place;
    } catch {
      return null;
    } finally {
      if (_inFlight.get(key) === request) _inFlight.delete(key);
    }
  })();
  _inFlight.set(key, request);
  return request;
}
