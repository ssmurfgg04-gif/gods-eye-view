// OVERPASS PROXY — which upstream answers count as an answer.
//
// One predicate governs cache reads, writes, and stale fallback. A mirror's
// refusal must neither end the search for healthy alternatives nor persist as
// data under the week/month-long cache TTLs. These cases use no live providers.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import createViteConfig, { fetchOverpassPayload, fetchOsmMapRoadPayload, overpassPayloadIsData, parseOsmMapRoads, readOverpassDisk } from '../vite.config.js';

const ENDPOINTS = ['https://a.example/api', 'https://b.example/api', 'https://c.example/api'];

/** Answer each endpoint from a map of url → {status, body}; record the order. */
function mirrors(byUrl) {
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(url);
    const answer = byUrl[url];
    if (answer instanceof Error) throw answer;
    return { status: answer.status, headers: { get: () => answer.contentType || 'application/json' } };
  };
  return { fetchImpl, tried, readBody: async (_, __) => byUrl[tried[tried.length - 1]]?.body ?? '' };
}

const run = (byUrl) => {
  const m = mirrors(byUrl);
  return fetchOverpassPayload('data=x', 1e6, {
    endpoints: ENDPOINTS,
    fetchImpl: m.fetchImpl,
    readBody: m.readBody,
    simplify: (body) => body,
  }).then((payload) => ({ payload, tried: m.tried }), (error) => ({ error, tried: m.tried }));
};

const DATA = { status: 200, body: '{"elements":[]}' };

test('disk cache rejects old refusals for fresh and stale reads but preserves last-good data', async () => {
  const key = `overpass-cache-regression-${randomUUID()}`;
  const directory = path.join(process.cwd(), '.gev-cache', 'overpass');
  const file = path.join(directory, `${createHash('sha1').update(key).digest('hex')}.json`);
  await mkdir(directory, { recursive: true });
  try {
    for (const refusal of [
      { status: 406 }, { status: 429 }, { status: 503 },
      { status: 200, rateLimited: true }, { status: 200, runtimeError: true },
    ]) {
      await writeFile(file, JSON.stringify({ ...DATA, cachedAt: Date.now(), ...refusal }));
      assert.equal(await readOverpassDisk(key, 60000), null, `fresh ${JSON.stringify(refusal)}`);
      assert.equal(await readOverpassDisk(key, Infinity), null, `stale ${JSON.stringify(refusal)}`);
    }
    const good = { ...DATA, cachedAt: Date.now() - 120000 };
    await writeFile(file, JSON.stringify(good));
    assert.equal(await readOverpassDisk(key, 60000), null, 'expired good data misses normal TTL');
    assert.deepEqual(await readOverpassDisk(key, Infinity), good, 'last-good data survives an outage');
    await writeFile(file, '{invalid');
    assert.equal(await readOverpassDisk(key, Infinity), null, 'corrupt cache is ignored');
  } finally {
    await unlink(file);
  }
});

// ── The predicate ────────────────────────────────────────────────────────────

test('only a 2xx that is neither rate-limited nor a runtime error is data', () => {
  assert.equal(overpassPayloadIsData({ status: 200 }), true);
  assert.equal(overpassPayloadIsData({ status: 204 }), true);

  // The measured refusal, and its neighbours. `< 500` admitted every one.
  for (const status of [400, 403, 406, 410, 429]) {
    assert.equal(overpassPayloadIsData({ status }), false, `${status} is not data`);
  }
  assert.equal(overpassPayloadIsData({ status: 502 }), false);
  // A 200 can still not be data: Overpass reports runtime failures in the body.
  assert.equal(overpassPayloadIsData({ status: 200, runtimeError: true }), false);
  assert.equal(overpassPayloadIsData({ status: 200, rateLimited: true }), false);
  assert.equal(overpassPayloadIsData({}), false);
  assert.equal(overpassPayloadIsData(null), false);
});

// ── The fan-out ──────────────────────────────────────────────────────────────

