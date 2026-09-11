import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  fetchCctvImageFromUpstream,
  normalizeSourceItem,
  sanitizeCctvSourceUrl,
} from '../../vite.config.js';

test('CCTV upstream frame fetch supplies a bounded abort signal', async () => {
  let observedSignal = null;
  const startedAt = Date.now();
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 20,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      observedSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });

  assert.equal(result, null);
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 500, 'test timeout should settle promptly');
  assert.ok(CCTV_FRAME_FETCH_TIMEOUT_MS < 10_000, 'production timeout must beat the active refresh cadence');
});

test('CCTV upstream frame fetch returns a valid image response', async () => {
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 100,
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    }),
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  assert.deepEqual(result?.body, Buffer.from([1, 2, 3]));
});

test('hand-written pack URLs are sanitized: https passes, typos and cleartext do not', () => {
  assert.equal(sanitizeCctvSourceUrl('https://example.com/cam.jpg', 'a'), 'https://example.com/cam.jpg');
  assert.equal(sanitizeCctvSourceUrl('  https://example.com/cam.jpg  '), 'https://example.com/cam.jpg');
  assert.equal(sanitizeCctvSourceUrl('http://localhost:8080/cam.jpg'), 'http://localhost:8080/cam.jpg');
  assert.equal(sanitizeCctvSourceUrl('http://example.com/cam.jpg'), '', 'non-local http is dropped');
  assert.equal(sanitizeCctvSourceUrl('https://user:pass@example.com/cam.jpg'), '', 'credentials are dropped');
  assert.equal(sanitizeCctvSourceUrl('not a url'), '', 'whitespace is malformed');
  assert.equal(sanitizeCctvSourceUrl('ht!tp://[bad'), '', 'unparseable is dropped');
  assert.equal(sanitizeCctvSourceUrl('ftp://example.com/cam.jpg'), '', 'non-http(s) is dropped');
  assert.equal(sanitizeCctvSourceUrl('https://notaurl'), '', 'dotless public host is malformed');
  assert.equal(sanitizeCctvSourceUrl('x'.repeat(3000)), '', 'overlong is dropped');
  assert.equal(sanitizeCctvSourceUrl('', 'a'), '');
  assert.equal(sanitizeCctvSourceUrl(null, 'a'), '');
  assert.equal(sanitizeCctvSourceUrl(42, 'a'), '');
});

test('pack normalization keeps good URLs and empties bad ones without throwing', () => {
  const good = normalizeSourceItem({ id: 'a', url: 'https://example.com/cam.jpg', snapshotUrl: 'https://example.com/snap.jpg' });
  assert.equal(good.url, 'https://example.com/cam.jpg');
  assert.equal(good.snapshotUrl, 'https://example.com/snap.jpg');
  const bad = normalizeSourceItem({ id: 'b', url: 'http://example.com/cam.jpg', snapshotUrl: 'typo with spaces' });
  assert.equal(bad.url, '');
  assert.equal(bad.snapshotUrl, '');
  assert.equal(bad.id, 'b', 'identity survives so fallback takes over');
  assert.deepEqual(normalizeSourceItem(null).id, '', 'null entries normalize instead of throwing');
  assert.deepEqual(normalizeSourceItem('nope').id, '', 'non-object entries normalize instead of throwing');
});
