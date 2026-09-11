import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nifcContainmentBucket,
  nifcMarkerSizePx,
  normalizeNifcIncident,
  rankByAcresDesc,
} from './nifcWildfires.js';

test('containment buckets read unset progress as uncontained', () => {
  assert.equal(nifcContainmentBucket(null), 'uncontained');
  assert.equal(nifcContainmentBucket(undefined), 'uncontained');
  assert.equal(nifcContainmentBucket(0), 'uncontained');
  assert.equal(nifcContainmentBucket(24), 'uncontained');
  assert.equal(nifcContainmentBucket(25), 'partial');
  assert.equal(nifcContainmentBucket(74), 'partial');
  assert.equal(nifcContainmentBucket(75), 'contained');
  assert.equal(nifcContainmentBucket(100), 'contained');
});

test('marker sizes separate spot fires from complexes within bounds', () => {
  assert.equal(nifcMarkerSizePx(null), 8);
  assert.equal(nifcMarkerSizePx(0), 8);
  assert.ok(nifcMarkerSizePx(1) >= 8 && nifcMarkerSizePx(1) < 9, 'spot fires sit near the floor');
  const large = nifcMarkerSizePx(50000);
  assert.ok(large > nifcMarkerSizePx(100), 'complexes render larger than spot fires');
  assert.ok(large <= 28, 'sizes stay clamped');
});

test('incident normalization drops coordinate-less rows, keeps the rest', () => {
  assert.equal(normalizeNifcIncident(null), null);
  assert.equal(normalizeNifcIncident({ properties: {}, geometry: null }), null);
  const record = normalizeNifcIncident({
    properties: {
      IrwinID: 'abc-123',
      IncidentName: 'Test Fire',
      IncidentTypeCategory: 'WF',
      IncidentSize: '1500',
      PercentContained: '10',
      POOState: 'California',
    },
    geometry: { coordinates: [-120.5, 39.2] },
  });
  assert.equal(record.id, 'abc-123');
  assert.equal(record.name, 'Test Fire');
  assert.equal(record.acres, 1500);
  assert.equal(record.latitude, 39.2);
  assert.equal(record.longitude, -120.5);
  const nameless = normalizeNifcIncident({
    properties: {},
    geometry: { coordinates: [0, 0] },
  });
  assert.equal(nameless.name, 'Unnamed incident');
  assert.ok(nameless.id.startsWith('nifc:'), 'coordinate-derived fallback id');
});

test('ranking puts the biggest fires first and unknown acreage last', () => {
  const ranked = rankByAcresDesc([
    { acres: 100 },
    { acres: null },
    { acres: 50000 },
    { acres: 5 },
  ]);
  assert.deepEqual(ranked.map((r) => r.acres), [50000, 100, 5, null]);
});
