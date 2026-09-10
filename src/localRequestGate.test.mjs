import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitSameSiteRequest } from './localRequestGate.mjs';

const LOCAL = {
  hostHeader: 'localhost:4173',
  origin: 'http://localhost:4173',
  secFetchSite: 'same-origin',
};

test('the honest same-origin browser request is admitted', () => {
  assert.deepEqual(admitSameSiteRequest({ ...LOCAL }), { ok: true });
});

test('headerless Node clients (QA harnesses, curl) are admitted', () => {
  assert.deepEqual(
    admitSameSiteRequest({ hostHeader: 'localhost:4173' }),
    { ok: true },
  );
});

test('cross-site fetch and same-site fetch are refused', () => {
  for (const site of ['cross-site', 'same-site']) {
    const verdict = admitSameSiteRequest({
      hostHeader: 'localhost:4173',
      origin: 'https://evil.example',
      secFetchSite: site,
    });
    assert.equal(verdict.ok, false, site);
    assert.equal(verdict.status, 403, site);
  }
});

test('img-style requests (no Origin, cross-site) are refused', () => {
  const verdict = admitSameSiteRequest({
    hostHeader: 'localhost:4173',
    secFetchSite: 'cross-site',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 403);
});

test('Sec-Fetch-Site none is admitted (browser navigation edge)', () => {
  assert.deepEqual(
    admitSameSiteRequest({ hostHeader: 'localhost:4173', secFetchSite: 'none' }),
    { ok: true },
  );
});

test('foreign Origin with same-origin site header is still refused', () => {
  const verdict = admitSameSiteRequest({
    hostHeader: 'localhost:4173',
    origin: 'https://evil.example',
    secFetchSite: 'same-origin',
  });
  assert.equal(verdict.ok, false, 'a lying site header does not rescue a foreign Origin');
});

test('opaque Origin is refused', () => {
  assert.equal(
    admitSameSiteRequest({ hostHeader: 'localhost:4173', origin: 'not a url' }).ok,
    false,
  );
  assert.equal(
    admitSameSiteRequest({ hostHeader: 'localhost:4173', origin: 'null' }).ok,
    false,
  );
});

test('cross-port Origins are foreign; cross-scheme same-host is same-site', () => {
  assert.equal(
    admitSameSiteRequest({ ...LOCAL, origin: 'http://localhost:4174' }).ok,
    false,
    'a different port is a different host',
  );
  // Foreignness is host-based (matching #242 and the credential gate's Host
  // check): https-to-http on the same host is same-site, not cross-site.
  assert.deepEqual(
    admitSameSiteRequest({ ...LOCAL, origin: 'https://localhost:4173' }),
    { ok: true },
  );
});

test('LAN opt-in Origin matching its Host is admitted', () => {
  assert.deepEqual(
    admitSameSiteRequest({
      hostHeader: '192.168.1.20:4173',
      origin: 'http://192.168.1.20:4173',
      secFetchSite: 'same-origin',
    }),
    { ok: true },
  );
});

test('reverse-proxy signal headers refuse regardless of socket story', () => {
  for (const header of ['x-forwarded-for', 'forwarded', 'via', 'cf-ray']) {
    const verdict = admitSameSiteRequest({
      ...LOCAL,
      proxyHeaders: { [header]: 'anything' },
    });
    assert.equal(verdict.ok, false, header);
    assert.equal(verdict.status, 403, header);
  }
  assert.deepEqual(
    admitSameSiteRequest({ ...LOCAL, proxyHeaders: { 'x-forwarded-for': '' } }),
    { ok: true },
    'empty proxy header values are not signals',
  );
});

test('proxy header names match case-insensitively', () => {
  assert.equal(
    admitSameSiteRequest({ ...LOCAL, proxyHeaders: { 'X-Forwarded-For': '1.2.3.4' } }).ok,
    false,
  );
});

test('missing Host with a present Origin is refused', () => {
  assert.equal(
    admitSameSiteRequest({ origin: 'http://localhost:4173', secFetchSite: 'same-origin' }).ok,
    false,
  );
});
