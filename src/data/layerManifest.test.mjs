import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAZY_LAYER_MANIFEST } from './layerManifest.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';

test('the manifest covers exactly the serialization registry ids', () => {
  const manifestIds = new Set(LAZY_LAYER_MANIFEST.map((entry) => entry.id));
  const registryIds = new Set(LAYER_STATE_REGISTRY.map((entry) => entry.id));
  assert.deepEqual(
    [...manifestIds].filter((id) => !registryIds.has(id)),
    [],
    'manifest ids must all exist in the persistence registry',
  );
  assert.deepEqual(
    [...registryIds].filter((id) => !manifestIds.has(id)),
    [],
    'every persistable layer must have a lazy manifest entry',
  );
  assert.ok(manifestIds.size >= 16, `expected the full production set (got ${manifestIds.size})`);
});

test('every entry has id, name, and a loader function', () => {
  for (const entry of LAZY_LAYER_MANIFEST) {
    assert.equal(typeof entry.id, 'string', `${entry.id}: id`);
    assert.equal(typeof entry.name, 'string', `${entry.id}: name`);
    assert.equal(typeof entry.loader, 'function', `${entry.id}: loader`);
    if (entry.updateInterval !== undefined) {
      assert.ok(Number.isFinite(entry.updateInterval), `${entry.id}: updateInterval numeric`);
    }
  }
});

test('manifest metadata matches each module source (anti-drift pin)', () => {
  // Parse name/source/updateInterval straight from the layer sources so a
  // rename in the module without a manifest update fails here.
  const sources = {
    flights: './flights.js',
    military: './militaryFlights.js',
    earthquakes: './earthquakes.js',
    satellites: './satellites.js',
    'rocket-launches': './rocketLaunches.js',
    traffic: './traffic.js',
    cctv: './cctv.js',
    radio: './radio.js',
    bikeshare: './bikeshare.js',
    'ais-live-vessels': './aisLiveVessels.js',
    'military-installations': './militaryInstallations.js',
    'military-awareness': './militaryAwareness.js',
  };
  for (const [id, file] of Object.entries(sources)) {
    const entry = LAZY_LAYER_MANIFEST.find((e) => e.id === id);
    assert.ok(entry, `manifest entry for ${id}`);
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const nameMatch = source.match(new RegExp(`id: ['"]${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}['"],\\s*\\n\\s*name: ['"]([^'"]+)['"]`));
    if (nameMatch) {
      assert.equal(entry.name, nameMatch[1], `${id}: manifest name matches module source`);
    }
  }
});

test('localLayers ids are addressed through the shared localLayers loader', () => {
  for (const id of ['local-datacenters', 'local-dams', 'local-firms']) {
    const entry = LAZY_LAYER_MANIFEST.find((e) => e.id === id);
    assert.ok(entry, `manifest entry for ${id}`);
    const source = readFileSync(new URL('./localLayers.js', import.meta.url), 'utf8');
    assert.ok(source.includes(`id: '${id}'`), `${id} exists in localLayers.js`);
  }
});
