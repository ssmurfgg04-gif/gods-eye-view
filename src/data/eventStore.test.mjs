import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachBusRecorder,
  createEventStore,
  createLayerEvent,
  ensureBusRecorderInstalled,
  layerEventStore,
} from './eventStore.js';
// The bus is imported here (not re-exported) to keep the store's public API
// honest about what it owns.
import { createEventBus, gevEventBus } from '../core/eventBus.js';

test('createLayerEvent validates type and defaults timestamps', () => {
  const at = 5_000;
  const event = createLayerEvent('snapshot', 'quakes', { count: 1 }, at);
  assert.equal(event.type, 'snapshot');
  assert.equal(event.layerId, 'quakes');
  assert.equal(event.at, at);
  const bogus = createLayerEvent('explode', 'quakes', {}, at);
  assert.equal(bogus.type, 'update', 'unknown types degrade to update');
  const defaulted = createLayerEvent('add', 'quakes', {});
  assert.ok(Number.isFinite(defaulted.at));
  const named = createLayerEvent('add', null, {});
  assert.equal(named.layerId, 'unknown');
});

test('record assigns monotonic sequence numbers and returns the entry', () => {
  const store = createEventStore();
  const first = store.record(createLayerEvent('add', 'a', { ids: ['1'] }, 1_000));
  const second = store.record(createLayerEvent('add', 'a', { ids: ['2'] }, 2_000));
  assert.equal(second.seq, first.seq + 1);
  assert.equal(store.record(null), null);
  assert.equal(store.record({ type: 'bogus' }), null);
});

test('query filters by time window, layer, type, and limit', () => {
  const store = createEventStore();
  store.record(createLayerEvent('snapshot', 'a', {}, 1_000));
  store.record(createLayerEvent('add', 'a', { ids: ['x'] }, 2_000));
  store.record(createLayerEvent('add', 'b', { ids: ['y'] }, 3_000));
  store.record(createLayerEvent('remove', 'a', { ids: ['x'] }, 4_000));
  assert.equal(store.query({ since: 2_500 }).length, 2);
  assert.equal(store.query({ until: 1_500 }).length, 1);
  assert.equal(store.query({ layerId: 'a' }).length, 3);
  assert.equal(store.query({ layerId: 'a', type: 'add' }).length, 1);
  assert.equal(store.query({ limit: 2 }).length, 2);
  assert.deepEqual(store.query({ since: 4_000 }).map((e) => e.at), [4_000]);
});

test('query returns copies — callers cannot corrupt the ring', () => {
  const store = createEventStore();
  store.record(createLayerEvent('add', 'a', { ids: ['x'] }, 1_000));
  const [event] = store.query({});
  event.payload.hacked = true;
  const [fresh] = store.query({});
  assert.equal(fresh.payload.hacked, undefined);
});

test('stateAt folds a snapshot plus subsequent deltas (time travel)', () => {
  const store = createEventStore({ snapshotEvery: 1000 });
  store.record(createLayerEvent('snapshot', 'q', { count: 2, ids: ['a', 'b'], meta: {} }, 1_000));
  store.record(createLayerEvent('add', 'q', { ids: ['c'] }, 2_000));
  store.record(createLayerEvent('add', 'q', { ids: ['d'] }, 2_100));
  store.record(createLayerEvent('remove', 'q', { ids: ['a'] }, 2_200));
  store.record(createLayerEvent('update', 'q', { meta: { revised: 1 } }, 2_300));
  const end = store.stateAt(2_400, { layerId: 'q' }).state;
  assert.deepEqual(end.ids, ['b', 'c', 'd']);
  assert.equal(end.count, 3);
  assert.deepEqual(end.meta, { revised: 1 });
  const mid = store.stateAt(2_050, { layerId: 'q' }).state;
  assert.deepEqual(mid.ids, ['a', 'b', 'c'], '2:00 added c; 2:10 has not yet added d');
  const mid2 = store.stateAt(2_150, { layerId: 'q' }).state;
  assert.deepEqual(mid2.ids, ['a', 'b', 'c', 'd'], '2:10 added d; 2:20 has not yet removed a');
  const before = store.stateAt(1_500, { layerId: 'q' }).state;
  assert.deepEqual(before.ids, ['a', 'b']);
});

