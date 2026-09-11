import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OSM_OVERLAYS,
  applyOsmOverlayParams,
  osmOverlaysHiddenReason,
} from './osmOverlays.js';

test('the overlay catalog names free raster tile sources', () => {
  assert.equal(OSM_OVERLAYS.length, 2);
  const keys = OSM_OVERLAYS.map((overlay) => overlay.key);
  assert.deepEqual(keys, ['seamark', 'snowmap']);
  for (const overlay of OSM_OVERLAYS) {
    assert.match(overlay.urlTemplate, /^https:\/\//, 'tiles load over HTTPS');
    assert.ok(overlay.urlTemplate.includes('{z}/{x}/{y}'), 'XYZ tile template');
    assert.ok(overlay.credit.length > 0, 'every overlay carries attribution');
  }
});

test('params accept booleans for known keys and ignore everything else', () => {
  const current = { seamark: true, snowmap: true };
  assert.deepEqual(
    applyOsmOverlayParams(current, { seamark: false }),
    { next: { seamark: false, snowmap: true }, changed: true },
  );
  assert.deepEqual(
    applyOsmOverlayParams(current, { seamark: 'yes' }),
    { next: { ...current }, changed: false },
    'non-boolean values leave state untouched, never coerce',
  );
  assert.deepEqual(
    applyOsmOverlayParams(current, { railway: true }),
    { next: { ...current }, changed: false },
    'unknown keys are ignored',
  );
});

test('hidden reason is honest on every stack state', () => {
  assert.equal(osmOverlaysHiddenReason(false, { seamark: true }, false), null);
  assert.equal(osmOverlaysHiddenReason(true, { seamark: false, snowmap: false }, false), null);
  assert.equal(osmOverlaysHiddenReason(true, { seamark: true }, true), null);
  assert.match(
    osmOverlaysHiddenReason(true, { seamark: true }, false) || '',
    /OSM or Bing/,
    'photoreal-stack invisibility names the remedy, not an error',
  );
});
