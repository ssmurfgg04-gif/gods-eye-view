import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import transitLayer, {
  TRANSIT_MODE_COLORS,
  TRANSIT_POLL_MS,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
  interpolatedVehiclePosition,
  isStaleVehicleFix,
  transitVehicleKey,
} from './transit.js';
import { TRANSIT_MODES, getTransitFeed } from './transitFeeds.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import { SPRITE_LAYER_ORDER } from './spriteOrder.js';

test('layer module declares the manager contract', () => {
  assert.equal(transitLayer.id, 'transit');
  assert.equal(typeof transitLayer.name, 'string');
  assert.equal(typeof transitLayer.icon, 'string');
  assert.equal(transitLayer.updateInterval, TRANSIT_POLL_MS);
  for (const method of ['init', 'enable', 'disable', 'update', 'getStats', 'destroy']) {
    assert.equal(typeof transitLayer[method], 'function', `${method} is implemented`);
  }
});

test('the layer is registered for share links and sprite stacking', () => {
  const entry = LAYER_STATE_REGISTRY.find((row) => row.id === 'transit');
  assert.ok(entry, 'transit has a share-link token');
  assert.equal(entry.disposition, 'enabled-only');
  assert.equal(LAYER_STATE_REGISTRY.filter((row) => row.token === entry.token).length, 1, 'token is unique');
  const index = SPRITE_LAYER_ORDER.indexOf('transit');
  assert.ok(index > SPRITE_LAYER_ORDER.indexOf('bikeshare'), 'vehicles draw above bikeshare stations');
  assert.ok(index < SPRITE_LAYER_ORDER.indexOf('flights'), 'aircraft stay on top');
});

test('every transit mode has a colour and the selected card uses it as accent', () => {
  for (const mode of TRANSIT_MODES) {
    assert.match(TRANSIT_MODE_COLORS[mode], /^#[0-9a-f]{6}$/i, `${mode} has a colour`);
  }
  const position = Cesium.Cartesian3.fromDegrees(-71.06, 42.36, 3);
  const card = createTransitSelectedOverlayEntry('mbta:1', position, { title: 'T', details: ['d'] }, 'subway');
  assert.equal(card.accent, TRANSIT_MODE_COLORS.subway);
  assert.equal(card.selected, true);
  assert.equal(card.protected, true);
  assert.equal(card.position, position);
  assert.equal(createTransitSelectedOverlayEntry('', position, { title: 'T', details: [] }, 'bus'), null);
  assert.equal(createTransitSelectedOverlayEntry('k', null, { title: 'T', details: [] }, 'bus'), null);
  assert.equal(TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS.moving, true, 'the card follows a moving vehicle');
});

test('a vehicle glides linearly from its drawn position to the new fix over one poll', () => {
  const entry = { from: { lat: 0, lon: 0 }, to: { lat: 1, lon: 2 }, tStart: 1000, tEnd: 1000 + TRANSIT_POLL_MS };
  assert.deepEqual(interpolatedVehiclePosition(entry, 500), { lat: 0, lon: 0, settled: false });
  const mid = interpolatedVehiclePosition(entry, 1000 + TRANSIT_POLL_MS / 2);
  assert.ok(Math.abs(mid.lat - 0.5) < 1e-9 && Math.abs(mid.lon - 1) < 1e-9);
  assert.equal(mid.settled, false);
  assert.deepEqual(interpolatedVehiclePosition(entry, 1000 + TRANSIT_POLL_MS), { lat: 1, lon: 2, settled: true });
  // A brand-new vehicle (no `from`) sits exactly on its fix.
  assert.deepEqual(interpolatedVehiclePosition({ from: null, to: { lat: 5, lon: 6 }, tStart: 0, tEnd: 0 }, 10), { lat: 5, lon: 6, settled: true });
});

test('fixes older than ten minutes are stale; feeds without timestamps are trusted', () => {
  const now = 1_700_000_000_000;
  assert.equal(isStaleVehicleFix({ timestamp: now / 1000 - 30 }, now), false);
  assert.equal(isStaleVehicleFix({ timestamp: now / 1000 - 601 }, now), true);
  assert.equal(isStaleVehicleFix({ timestamp: null }, now), false);
  assert.equal(isStaleVehicleFix({}, now), false);
});

test('selection copy reads like a transit card and never leaks nulls', () => {
  const feed = getTransitFeed('metrotransit-msp');
  const now = 1_788_936_960_000;
  const full = buildTransitSelectionCopy(feed, {
    id: '1557', label: '1557', routeId: '17', lat: 44.9, lon: -93.4, bearing: 248, speedMps: 11.2,
    timestamp: 1_788_936_945, stopId: '57458', status: 'STOPPED_AT', occupancy: 'FEW_SEATS_AVAILABLE',
  }, 'bus', now);
  assert.equal(full.title, '🚌 Route 17');
  assert.deepEqual(full.details, [
    'Metro Transit · Minneapolis–St Paul, MN',
    '40 km/h · hdg 248°',
    'Stopped at stop 57458 · few seats available',
    'Vehicle 1557',
    'Reported 15 s ago',
  ]);
  const sparse = buildTransitSelectionCopy(feed, { id: 'abc', lat: 1, lon: 1 }, 'rail', now);
  assert.equal(sparse.title, '🚆 Vehicle abc');
  assert.deepEqual(sparse.details, ['Metro Transit · Minneapolis–St Paul, MN']);
  for (const line of [...full.details, ...sparse.details]) assert.doesNotMatch(line, /null|undefined|NaN/);
  assert.equal(transitVehicleKey('mbta', '17'), 'mbta:17');
});

test('the layer accepts a manager handle for out-of-tick panel repaints', () => {
  assert.equal(typeof transitLayer.attachDataManager, 'function');
  transitLayer.attachDataManager({ refreshLayerStats() {} });
  transitLayer.attachDataManager(null);
});

test('stats before enable are an honest zero, not a fake feed state', () => {
  const stats = transitLayer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.source, 'GTFS-RT');
  assert.equal(stats.error, null);
});