test('add unions ids (re-adding an existing id is not a duplicate)', () => {
  const store = createEventStore({ snapshotEvery: 1000 });
  store.record(createLayerEvent('snapshot', 'q', { count: 1, ids: ['a'], meta: {} }, 1_000));
  store.record(createLayerEvent('add', 'q', { ids: ['a', 'b'] }, 2_000));
  assert.deepEqual(store.stateAt(2_500, { layerId: 'q' }).state.ids, ['a', 'b']);
});

test('with no snapshot in history, stateAt folds all retained deltas', () => {
  const store = createEventStore({ snapshotEvery: 1000 });
  store.record(createLayerEvent('add', 'q', { ids: ['a'] }, 1_000));
  store.record(createLayerEvent('add', 'q', { ids: ['b'] }, 2_000));
  const { state } = store.stateAt(3_000, { layerId: 'q' });
  assert.deepEqual(state.ids, ['a', 'b']);
  assert.equal(state.count, 2);
});

test('unknown layer and pre-history queries return a zeroed state', () => {
  const store = createEventStore();
  store.record(createLayerEvent('snapshot', 'q', { count: 1, ids: ['a'] }, 1_000));
  const unknown = store.stateAt(2_000, { layerId: 'nope' }).state;
  assert.deepEqual(unknown, { count: 0, ids: [], meta: {} });
  const prehistory = store.stateAt(500, { layerId: 'q' }).state;
  assert.equal(prehistory.count, 0);
});

test('stateAt returns cloned state — mutating it cannot corrupt future folds', () => {
  const store = createEventStore({ snapshotEvery: 1000 });
  store.record(createLayerEvent('snapshot', 'q', { count: 1, ids: ['a'], meta: { v: 1 } }, 1_000));
  const first = store.stateAt(2_000, { layerId: 'q' }).state;
  first.ids.push('injected');
  first.meta.v = 999;
  const second = store.stateAt(2_000, { layerId: 'q' }).state;
  assert.deepEqual(second.ids, ['a']);
  assert.equal(second.meta.v, 1);
});

test('clear zeroes the folded state', () => {
  const store = createEventStore({ snapshotEvery: 1000 });
  store.record(createLayerEvent('snapshot', 'q', { count: 2, ids: ['a', 'b'], meta: { x: 1 } }, 1_000));
  store.record(createLayerEvent('clear', 'q', {}, 2_000));
  const { state } = store.stateAt(3_000, { layerId: 'q' });
  assert.deepEqual(state, { count: 0, ids: [], meta: {} });
});

test('synthetic snapshots are materialized at the recorded event time', () => {
  // An injected clock that lags the event timestamps must not corrupt the
  // fold — the snapshot is as-of the EVENT, not the clock.
  let clock = 1_000;
  const store = createEventStore({ snapshotEvery: 3, now: () => clock });
  store.record(createLayerEvent('snapshot', 'q', { count: 2, ids: ['a', 'b'], meta: {} }, 1_000));
  store.record(createLayerEvent('add', 'q', { ids: ['c'] }, 2_000));
  store.record(createLayerEvent('add', 'q', { ids: ['d'] }, 2_100));
  store.record(createLayerEvent('remove', 'q', { ids: ['a'] }, 2_200));
  const synthetic = store.query({ includeSynthetic: true, type: 'snapshot' });
  assert.equal(synthetic.length, 2, 'original + one synthetic');
  assert.equal(synthetic[1].synthetic, true);
  const { state } = store.stateAt(9_999, { layerId: 'q' });
  assert.deepEqual(state.ids, ['b', 'c', 'd'], 'folded through the synthetic snapshot');
});

test('query hides synthetic snapshots unless explicitly requested', () => {
  const store = createEventStore({ snapshotEvery: 2 });
  store.record(createLayerEvent('snapshot', 'q', {}, 1_000));
  store.record(createLayerEvent('add', 'q', { ids: ['a'] }, 2_000));
  store.record(createLayerEvent('add', 'q', { ids: ['b'] }, 3_000));
  assert.equal(store.query({}).length, 3, 'no synthetic in the default read');
  const withSynthetic = store.query({ includeSynthetic: true });
  assert.equal(withSynthetic.length, 4);
  assert.equal(withSynthetic.at(-1).synthetic, true);
});

