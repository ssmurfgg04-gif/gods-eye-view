import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFirmsSourceResult } from '../../vite.config.js';

test('source success is recorded only after its rows are appended', () => {
  const sources = [];
  const fires = [];
  appendFirmsSourceResult(sources, fires, 'VIIRS_NOAA20_NRT', [{ id: 1 }, { id: 2 }]);
  assert.equal(fires.length, 2);
  assert.deepEqual(sources, [{ source: 'VIIRS_NOAA20_NRT', count: 2, ok: true }]);
});

test('an aggregation failure reports failure without a contradictory success', () => {
  const sources = [];
  function* throwingRows() {
    yield { id: 1 };
    throw new Error('aggregation blew up mid-append');
  }
  assert.throws(() => appendFirmsSourceResult(sources, [], 'VIIRS_SNPP_NRT', throwingRows()));
  assert.deepEqual(sources, [], 'no success entry for the failed source');
});
