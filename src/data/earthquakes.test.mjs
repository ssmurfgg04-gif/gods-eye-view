// src/data/earthquakes.test.mjs
// Focused tests for the pure analyst-record mapper (analyst query engine seam).
// Pure function — no viewer/DOM needed; imported directly.
import { test, beforeEach } from 'node:test';
import { _resetFeedCacheForTest } from './feedCache.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { gevEventBus } from '../core/eventBus.js';
import { ensureBusRecorderInstalled, layerEventStore } from './eventStore.js';
import { getProvenance } from './provenance.js';
import {
  EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
  createEarthquakeOverlayEntry,
  createEarthquakesLayer,
  mapAnalystRecord,
  selectEarthquakeOverlayCohort,
} from './earthquakes.js';
import { DataLayerManager } from './manager.js';
import {
  getRenderGovernorDiagnostics,
  installRenderGovernor,
  _resetRenderGovernorForTest,
} from '../renderGovernor.js';

const FULL_RAW = {
  id: 'us7000abcd',
  mag: 5.2,
  place: '42 km SW of Anchorage, Alaska',
  time: 1_753_600_000_000,
  depth: 41.7,
  lat: 61.02,
  lon: -150.41,
};


// Feed-cache isolation: each test mocks its own upstream, so the module-level
// TTL cache must not leak responses between tests.
beforeEach(() => {
  _resetFeedCacheForTest();
});
test('earthquake analyst record: full record maps every contract field', () => {
  const r = mapAnalystRecord(FULL_RAW, 3);
  assert.deepEqual(r, {
    id: 'us7000abcd',
    magnitude: 5.2,
    depthKm: 41.7,
    lat: 61.02,
    lon: -150.41,
    timeMs: 1_753_600_000_000,
    place: '42 km SW of Anchorage, Alaska',
  });
});

test('earthquake analyst record: missing USGS id falls back to index-based id', () => {
  assert.equal(mapAnalystRecord({ ...FULL_RAW, id: null }, 3).id, 'QUAKE-0003');
  assert.equal(mapAnalystRecord({ ...FULL_RAW, id: '  ' }, 41).id, 'QUAKE-0041');
  assert.equal(mapAnalystRecord(undefined).id, 'QUAKE-0000');
});

