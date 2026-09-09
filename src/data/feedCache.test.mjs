import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWithCache,
  fetchJsonWithCache,
  clearFeedCache,
  _resetFeedCacheForTest,
} from './feedCache.js';

beforeEach(() => {
  _resetFeedCacheForTest();
});

function jsonResponse(body, { status = 200, etag = null, headers } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const h = {
    get(name) {
      if (headers && name in headers) return headers[name];
      if (name === 'etag' && etag) return etag;
      return null;
    },
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: h,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

test('successful GET is stored and re-served fresh within TTL', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return jsonResponse({ value: 42 }); };
  const first = await fetchWithCache('https://x.test/feed');
  assert.equal(first.ok, true);
  assert.equal(first.fromCache, false);
  const second = await fetchWithCache('https://x.test/feed');
  assert.equal(second.fromCache, true, 'within TTL the cache answers');
  assert.equal(second.json.value, 42);
  assert.equal(calls, 1, 'only one upstream call');
  delete globalThis.fetch;
});

test('an ETag round-trip turns 304 into a zero-byte refresh', async () => {
  let calls = 0;
  let etagPhase = 'first';
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ value: 1 }, { etag: 'W/"v1"' });
    return { ok: true, status: 304, headers: { get: () => null }, text: async () => '' };
  };
  await fetchWithCache('https://x.test/etag');
  etagPhase = 'revalidate';
  const second = await fetchWithCache('https://x.test/etag');
  assert.equal(second.status, 304);
  assert.equal(second.fromCache, true);
  assert.equal(second.json.value, 1, 'cached body re-served on 304');
  assert.equal(etagPhase, 'revalidate');
  delete globalThis.fetch;
});

test('upstream 5xx serves the last good payload marked stale', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ value: 'good' });
    return jsonResponse({ error: 'down' }, { status: 503 });
  };
  await fetchWithCache('https://x.test/stale', { ttlMs: 0 });
  const second = await fetchWithCache('https://x.test/stale', { ttlMs: 0 });
  assert.equal(second.ok, true, 'failure resolves stale data instead of throwing');
  assert.equal(second.stale, true);
  assert.equal(second.json.value, 'good');
  delete globalThis.fetch;
});

test('network failure serves stale; a cold miss resolves ok:false', async () => {
  globalThis.fetch = async () => jsonResponse({ value: 'first' });
  await fetchWithCache('https://x.test/net', { ttlMs: 0 });
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  const stale = await fetchWithCache('https://x.test/net', { ttlMs: 0 });
  assert.equal(stale.stale, true);
  assert.equal(stale.json.value, 'first');
  const cold = await fetchWithCache('https://x.test/never-seen', { ttlMs: 0 });
  assert.equal(cold.ok, false);
  assert.equal(cold.text, '');
  delete globalThis.fetch;
});

test('AbortError propagates instead of serving stale', async () => {
  globalThis.fetch = async () => jsonResponse({ value: 'x' });
  await fetchWithCache('https://x.test/abort', { ttlMs: 0 });
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  await assert.rejects(
    () => fetchWithCache('https://x.test/abort', { ttlMs: 0, signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
  delete globalThis.fetch;
});

test('fetchJsonWithCache exposes the parsed payload and staleness flag', async () => {
  globalThis.fetch = async () => jsonResponse({ list: [1, 2, 3] });
  const { json, stale, hit } = await fetchJsonWithCache('https://x.test/json');
  assert.deepEqual(json.list, [1, 2, 3]);
  assert.equal(stale, false);
  assert.equal(hit, true);
  delete globalThis.fetch;
});

test('entries beyond maxStaleMs are treated as misses, not resurrected', async () => {
  globalThis.fetch = async () => jsonResponse({ value: 'ancient' });
  // Store with a storedAt far in the past by using a TTL of 1ms and waiting.
  await fetchWithCache('https://x.test/old', { ttlMs: 1, maxStaleMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  const result = await fetchWithCache('https://x.test/old', { ttlMs: 1, maxStaleMs: 1 });
  assert.equal(result.ok, false, 'ancient entries do not resurrect as stale');
  delete globalThis.fetch;
});

test('non-GET methods bypass the cache entirely', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return jsonResponse({ ok: true }); };
  await fetchWithCache('https://x.test/post', { method: 'POST' });
  await fetchWithCache('https://x.test/post', { method: 'POST' });
  assert.equal(calls, 2, 'both calls hit the network');
  delete globalThis.fetch;
});