test('the ring buffer evicts oldest events beyond capacity', () => {
  const store = createEventStore({ capacity: 4, snapshotEvery: 1000 });
  for (let i = 0; i < 8; i += 1) {
    store.record(createLayerEvent('add', 'q', { ids: [`e${i}`] }, 1_000 + i));
  }
  assert.equal(store.diagnostics().length, 4);
  const earliest = store.query({})[0];
  assert.equal(earliest.at, 1_004, 'oldest retained event is the 5th');
});

test('diagnostics report per-layer shape', () => {
  const store = createEventStore();
  store.record(createLayerEvent('snapshot', 'a', {}, 1_000));
  store.record(createLayerEvent('add', 'b', { ids: ['x'] }, 2_000));
  const diag = store.diagnostics();
  assert.equal(diag.length, 2);
  const layerA = diag.layers.find((l) => l.layerId === 'a');
  assert.equal(layerA.events, 1);
  assert.equal(layerA.snapshots, 1);
  assert.equal(diag.layers.length, 2);
});

test('reset clears the timeline', () => {
  const store = createEventStore();
  store.record(createLayerEvent('add', 'q', { ids: ['a'] }, 1_000));
  store.reset();
  assert.equal(store.diagnostics().length, 0);
});

test('attachBusRecorder records layer: events and ignores noise', () => {
  const bus = createEventBus();
  const store = createEventStore({ snapshotEvery: 1000 });
  attachBusRecorder(bus, store); // recorder lives and dies with this bus
  bus.publish('layer:earthquakes:update', createLayerEvent('snapshot', 'earthquakes', { count: 5, ids: ['x1'], meta: {} }, 5_000));
  bus.publish('layer:flights:update', createLayerEvent('add', 'flights', { ids: ['f1'] }, 5_100));
  bus.publish('noise:irrelevant', { hello: 1 });
  bus.publish('layer:earthquakes:update', { type: 'definitely-not-a-layer-event' });
  bus.publish('layer:earthquakes:update', null);
  assert.equal(store.query({}).length, 2);
  const { state } = store.stateAt(6_000, { layerId: 'earthquakes' });
  assert.equal(state.count, 5);
});

test('detaching the bus recorder stops recording', () => {
  const bus = createEventBus();
  const store = createEventStore({ snapshotEvery: 1000 });
  const detach = attachBusRecorder(bus, store);
  bus.publish('layer:x:update', createLayerEvent('add', 'x', { ids: ['1'] }, 1_000));
  detach();
  bus.publish('layer:x:update', createLayerEvent('add', 'x', { ids: ['2'] }, 2_000));
  assert.equal(store.query({}).length, 1);
});

test('ensureBusRecorderInstalled is idempotent on the singletons', () => {
  // Reset singletons, install twice, publish once → exactly one recording.
  layerEventStore.reset();
  gevEventBus.reset();
  const detach1 = ensureBusRecorderInstalled();
  ensureBusRecorderInstalled(); // second install is a deliberate no-op
  gevEventBus.publish('layer:probe:update', createLayerEvent('add', 'probe', { ids: ['p1'] }, 42_000));
  assert.equal(layerEventStore.query({ layerId: 'probe' }).length, 1, 'double install does not double-record');
  assert.equal(layerEventStore.query({ layerId: 'probe' })[0].payload.ids[0], 'p1');
  // Detach via the FIRST handle and confirm the recorder actually stops.
  detach1();
  gevEventBus.publish('layer:probe:update', createLayerEvent('add', 'probe', { ids: ['p2'] }, 43_000));
  assert.equal(layerEventStore.query({ layerId: 'probe' }).length, 1, 'detached — no further recording');
  layerEventStore.reset();
  gevEventBus.reset();
  // Leave the singleton recorder installed (production posture) so later
  // tests in this process observe the real steady state.
  ensureBusRecorderInstalled();
});

test('the layerEventStore singleton exposes the frozen public surface', () => {
  assert.ok(layerEventStore);
  for (const method of ['record', 'query', 'stateAt', 'diagnostics', 'reset']) {
    assert.equal(typeof layerEventStore[method], 'function', `${method} on singleton`);
  }
});
