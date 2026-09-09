#!/usr/bin/env node
/**
 * Fast PR-gate smoke checks (perf P2).
 *
 * The full unit-test suite is thorough but slow; the deep QA harnesses are
 * release gates. This script is the fast subset that runs on every PR and
 * catches the cheapest-to-detect, most-expensive-to-miss breakage classes:
 *
 *   1. Critical module graph still imports (manager, governor, scheduler,
 *      cache, layer access, manifest, detection helpers, quality, LAN token).
 *   2. The lazy layer manifest exactly matches the persistence registry.
 *   3. The OpenAI Realtime tool schema (src/voice/realtimeTools.js) still
 *      validates its structural contract.
 *   4. A mock layer round-trips the manager lifecycle (register → enable →
 *      disable → destroy) without throwing.
 *
 * Run: node scripts/smoke-pr-gate.mjs   (exit 1 on any failure)
 */
import assert from 'node:assert/strict';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

await check('critical module graph imports', async () => {
  await import('../src/data/manager.js');
  await import('../src/data/layerManifest.js');
  await import('../src/data/layerState.js');
  await import('../src/data/layerAccess.js');
  await import('../src/data/feedScheduler.js');
  await import('../src/data/feedCache.js');
  await import('../src/data/detectionDraw.js');
  await import('../src/quality/adaptiveQuality.js');
  await import('../src/renderGovernor.js');
  await import('../src/lanToken.js');
});

await check('lazy layer manifest matches persistence registry', async () => {
  const { LAZY_LAYER_MANIFEST } = await import('../src/data/layerManifest.js');
  const { LAYER_STATE_REGISTRY } = await import('../src/data/layerState.js');
  const manifestIds = new Set(LAZY_LAYER_MANIFEST.map((entry) => entry.id));
  const registryIds = new Set(LAYER_STATE_REGISTRY.map((entry) => entry.id));
  assert.deepEqual([...manifestIds].filter((id) => !registryIds.has(id)), []);
  assert.deepEqual([...registryIds].filter((id) => !manifestIds.has(id)), []);
});

await check('OpenAI Realtime tool schema validates', async () => {
  const { GEV_REALTIME_TOOLS } = await import('../src/voice/realtimeTools.js');
  assert.ok(Array.isArray(GEV_REALTIME_TOOLS) && GEV_REALTIME_TOOLS.length > 0, 'tools array non-empty');
  const names = new Set();
  for (const tool of GEV_REALTIME_TOOLS) {
    assert.equal(tool.type, 'function', `tool ${tool.name}: type === 'function'`);
    assert.equal(typeof tool.name, 'string', 'tool name is a string');
    assert.ok(/^[a-z0-9_]+$/.test(tool.name), `tool name ${tool.name} matches OpenAI grammar`);
    assert.ok(!names.has(tool.name), `tool name ${tool.name} unique`);
    names.add(tool.name);
    assert.equal(typeof tool.description, 'string', `tool ${tool.name}: description`);
    assert.ok(tool.description.length > 10, `tool ${tool.name}: description non-trivial`);
    if (tool.parameters !== undefined) {
      assert.equal(tool.parameters.type, 'object', `tool ${tool.name}: parameters.type object`);
    }
  }
});

await check('manager round-trips a mock layer lifecycle', async () => {
  const { DataLayerManager } = await import('../src/data/manager.js');
  const calls = { init: 0, enable: 0, update: 0, disable: 0, destroy: 0 };
  const layer = {
    id: 'smoke-layer',
    name: 'Smoke Layer',
    icon: '',
    source: 'test',
    async init() { calls.init += 1; },
    async enable() { calls.enable += 1; },
    async update() { calls.update += 1; return true; },
    async disable() { calls.disable += 1; },
    async destroy() { calls.destroy += 1; },
    getStats() { return { count: 0, lastUpdate: null }; },
  };
  const manager = new DataLayerManager({});
  manager.register(layer);
  manager.finalizeRegistrations([{ id: 'smoke-layer', disposition: 'enabled-only' }]);
  assert.equal(await manager.setEnabled('smoke-layer', true, { origin: 'smoke' }), true);
  assert.equal(manager.isEnabled('smoke-layer'), true);
  assert.ok(calls.init >= 1 && calls.enable >= 1 && calls.update >= 1, 'lifecycle hooks ran');
  assert.equal(await manager.setEnabled('smoke-layer', false, { origin: 'smoke' }), true);
  assert.equal(manager.isEnabled('smoke-layer'), false);
  assert.ok(calls.disable >= 1, 'disable ran');
  manager._disarmUpdateLoop(manager.layers.get('smoke-layer'));
});

let failed = 0;
for (const { name, ok, error } of results) {
  if (ok) {
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✖ ${name}`);
    console.error(`    ${error?.message || error}`);
  }
}
console.log(`\nsmoke-pr-gate: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
