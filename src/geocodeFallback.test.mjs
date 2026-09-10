import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  forwardGeocodeFallback,
  normalizeNominatimRow,
  _resetGeocodeFallbackForTest,
  MIN_REQUEST_GAP_MS,
} from './geocodeFallback.js';

beforeEach(() => {
  _resetGeocodeFallbackForTest();
});

function stubFetch(rows, { ok = true, calls = null } = {}) {
  return async () => {
    if (calls) calls.count += 1;
    return { ok, json: async () => rows };
  };
}

test('normalizeNominatimRow maps lat/lon strings to the shared place shape', () => {
  const place = normalizeNominatimRow({
    lat: '30.2672',
    lon: '-97.7431',
    display_name: 'Austin, Travis County, Texas, United States',
  });
  assert.equal(place.lat, 30.2672);
  assert.equal(place.lon, -97.7431);
  assert.equal(place.source, 'nominatim');
  assert.deepEqual(place.types, []);
  assert.equal(place.viewport, null);
  assert.ok(place.label.includes('Austin'));
});

test('normalizeNominatimRow rejects out-of-range and missing coordinates', () => {
  assert.equal(normalizeNominatimRow({ lat: '91', lon: '0' }), null);
  assert.equal(normalizeNominatimRow({ lat: 'abc', lon: '0' }), null);
  assert.equal(normalizeNominatimRow(null), null);
});

test('forwardGeocodeFallback returns null for empty queries without fetching', async () => {
  const calls = { count: 0 };
  assert.equal(await forwardGeocodeFallback('   ', { fetchFn: stubFetch([], { calls }) }), null);
  assert.equal(calls.count, 0);
});

test('forwardGeocodeFallback returns null on empty results and HTTP failure', async () => {
  assert.equal(await forwardGeocodeFallback('nowhere-xyz', { fetchFn: stubFetch([]) }), null);
  _resetGeocodeFallbackForTest();
  assert.equal(
    await forwardGeocodeFallback('austin', { fetchFn: stubFetch([], { ok: false }) }),
    null,
  );
});

test('forwardGeocodeFallback caches hits and dedupes concurrent callers', async () => {
  const calls = { count: 0 };
  const rows = [{ lat: '30.2672', lon: '-97.7431', display_name: 'Austin, Texas, US' }];
  const fetchFn = stubFetch(rows, { calls });
  const [first, second] = await Promise.all([
    forwardGeocodeFallback('Austin', { fetchFn }),
    forwardGeocodeFallback('austin', { fetchFn }),
  ]);
  assert.equal(first.lat, 30.2672);
  assert.deepEqual(second, first);
  assert.equal(calls.count, 1, 'concurrent same-query callers share one request');
  const third = await forwardGeocodeFallback('AUSTIN  ', { fetchFn });
  assert.deepEqual(third, first);
  assert.equal(calls.count, 1, 'cache answers repeat queries with zero network');
});

test('forwardGeocodeFallback honors the 1 req/s usage policy gap', async () => {
  assert.ok(Number.isFinite(MIN_REQUEST_GAP_MS) && MIN_REQUEST_GAP_MS >= 1000);
  let nowMs = 10_000;
  const now = () => nowMs;
  const realSetTimeout = globalThis.setTimeout;
  const requestedWaits = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    requestedWaits.push(ms);
    return realSetTimeout(fn, 0, ...rest);
  };
  try {
    const rows = [{ lat: '1', lon: '2', display_name: 'A' }];
    await forwardGeocodeFallback('first place', { fetchFn: stubFetch(rows), now });
    // 100 ms later a DIFFERENT query must wait out (gap - elapsed) ≈ 1000 ms.
    nowMs += 100;
    await forwardGeocodeFallback('second place', { fetchFn: stubFetch(rows), now });
    assert.equal(requestedWaits.length, 1);
    assert.ok(
      requestedWaits[0] >= MIN_REQUEST_GAP_MS - 100,
      `expected ~${MIN_REQUEST_GAP_MS - 100}ms policy wait, got ${requestedWaits[0]}`,
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
