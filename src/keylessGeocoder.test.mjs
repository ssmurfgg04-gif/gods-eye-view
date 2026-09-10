import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  forwardGeocodeKeyless,
  photonExtentToBounds,
  photonTypes,
  nameLeadsWith,
  geocodeMissIsDefinitive,
  _resetKeylessGeocoderForTest,
} from './keylessGeocoder.js';

beforeEach(() => {
  _resetKeylessGeocoderForTest();
});

function photonFeature(overrides = {}) {
  return {
    geometry: { coordinates: [-97.7431, 30.2672], type: 'Point' },
    properties: {
      osm_id: 1,
      osm_type: 'N',
      osm_key: 'place',
      osm_value: 'city',
      name: 'Austin',
      city: 'Austin',
      state: 'Texas',
      country: 'United States',
      type: 'locality',
      extent: [-97.95, 30.5, -97.55, 30.1],
      ...overrides,
    },
  };
}

function stubFetch(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  return { fetchFn, calls };
}

function okResponse(features) {
  return { ok: true, json: async () => ({ features, type: 'FeatureCollection' }) };
}

test('extent converts [west, north, east, south] to southwest/northeast bounds', () => {
  assert.deepEqual(photonExtentToBounds([-97.95, 30.5, -97.55, 30.1]), {
    southwest: { lat: 30.1, lng: -97.95 },
    northeast: { lat: 30.5, lng: -97.55 },
  });
  assert.equal(photonExtentToBounds([-97.95, 30.1, -97.55, 30.5]), null, 'w,s,e,n order is rejected');
  assert.equal(photonExtentToBounds(null), null);
});

test('a lake reported as water=lake frames as an area, never a precise point', () => {
  const types = photonTypes({ osm_key: 'water', osm_value: 'lake', type: 'other' });
  assert.ok(types.includes('natural_feature'), `lake must map to an area type, got ${types}`);
  assert.ok(!types.includes('premise'));
});

test('a square reported as type locality does not frame as a city', () => {
  const types = photonTypes({ osm_key: 'place', osm_value: 'square', type: 'locality' });
  assert.ok(!types.includes('locality'), `square must not map to locality, got ${types}`);
  assert.ok(types.includes('point_of_interest'));
});

test('administrative and street mappings follow Google conventions', () => {
  assert.deepEqual(photonTypes({ osm_value: 'country' })[0], 'country');
  assert.deepEqual(photonTypes({ osm_value: 'city', type: 'locality' })[0], 'locality');
  assert.deepEqual(photonTypes({ type: 'street' })[0], 'route');
  assert.deepEqual(photonTypes({ type: 'house' })[0], 'premise');
});

test('name matching leads rather than contains, unaccented', () => {
  assert.equal(nameLeadsWith('Huế, Vietnam', 'Hue'), true);
  assert.equal(nameLeadsWith('Nguyen Hue Road', 'Hue'), false);
  assert.equal(nameLeadsWith('Hutto, Texas', 'Hue'), false);
});

test('a biased answer wins only when it leads with the name; otherwise unbiased re-runs', async () => {
  const hutto = photonFeature({ name: 'Hutto', city: 'Hutto', extent: null });
  const hue = {
    geometry: { coordinates: [107.585, 16.4637], type: 'Point' },
    properties: {
      osm_key: 'place', osm_value: 'city', name: 'Huế', city: 'Huế',
      state: 'Thừa Thiên-Huế', country: 'Vietnam', type: 'locality', extent: null,
    },
  };
  const { fetchFn, calls } = stubFetch((url) => {
    if (url.includes('lat=')) return okResponse([hutto]);
    return okResponse([hue]);
  });
  const place = await forwardGeocodeKeyless('Hue', {
    near: { lat: 30.2672, lon: -97.7431 },
    fetchFn,
  });
  assert.equal(place.primaryName, 'Huế', 'distance-led Hutto must lose to the name-led match');
  assert.equal(calls.length, 2, 'biased pass plus one unbiased re-run');
  assert.ok(!calls[1].includes('lat='), 'the re-run is unbiased');
});

test('nearby searches take the biased answer in a single request', async () => {
  const sixth = photonFeature({ name: 'Sixth Street', osm_key: 'highway', osm_value: 'primary', type: 'street' });
  const { fetchFn, calls } = stubFetch(() => okResponse([sixth]));
  const place = await forwardGeocodeKeyless('Sixth Street', {
    near: { lat: 30.2672, lon: -97.7431 },
    fetchFn,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(place.types[0], 'route');
});

test('an outage is not a verdict: unanswered queries are never memoised', async () => {
  const { fetchFn, calls } = stubFetch(() => { throw new TypeError('offline'); });
  assert.equal(await forwardGeocodeKeyless('Austin', { fetchFn }), null);
  assert.equal(await forwardGeocodeKeyless('Austin', { fetchFn }), null);
  assert.equal(calls.length, 2, 'each attempt retries; nothing is remembered');
  assert.equal(geocodeMissIsDefinitive([true, false]), false);
  assert.equal(geocodeMissIsDefinitive([true, true]), true);
  assert.equal(geocodeMissIsDefinitive([]), false);
});

test('answered misses are memoised by query and bias', async () => {
  const { fetchFn, calls } = stubFetch(() => okResponse([]));
  assert.equal(await forwardGeocodeKeyless('asdfghjkl', { fetchFn }), null);
  assert.equal(await forwardGeocodeKeyless('asdfghjkl', { fetchFn }), null);
  assert.equal(calls.length, 1, 'one answered miss, then memo');
});

test('the adapter never throws and normalises the shared place shape', async () => {
  const place = await forwardGeocodeKeyless('Austin', {
    fetchFn: async () => okResponse([photonFeature()]),
  });
  assert.equal(place.lat, 30.2672);
  assert.equal(place.lon, -97.7431);
  assert.equal(place.source, 'photon');
  assert.equal(place.primaryName, 'Austin');
  assert.ok(!('country' in place), 'country is label-only, never a filter field');
  assert.equal(await forwardGeocodeKeyless('   '), null, 'empty queries resolve null without fetching');
});

test('all three client geocode call sites ride the keyless fallback', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const locations = fs.readFileSync(path.join(here, 'locations.js'), 'utf8');
  const resolver = fs.readFileSync(path.join(here, 'annotations', 'annotationResolver.js'), 'utf8');
  const voice = fs.readFileSync(path.join(here, 'voice', 'gevActions.js'), 'utf8');
  for (const [file, source] of [['locations.js', locations], ['annotationResolver.js', resolver], ['gevActions.js', voice]]) {
    assert.ok(source.includes('keylessGeocoder'), `${file} must use the keyless fallback`);
  }
  assert.ok(!voice.includes('No Google Maps API key available for Radio location search'),
    'the Radio path must resolve keyless instead of throwing');
});