test('earthquake analyst record: missing fields become null, never NaN/undefined', () => {
  const r = mapAnalystRecord({ id: 'us1', mag: NaN, depth: undefined, place: '' }, 0);
  assert.equal(r.magnitude, null);
  assert.equal(r.depthKm, null);
  assert.equal(r.place, null);
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('earthquake analyst record: output is JSON-safe (no Cesium types)', () => {
  const r = mapAnalystRecord(FULL_RAW, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('earthquake overlay copy keeps source-side magnitude formatting and bounded priority', () => {
  const position = Cesium.Cartesian3.fromDegrees(-150.41, 61.02);
  const entry = createEarthquakeOverlayEntry({
    id: 'us7000abcd',
    position,
    magnitude: 5.24,
    accent: '#ff0000',
  });
  assert.equal(entry.title, 'M5.2');
  assert.equal(entry.position, position);
  assert.equal(entry.variant, 'label');
  assert.equal(entry.paintLane, 'ambient-label');
  assert.equal(entry.collisionGroup, 'ambient-label');
  assert.equal(entry.protected, undefined);
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);

  const entries = Array.from({ length: EARTHQUAKE_OVERLAY_COHORT_LIMIT + 20 }, (_, index) => ({
    id: `quake-${String(index).padStart(3, '0')}`,
    priority: index,
  }));
  const cohort = selectEarthquakeOverlayCohort(entries);
  assert.equal(cohort.length, EARTHQUAKE_OVERLAY_COHORT_LIMIT);
  assert.equal(cohort[0].id, `quake-${EARTHQUAKE_OVERLAY_COHORT_LIMIT + 19}`);
  assert.equal(cohort.at(-1).id, 'quake-020');
});

test('real earthquake lifecycle publishes host labels while runtime entities carry no label graphic', async () => {
  const originalFetch = globalThis.fetch;
  const hostCalls = [];
  const dataSources = [];
  const overlayHost = {
    setEntries: (...args) => hostCalls.push(['entries', ...args]),
    setVisible: (...args) => hostCalls.push(['visible', ...args]),
    clearSource: (...args) => hostCalls.push(['clear', ...args]),
  };
  const viewer = {
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      features: [
        {
          id: 'us-runtime-1',
          geometry: { coordinates: [-150.41, 61.02, 41.7] },
          properties: { mag: 5.24, place: 'Runtime One', time: 1_753_600_000_000 },
        },
        {
          id: 'us-runtime-2',
          geometry: { coordinates: [139.7, 35.6, 310] },
          properties: { mag: 3.01, place: 'Runtime Two', time: 1_753_600_100_000 },
        },
      ],
    }),
  });
  const layer = createEarthquakesLayer({ overlayHost });
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer);

    const entities = dataSources[0].entities.values;
    assert.equal(entities.length, 2, 'runtime guard requires populated real source entities');
    assert.ok(entities.every((entity) => entity.label === undefined));
    const publication = hostCalls.find(([type]) => type === 'entries');
    assert.ok(publication, 'real update path must publish the overlay source');
    assert.deepEqual(publication[2].map(({ title }) => title), ['M5.2', 'M3.0']);
    assert.deepEqual(publication[3], {
      cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
      collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });

    layer.disable(viewer);
    assert.equal(dataSources[0].show, false);
    assert.deepEqual(hostCalls.slice(-2), [
      ['clear', 'earthquakes'],
      ['visible', 'earthquakes', false],
    ]);
    layer.destroy(viewer);
    assert.equal(dataSources.length, 0);
    assert.deepEqual(hostCalls.slice(-2), [
      ['clear', 'earthquakes'],
      ['visible', 'earthquakes', false],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Perf pin: the 2026-08-20 earthquakes frame-rate cliff ────────────────────
// Every disc is a CLAMP_TO_GROUND ellipse. When its axes were a
// `CallbackProperty`, Cesium re-tessellated all 58 ground primitives on EVERY
// frame: 32.4 ms/frame and 30 fps for 58 contacts, against 1.4 ms/60 fps with
// the layer off. Static axes restored 60 fps. Both halves of the fix are
// pinned — the runtime property shape, and the source-level guards.
test('quake disc axes are STATIC — a per-frame callback re-tessellates ground geometry', async () => {
  const originalFetch = globalThis.fetch;
  const dataSources = [];
  const viewer = {
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove() { return true; },
    },
  };
  const layer = createEarthquakesLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      features: [{
        id: 'us-static-1',
        geometry: { coordinates: [-122.4, 37.79, 8.2] },
        properties: { mag: 5.5, place: 'Static One', time: 1_753_600_000_000 },
      }],
    }),
  });
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer);

    const [entity] = dataSources[0].entities.values;
    assert.ok(entity.ellipse, 'the disc is an ellipse graphic');
    for (const axis of ['semiMajorAxis', 'semiMinorAxis']) {
      const property = entity.ellipse[axis];
      assert.equal(
        property instanceof Cesium.CallbackProperty,
        false,
        `${axis} must not be a CallbackProperty — it rebuilds the ground primitive every frame`,
      );
      assert.equal(property.isConstant, true, `${axis} must be a constant property`);
      // Magnitude 5.5 → 2^5.5 * 1000 m, unchanged by the dropped pulse.
      assert.equal(property.getValue(Cesium.JulianDate.now()), Math.pow(2, 5.5) * 1000);
    }
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