test('a refusal moves to the next mirror instead of ending the fan-out', async () => {
  // The exact shape measured against the live mirrors.
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: { status: 406, contentType: 'text/html', body: '<!DOCTYPE HTML><title>406</title>' },
    [ENDPOINTS[1]]: DATA,
    [ENDPOINTS[2]]: DATA,
  });

  assert.equal(payload.status, 200);
  assert.equal(payload.endpoint, ENDPOINTS[1]);
  assert.deepEqual(tried, ENDPOINTS.slice(0, 2), 'the healthy mirror must be reached, and no further');
});

test('the first mirror to answer wins, and the rest are left alone', async () => {
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: DATA, [ENDPOINTS[1]]: DATA, [ENDPOINTS[2]]: DATA,
  });

  assert.equal(payload.endpoint, ENDPOINTS[0]);
  assert.deepEqual(tried, [ENDPOINTS[0]]);
});

test('a refusal every mirror agrees on is reported, not swallowed', async () => {
  // A genuinely bad query must still say what upstream said — but only after
  // every mirror has had its chance to answer it.
  const refusal = { status: 400, body: 'line 1: parse error' };
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: refusal, [ENDPOINTS[1]]: refusal, [ENDPOINTS[2]]: refusal,
  });

  assert.equal(payload.status, 400);
  assert.equal(payload.endpoint, ENDPOINTS[0], 'the FIRST refusal is the one reported');
  assert.deepEqual(tried, ENDPOINTS);
  assert.equal(overpassPayloadIsData(payload), false, 'so it is neither cached nor served as data');
});

test('a mirror that throws is no different from one that refuses', async () => {
  const { payload, tried } = await run({
    [ENDPOINTS[0]]: new Error('ECONNRESET'),
    [ENDPOINTS[1]]: { status: 503, body: 'busy' },
    [ENDPOINTS[2]]: DATA,
  });

  assert.equal(payload.endpoint, ENDPOINTS[2]);
  assert.deepEqual(tried, ENDPOINTS);
});

test('when every mirror is unreachable the caller gets a throw, not a payload', async () => {
  const { error, payload } = await run({
    [ENDPOINTS[0]]: new Error('ECONNRESET'),
    [ENDPOINTS[1]]: new Error('ETIMEDOUT'),
    [ENDPOINTS[2]]: new Error('ENOTFOUND'),
  });

  assert.equal(payload, undefined);
  assert.match(error.message, /ENOTFOUND/);
});

test('production reader rotates past oversized, runtime-error and rate-limited bodies', async () => {
  for (const [status, body] of [
    [200, 'x'.repeat(200)], [200, '{"remark":"runtime error: timed out","elements":[]}'],
    [200, 'rate_limited'], [429, 'busy'], [403, 'forbidden'],
  ]) {
    const tried = [];
    const payload = await fetchOverpassPayload('data=x', 100, {
      endpoints: ENDPOINTS,
      fetchImpl: async (url) => {
        tried.push(url);
        return new Response(tried.length === 1 ? body : DATA.body, {
          status: tried.length === 1 ? status : 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.equal(payload.body, DATA.body);
    assert.deepEqual(tried, ENDPOINTS.slice(0, 2));
  }
});

function proxyHandler() {
  const plugin = createViteConfig({ mode: 'test' }).plugins.find(p => p.name === 'overpass-proxy');
  const routes = new Map();
  plugin.configureServer({ middlewares: { use: (route, handler) => routes.set(route, handler) } });
  return routes.get('/api/overpass');
}

function invoke(handler, body) {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, headers: this.headers, body }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('coalesced outage callers both receive last-good data, never a cached refusal', async (t) => {
  const handler = proxyHandler();
  for (const status of [406, 503, 429]) {
    const query = `[out:json][timeout:12];node(around:10,30.27,-97.74)["name"="${randomUUID()}"];out;`;
    const body = `data=${encodeURIComponent(query)}`;
    const directory = path.join(process.cwd(), '.gev-cache', 'overpass');
    const file = path.join(directory, `${createHash('sha1').update(body).digest('hex')}.json`);
    await mkdir(directory, { recursive: true });
    const stale = { ...DATA, cachedAt: Date.now() - 40 * 86400000 };
    await writeFile(file, JSON.stringify(stale));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let fetches = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      fetches++;
      entered.resolve();
      await release.promise;
      return new Response('upstream unavailable', { status });
    });
    try {
      const first = invoke(handler, body);
      await entered.promise;
      const second = invoke(handler, body);
      // The second request consumes its in-memory stream and joins the pending
      // promise before releasing upstream. No network or elapsed-time sleep.
      await new Promise(resolve => setImmediate(resolve));
      release.resolve();
      for (const response of await Promise.all([first, second])) {
        assert.equal(response.status, 200, `${status}: both callers use last-good data`);
        assert.equal(response.body, DATA.body);
        assert.equal(response.headers['X-Overpass-Cache'], 'STALE');
      }
      assert.equal(fetches, 4, 'one shared, bounded mirror sequence');
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), stale);
    } finally {
      release.resolve();
      mock.mock.restore();
      await unlink(file);
    }
  }
});

const OSM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="30.267" lon="-97.743"/>
  <node id="2" lat="30.268" lon="-97.744"/>
  <node id="3" lat="30.269" lon="-97.745"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/>
    <tag k="name" v="Congress &amp; 6th"/>
  </way>
  <way id="11">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="motorway"/>
  </way>
  <way id="12">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="footway"/>
  </way>
  <way id="13">
    <nd ref="1"/>
    <tag k="highway" v="residential"/>
  </way>
</osm>`;

function trafficBody(bounds = '30.26,-97.75,30.28,-97.73') {
  const [s, w, n, e] = bounds.split(',');
  const q = `[out:json][timeout:25];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$"](${s},${w},${n},${e}););out geom qt;`;
  return `data=${encodeURIComponent(q)}`;
}

