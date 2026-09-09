import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLazyLayerAccessor,
  setLiveLayerModule,
  getLiveLayerModule,
  deleteLiveLayerModule,
} from './layerAccess.js';

test('before load, every property is a safe no-op function', () => {
  const layer = createLazyLayerAccessor('nothing-loaded');
  assert.equal(typeof layer.focusCamera, 'function');
  assert.equal(layer.focusCamera('cam-1'), undefined);
  assert.equal(layer.refocusTrackedById?.('abc123') === true, false);
  assert.equal(layer.getTrackedInfo?.(), undefined);
});

test('the accessor is not accidentally thenable', async () => {
  const layer = createLazyLayerAccessor('no-await');
  assert.equal(layer.then, undefined);
  const result = await Promise.resolve(layer);
  // Awaiting must resolve to the proxy itself, not invoke hidden callbacks.
  assert.equal(typeof result.focusCamera, 'function');
});

test('after setLiveLayerModule, property reads forward with correct this-binding', () => {
  const module = {
    id: 'flights',
    calls: 0,
    ping() { this.calls += 1; return 'pong'; },
    value: 42,
  };
  setLiveLayerModule('flights', module);
  const layer = createLazyLayerAccessor('flights');
  assert.equal(layer.ping(), 'pong');
  assert.equal(module.calls, 1, 'this bound to the live module');
  assert.equal(layer.value, 42);
  deleteLiveLayerModule('flights');
  assert.equal(getLiveLayerModule('flights'), null);
});

test('after deletion, the accessor degrades back to no-ops', () => {
  const module = { id: 'gone', focus: () => 'ok' };
  setLiveLayerModule('gone', module);
  const layer = createLazyLayerAccessor('gone');
  assert.equal(layer.focus(), 'ok');
  deleteLiveLayerModule('gone');
  assert.equal(layer.focus(), undefined);
  assert.equal(layer.focus?.() === 'ok', false);
});

test('has-trap reflects the live module only', () => {
  const layer = createLazyLayerAccessor('maybe');
  assert.equal('subscribe' in layer, false);
  setLiveLayerModule('maybe', { id: 'maybe', subscribe: () => () => {} });
  assert.equal('subscribe' in layer, true);
  assert.equal('never' in layer, false);
  deleteLiveLayerModule('maybe');
});
