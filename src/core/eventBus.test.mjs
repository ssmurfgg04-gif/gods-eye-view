import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus, gevEventBus } from './eventBus.js';

test('exact-channel subscription receives only that channel, synchronously', () => {
  const bus = createEventBus();
  const seen = [];
  bus.subscribe('layer:earthquakes:update', (payload) => seen.push(payload));
  const notified = bus.publish('layer:earthquakes:update', { count: 3 });
  bus.publish('layer:flights:update', { count: 99 });
  assert.deepEqual(seen, [{ count: 3 }]);
  assert.equal(notified, 1, 'publish reports the notified listener count');
});

test('prefix wildcard (layer:*) matches every layer channel', () => {
  const bus = createEventBus();
  const seen = [];
  bus.subscribe('layer:*', (payload, meta) => seen.push(meta.channel));
  bus.publish('layer:earthquakes:update', {});
  bus.publish('layer:flights:update', {});
  bus.publish('noise:irrelevant', {});
  assert.deepEqual(seen, ['layer:earthquakes:update', 'layer:flights:update']);
});

test('RegExp patterns subscribe by test()', () => {
  const bus = createEventBus();
  const seen = [];
  bus.subscribe(/^layer:quakes:(add|remove)$/, (p, meta) => seen.push(meta.channel));
  bus.publish('layer:quakes:add', {});
  bus.publish('layer:quakes:update', {});
  bus.publish('layer:quakes:remove', {});
  assert.deepEqual(seen, ['layer:quakes:add', 'layer:quakes:remove']);
});

test("'*' subscribes to everything", () => {
  const bus = createEventBus();
  let count = 0;
  bus.subscribe('*', () => { count += 1; });
  bus.publish('a:b', {});
  bus.publish('zzz', {});
  assert.equal(count, 2);
});

test('unsubscribe stops delivery; double-unsubscribe is safe', () => {
  const bus = createEventBus();
  let hits = 0;
  const off = bus.subscribe('ch', () => { hits += 1; });
  bus.publish('ch', {});
  off();
  off();
  bus.publish('ch', {});
  assert.equal(hits, 1);
});

test('a throwing listener is isolated — later subscribers still fire', () => {
  const bus = createEventBus();
  const order = [];
  bus.subscribe('ch', () => { order.push('first'); throw new Error('subscriber bug'); });
  bus.subscribe('ch', () => order.push('second'));
  bus.publish('ch', {});
  assert.deepEqual(order, ['first', 'second']);
});

test('a throwing listener does not break the replay buffer', () => {
  const bus = createEventBus();
  bus.subscribe('ch', () => { throw new Error('x'); });
  bus.publish('ch', { n: 1 });
  assert.equal(bus.replay('ch').length, 1, 'event still buffered');
});

test('replay buffer is bounded by replayDepth and keeps the newest events', () => {
  const bus = createEventBus({ replayDepth: 3 });
  for (let i = 0; i < 10; i += 1) bus.publish('ch', { i });
  const history = bus.replay('ch');
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((e) => e.payload.i), [7, 8, 9]);
});

test('replay: true hands a late subscriber the buffered history in order', () => {
  const bus = createEventBus({ replayDepth: 4 });
  bus.publish('ch', { i: 1 });
  bus.publish('ch', { i: 2 });
  const seen = [];
  bus.subscribe('ch', (payload) => seen.push(payload.i), { replay: true });
  assert.deepEqual(seen, [1, 2]);
  bus.publish('ch', { i: 3 });
  assert.deepEqual(seen, [1, 2, 3]);
});

test('wildcard subscribers never get replay (unbounded by definition)', () => {
  const bus = createEventBus({ replayDepth: 4 });
  bus.publish('layer:a:x', {});
  bus.publish('layer:b:x', {});
  let hits = 0;
  bus.subscribe('layer:*', () => { hits += 1; }, { replay: true });
  assert.equal(hits, 0, 'wildcard replay is deliberately empty');
});

test('coalesceKey merges a burst into one buffered entry with the latest payload', () => {
  const bus = createEventBus({ replayDepth: 8 });
  for (let i = 0; i < 25; i += 1) bus.publish('positions', { craft: 'iss', lat: i }, { coalesceKey: 'iss' });
  const history = bus.replay('positions');
  assert.equal(history.length, 1, 'burst collapsed in the buffer');
  assert.equal(history[0].mergedCount, 25);
  assert.equal(history[0].payload.lat, 24, 'latest payload wins');
  // Dispatch was NOT coalesced — lossless fan-out:
  let dispatched = 0;
  bus.subscribe('positions', () => { dispatched += 1; });
  bus.publish('positions', { craft: 'iss', lat: 99 }, { coalesceKey: 'iss' });
  assert.equal(dispatched, 1);
  assert.equal(bus.replay('positions')[0].mergedCount, 26);
});

test('distinct coalesceKeys buffer separately', () => {
  const bus = createEventBus({ replayDepth: 8 });
  bus.publish('positions', { id: 'a' }, { coalesceKey: 'a' });
  bus.publish('positions', { id: 'b' }, { coalesceKey: 'b' });
  assert.equal(bus.replay('positions').length, 2);
});

test('publish on an invalid channel is a no-op returning 0', () => {
  const bus = createEventBus();
  assert.equal(bus.publish('', {}), 0);
  assert.equal(bus.publish(undefined, {}), 0);
});

test('subscribe with a non-function handler or bogus pattern is a safe no-op', () => {
  const bus = createEventBus();
  const off1 = bus.subscribe('ch', 'not a function');
  const off2 = bus.subscribe(42, () => {});
  assert.equal(typeof off1, 'function');
  assert.equal(typeof off2, 'function');
  assert.equal(bus.publish('ch', {}), 0);
});

test('bus clock is injectable for deterministic replay timestamps', () => {
  let t = 1000;
  const bus = createEventBus({ now: () => t });
  bus.publish('ch', {});
  t = 2000;
  bus.publish('ch', {});
  const history = bus.replay('ch');
  assert.deepEqual(history.map((e) => e.at), [1000, 2000]);
});

test('diagnostics report channel shape without payloads', () => {
  const bus = createEventBus();
  let off = bus.subscribe('layer:earthquakes:update', () => {});
  bus.publish('layer:earthquakes:update', { secret: 'should-not-appear' });
  const diag = bus.diagnostics();
  assert.equal(diag.subscriberCount, 1);
  assert.equal(diag.channelCount, 1);
  const channel = diag.channels[0];
  assert.equal(channel.channel, 'layer:earthquakes:update');
  assert.equal(channel.publishCount, 1);
  assert.equal(channel.bufferDepth, 1);
  assert.ok(!JSON.stringify(diag).includes('should-not-appear'));
  off();
  assert.equal(bus.diagnostics().subscriberCount, 0);
});

test('reset drops subscribers and buffered history', () => {
  const bus = createEventBus();
  bus.subscribe('ch', () => {});
  bus.publish('ch', {});
  bus.reset();
  assert.equal(bus.diagnostics().channelCount, 0);
  assert.equal(bus.replay('ch').length, 0);
});

test('the singleton bus exists with the frozen public surface', () => {
  assert.ok(gevEventBus);
  for (const method of ['publish', 'subscribe', 'replay', 'diagnostics', 'reset']) {
    assert.equal(typeof gevEventBus[method], 'function', `${method} exported`);
  }
});