// Dropping the continuous-render hold is only safe if new poll data still reaches
// the screen. In idle mode nothing repaints on its own, so the manager's one-shot
// request after each tick is now load-bearing for this layer. Wires the REAL layer
// into the REAL manager with the governor installed, rather than trusting the
// arrangement by inspection.
test('a quake poll still reaches the screen with the render loop idle', async () => {
  const originalFetch = globalThis.fetch;
  const renderRequests = [];
  const dataSources = [];
  const viewer = {
    scene: { requestRenderMode: false, requestRender: () => renderRequests.push(Date.now()) },
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove() { return true; },
    },
  };
  const layer = createEarthquakesLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      features: [{
        id: 'us-idle-1',
        geometry: { coordinates: [-122.4, 37.79, 8.2] },
        properties: { mag: 4.2, place: 'Idle One', time: 1_753_600_000_000 },
      }],
    }),
  });

  _resetRenderGovernorForTest();
  installRenderGovernor(viewer);
  // Installing the governor enters idle mode, which itself paints one settling
  // frame. Drop that from the baseline or the enable assertion below can pass on
  // the install alone, without the manager ever requesting anything.
  renderRequests.length = 0;
  const manager = new DataLayerManager(viewer);
  // updateInterval -1 keeps the poll loop unarmed; we drive one tick by hand.
  manager.register({ ...layer, updateInterval: -1 });
  try {
    await manager.setEnabled('earthquakes', true, { origin: 'test' });

    // The whole point of the change: enabling quakes must not pin the loop on.
    assert.equal(getRenderGovernorDiagnostics().mode, 'idle', 'quakes must not force continuous render');
    assert.deepEqual(getRenderGovernorDiagnostics().holds, []);
    assert.equal(viewer.scene.requestRenderMode, true, 'the governor really is in idle mode');

    // ...and the poll that populated the discs must still have asked for a frame,
    // because in idle mode nothing repaints on its own.
    assert.ok(dataSources[0].entities.values.length > 0, 'the enable poll produced discs');
    assert.ok(renderRequests.length > 0, 'enabling the layer must request a render in idle mode');
    // Named, not merely counted: the frame has to come from the manager's
    // visibility request, not from some incidental repaint.
    assert.ok(
      getRenderGovernorDiagnostics().recentRequests.some(({ reason }) => reason === 'layer-visibility'),
      'the enable frame must be the manager\'s layer-visibility request',
    );

    // A LATER poll must request its own frame too — the enable-time
    // 'layer-visibility' request cannot cover refreshes that arrive minutes later.
    const beforeRefresh = renderRequests.length;
    await manager._runPeriodicUpdate('earthquakes', manager.layers.get('earthquakes'));
    assert.ok(
      renderRequests.length > beforeRefresh,
      'each refresh tick must request its own render while the loop is idle',
    );
    const reasons = getRenderGovernorDiagnostics().recentRequests.map(({ reason }) => reason);
    assert.ok(
      reasons.includes('layer-tick:earthquakes'),
      `the tick request must be attributed to the layer, got ${JSON.stringify(reasons)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await manager.setEnabled('earthquakes', false, { origin: 'test' }).catch(() => {});
    _resetRenderGovernorForTest();
  }
});

test('the earthquakes layer installs no per-frame callback and no continuous-render hold', () => {
  const source = readFileSync(new URL('./earthquakes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /new Cesium\.CallbackProperty/,
    'reverting the discs to a per-frame axis callback must fail this pin',
  );
  assert.doesNotMatch(
    source,
    /holdContinuousRender/,
    'static discs have no per-frame animator, so the layer must not pin the render loop on',
  );
});

test('earthquake refresh reports failure and clears it only after a successful response', async () => {
  const originalFetch = globalThis.fetch;
  const dataSources = [];
  const viewer = {
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove() { return true; },
    },
  };
  const layer = createEarthquakesLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    assert.equal(await layer.update(viewer), false);
    assert.equal(layer.getStats().error, 'USGS HTTP 503');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ features: [] }),
    });
    assert.equal(await layer.update(viewer), true);
    assert.equal(layer.getStats().error, null);
    assert.ok(Number.isFinite(layer.getStats().lastUpdate));
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

// ── MILLION-X wave 2: provenance / relevance / bus / timeline integration ────
// The earthquakes layer is the reference adopter of the four subsystems; these
// tests pin the wiring, not just the modules in isolation.

const NOW_MS = 1_753_612_400_000; // fixed "now" for deterministic relevance
function minutesAgo(minutes) {
  return Date.now() - minutes * 60_000;
}
function feature(id, mag, time, lon = -122.4, lat = 37.79, depth = 8.2) {
  return { id, geometry: { coordinates: [lon, lat, depth] }, properties: { mag, place: `Place ${id}`, time } };
}
function minimalViewer() {
  const dataSources = [];
  return {
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
    dataSourcesRef: dataSources,
  };
}
function mockFetchWith(features) {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ features }) });
}

test('a USGS magnitude revision across polls becomes a visible provenance fact', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = minimalViewer();
  const layer = createEarthquakesLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  try {
    layer.init(viewer);
    layer.enable(viewer);

    mockFetchWith([feature('us-rev-1', 4.2, minutesAgo(60))]);
    await layer.update(viewer);
    assert.equal(layer.getStats().revisedEvents, 0);

    // Poll 2: same event id, magnitude corrected 4.2 → 4.5.
    _resetFeedCacheForTest();
    mockFetchWith([feature('us-rev-1', 4.5, minutesAgo(60))]);
    await layer.update(viewer);

    const stats = layer.getStats();
    assert.equal(stats.revisedEvents, 1, 'one magnitude revision observed');
    assert.match(stats.provenance, /USGS/);
    assert.equal(stats.feedState, 'trusted', 'fresh direct fetch grades trusted');
    assert.ok(stats.lastUpdate > 0);
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('feed-level provenance degrades honestly when the network fails', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = minimalViewer();
  const layer = createEarthquakesLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  try {
    layer.init(viewer);
    layer.enable(viewer);

    // Prime with a fresh, good snapshot.
    mockFetchWith([feature('us-stale-1', 4.0, minutesAgo(1))]);
    await layer.update(viewer);
    assert.equal(layer.getStats().stale, false);
    assert.equal(layer.getStats().feedState, 'trusted');

    // Hard-fail the network: the poll reports the error, and stats KEEP the
    // last good provenance — honest degradation, not amnesia.
    _resetFeedCacheForTest();
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    assert.equal(await layer.update(viewer), false);
    assert.equal(layer.getStats().error, 'USGS HTTP 503');
    assert.equal(layer.getStats().feedState, 'trusted', 'last good provenance persists');
    assert.match(layer.getStats().provenance, /USGS/);
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('each successful poll publishes one snapshot event on the bus and into the timeline', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = minimalViewer();
  const layer = createEarthquakesLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const published = [];
  const off = gevEventBus.subscribe('layer:earthquakes:update', (payload) => published.push(payload));
  ensureBusRecorderInstalled(); // idempotent — installs if no earlier test did
  const timelineBefore = layerEventStore.query({ layerId: 'earthquakes' }).length;
  try {
    layer.init(viewer);
    layer.enable(viewer);
    mockFetchWith([
      feature('us-bus-1', 5.1, NOW_MS - 60_000),
      feature('us-bus-2', 3.2, NOW_MS - 120_000),
    ]);
    await layer.update(viewer);

    assert.equal(published.length, 1, 'exactly one event per successful poll');
    const event = published[0];
    assert.equal(event.type, 'snapshot');
    assert.equal(event.layerId, 'earthquakes');
    assert.equal(event.payload.count, 2);
    assert.deepEqual(event.payload.ids, ['us-bus-1', 'us-bus-2']);
    assert.equal(event.payload.meta.added, 2, 'both events are new');
    assert.equal(event.payload.meta.removed, 0);
    assert.equal(event.payload.meta.stale, false);
    assert.match(event.payload.meta.provenance, /USGS/);

    // The singleton bus→store recorder filed it into the replayable timeline.
    const timelineAfter = layerEventStore.query({ layerId: 'earthquakes' }).length;
    assert.equal(timelineAfter, timelineBefore + 1);
    const { state } = layerEventStore.stateAt(Date.now() + 1, { layerId: 'earthquakes' });
    assert.equal(state.count, 2);
    assert.deepEqual(state.ids, ['us-bus-1', 'us-bus-2']);
  } finally {
    off();
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('poll-to-poll diffs report aged-out and newly-added events in timeline meta', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = minimalViewer();
  const layer = createEarthquakesLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const published = [];
  const off = gevEventBus.subscribe('layer:earthquakes:update', (payload) => published.push(payload));
  try {
    layer.init(viewer);
    layer.enable(viewer);
    mockFetchWith([feature('us-old-1', 4.4, NOW_MS - 7200_000), feature('us-old-2', 4.1, NOW_MS - 5400_000)]);
    await layer.update(viewer);

    _resetFeedCacheForTest();
    mockFetchWith([feature('us-old-2', 4.1, NOW_MS - 5400_000), feature('us-new-1', 4.9, NOW_MS - 30_000)]);
    await layer.update(viewer);

    assert.equal(published.length, 2);
    const diff = published[1].payload.meta;
    assert.equal(diff.added, 1, 'us-new-1 appeared');
    assert.equal(diff.removed, 1, 'us-old-1 aged out');
    assert.equal(diff.revised, 0);
  } finally {
    off();
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('entities carry attached provenance records (WeakMap, no shape change)', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = minimalViewer();
  const layer = createEarthquakesLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  try {
    layer.init(viewer);
    layer.enable(viewer);
    mockFetchWith([feature('us-prov-1', 4.7, NOW_MS - 45_000)]);
    await layer.update(viewer);
    const [entity] = viewer.dataSourcesRef[0].entities.values;
    const record = getProvenance(entity);
    assert.ok(record, 'evidence rides with the entity');
    assert.equal(record.subjectId, 'us-prov-1');
    assert.equal(record.revision, 0);
    assert.equal(record.source, 'USGS');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('relevance-ranked cohort: a fresh M4.9 outranks a 12 h-old M6.5', () => {
  const position = Cesium.Cartesian3.fromDegrees(-122.4, 37.79);
  const fresh = createEarthquakeOverlayEntry({ id: 'fresh-m49', position, magnitude: 4.9, accent: '#f00', observedAt: NOW_MS - 60_000 });
  const stale = createEarthquakeOverlayEntry({ id: 'stale-m65', position, magnitude: 6.5, accent: '#f80', observedAt: NOW_MS - 12 * 3_600_000 });
  const cohort = selectEarthquakeOverlayCohort([stale, fresh], 2, { now: () => NOW_MS });
  assert.deepEqual(cohort.map((e) => e.id), ['fresh-m49', 'stale-m65'],
    'severity × recency — the LIVE console ordering, not raw magnitude');
});

test('relevance cohort keeps the legacy magnitude ordering when entries carry no signals', () => {
  // Legacy callers (and the pinned test above) pass priority-only entries:
  // the relevance path must yield to the original comparator verbatim.
  const entries = [
    { id: 'p-lo', priority: 100 },
    { id: 'p-hi', priority: 900 },
    { id: 'p-mid', priority: 500 },
  ];
  const cohort = selectEarthquakeOverlayCohort(entries, 3, { now: () => NOW_MS });
  assert.deepEqual(cohort.map((e) => e.id), ['p-hi', 'p-mid', 'p-lo']);
});

test('a mixed cohort ranks scored entries ahead of unscored ones', () => {
  const position = Cesium.Cartesian3.fromDegrees(-122.4, 37.79);
  const scored = createEarthquakeOverlayEntry({ id: 'scored', position, magnitude: 5.0, accent: '#f00', observedAt: NOW_MS - 30_000 });
  const unscored = { id: 'unscored', priority: 9999 };
  const cohort = selectEarthquakeOverlayCohort([unscored, scored], 2, { now: () => NOW_MS });
  // Known relevance (even modest) outranks unknown-but-claimed priority.
  assert.equal(cohort[0].id, 'scored');
  assert.equal(cohort.length, 2);
});
