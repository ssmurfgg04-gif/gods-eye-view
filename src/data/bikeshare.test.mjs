import test, { beforeEach } from 'node:test';
import { _resetFeedCacheForTest } from './feedCache.js';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
  _clearBikeshareSelectionForTest,
  _selectBikeshareStationForTest,
  _setBikeshareSelectionStateForTest,
  createBikeshareSelectedOverlayEntry,
  parseStationInformation,
} from './bikeshare.js';

function makeRecord() {
  return {
    stationId: '3790',
    stationName: 'Congress & 6th',
    bikesAvailable: 7,
    docksAvailable: 4,
    capacity: 11,
    isInstalled: true,
    isRenting: false,
    isReturning: true,
    point: {
      position: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 2),
      show: true,
    },
  };
}


// Feed-cache isolation: each test mocks its own upstream, so the module-level
// TTL cache must not leak responses between tests.
beforeEach(() => {
  _resetFeedCacheForTest();
});
test('selected bikeshare entry preserves source copy and protected-lane policy', () => {
  const record = makeRecord();
  const entry = createBikeshareSelectedOverlayEntry('austin-capmetro:3790', record);
  assert.equal(entry.position, record.point.position);
  assert.equal(entry.title, 'Congress & 6th');
  assert.deepEqual(entry.details, [
    '🚲 7 avail · 4 docks · 11 cap',
    '⚠️ Not renting',
  ]);
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.selected, true);
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
});

test('real station select/clear path publishes one card and creates no native label graphic', () => {
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const key = 'austin-capmetro:3790';
  const record = makeRecord();
  const viewer = { entities: new Cesium.EntityCollection() };
  _setBikeshareSelectionStateForTest({ viewer, key, record, overlayHost });
  try {
    _selectBikeshareStationForTest(key);
    assert.equal(record.point.show, false);
    assert.equal(viewer.entities.values.length, 1, 'runtime guard requires a real selected entity');
    assert.equal(viewer.entities.values[0].label, undefined);
    assert.ok(viewer.entities.values[0].point, 'selected point highlight remains native');

    const publication = calls.find(([type]) => type === 'entries');
    assert.ok(publication);
    assert.equal(publication[1], 'bikeshare-selected');
    assert.equal(publication[2].length, 1);
    assert.equal(publication[2][0].position, record.point.position);
    assert.deepEqual(publication[3], BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS);

    _clearBikeshareSelectionForTest();
    assert.equal(record.point.show, true);
    assert.equal(viewer.entities.values.length, 0);
    assert.deepEqual(calls.at(-1), ['clear', 'bikeshare-selected']);
  } finally {
    _clearBikeshareSelectionForTest();
  }
});

test('GBFS v3 LocalizedString names resolve instead of rendering [object Object]', () => {
  const stations = parseStationInformation({
    version: '3.0',
    data: {
      stations: [
        {
          station_id: 'v3-a',
          name: [{ language: 'es', text: 'Estación Central' }, { language: 'en', text: 'Central Station' }],
          short_name: [{ language: 'en', text: 'Central' }],
          lat: 30.2672, lon: -97.7431,
        },
        {
          station_id: 'v3-b',
          name: [{ language: 'fr', text: 'Gare du Nord' }],
          lat: 30.27, lon: -97.74,
        },
        {
          station_id: 'v3-c',
          name: [{ language: 'en', text: '' }],
          short_name: 'Plain String',
          lat: 30.27, lon: -97.74,
        },
      ],
    },
  });
  assert.equal(stations.get('v3-a').name, 'Central Station', 'en preferred over first locale');
  assert.equal(stations.get('v3-b').name, 'Gare du Nord', 'falls back to first available locale');
  assert.equal(stations.get('v3-c').name, 'Plain String', 'mixed localized/plain rows resolve');
});

test('GBFS v2 plain-string names keep working unchanged', () => {
  const stations = parseStationInformation({
    version: '2.3',
    data: {
      stations: [{ station_id: 'v2-a', name: 'Congress & 6th', lat: 30.2672, lon: -97.7431 }],
    },
  });
  assert.equal(stations.get('v2-a').name, 'Congress & 6th');
});