test('OSM map XML parses into the Overpass-like way shape traffic.js consumes', () => {
  const payload = parseOsmMapRoads(OSM_XML);
  assert.equal(payload.version, 0.6);
  assert.equal(payload.elements.length, 2, 'footway filtered, single-node way dropped');
  const residential = payload.elements.find((el) => el.id === '10');
  assert.equal(residential.tags.name, 'Congress & 6th', 'XML entities decoded');
  assert.deepEqual(residential.geometry[0], { lat: 30.267, lon: -97.743 });
  assert.equal(residential.geometry.length, 3);
});

test('OSM map fetch serves traffic queries and ignores everything else', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    return { ok: true, text: async () => OSM_XML, json: async () => ({}) };
  };
  const readBody = async (response) => response.text();
  const payload = await fetchOsmMapRoadPayload(trafficBody(), 1024 * 1024, { fetchImpl, readBody });
  assert.equal(payload.status, 200);
  assert.equal(payload.endpoint, 'https://api.openstreetmap.org/api/0.6/map');
  assert.ok(seen[0].includes('bbox='), 'viewport bbox forwarded to the map API');
  assert.equal(JSON.parse(payload.body).elements.length, 2);

  // Non-traffic queries (installations, annotations) stay on generic Overpass.
  assert.equal(await fetchOsmMapRoadPayload('data=' + encodeURIComponent('[out:json];node["military"](1,2,3,4);out;'), 1024, { fetchImpl, readBody }), null);
  assert.equal(await fetchOsmMapRoadPayload('data=' + encodeURIComponent('[out:json];(way["highway"~"^(motorway)$"](91,0,92,0););out;'), 1024, { fetchImpl, readBody }), null, 'out-of-range bbox rejected');
  assert.equal(await fetchOsmMapRoadPayload('garbage', 1024, { fetchImpl, readBody }), null);
});

test('OSM map failures surface instead of poisoning the fallback', async () => {
  const failing = async () => ({ ok: false, status: 503, text: async () => 'busy' });
  await assert.rejects(
    fetchOsmMapRoadPayload(trafficBody(), 1024 * 1024, { fetchImpl: failing, readBody: async (r) => r.text() }),
    /OSM map returned 503/,
  );
  const badXml = async () => ({ ok: true, text: async () => '<html>nope</html>' });
  await assert.rejects(
    fetchOsmMapRoadPayload(trafficBody(), 1024 * 1024, { fetchImpl: badXml, readBody: async (r) => r.text() }),
    /invalid XML/,
  );
});
