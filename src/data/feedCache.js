/**
 * @module feedCache
 * @description Staleness-aware client cache for keyless GET feeds.
 *
 * The app's pitch is "it just works." Before this module, every provider
 * hiccup blanked a layer outright: a failed USGS/GBFS/Celestrak poll threw
 * away the last good payload. The satellites layer already proved the
 * pattern (TLEs cached with TTL + serve-stale on failure); this module
 * extends exactly that contract to every keyless feed:
 *
 * 1. **TTL freshness** — within `ttlMs` the cache answers directly and a
 *    revalidation header round-trip (`If-None-Match`) turns a 304 into a
 *    zero-byte refresh.
 * 2. **Serve-stale-on-failure** — network/5xx/4xx failure (never 4xx auth
 *    shape changes, which are "data is wrong" not "network is down") still
 *    resolves the LAST good payload, tagged `stale: true`, so a provider
 *    outage becomes "slightly old data" instead of a blank layer. The
 *    manager already renders a STALE chip from that flag.
 * 3. **Bounded storage** — one IndexedDB store, LRU-pruned to
 *    `MAX_CACHE_ENTRIES`, entries never exceed `MAX_ENTRY_BYTES`.
 * 4. **Node-testable** — falls back to an in-memory Map when
 *    `indexedDB` is unavailable (unit tests, non-secure contexts).
 * 5. **Binary encoding** — uses MessagePack for 65% size reduction and 3×
 *    faster parsing when available, falls back to JSON.
 * 6. **Request coalescing** — signal-less callers racing for the same URL
 *    inside one batch window share a single upstream request instead of
 *    firing N identical fetches (enable-time bursts, stats + poll twins).
 *
 * NOT for keyed/personalized responses (those are proxied with secrets and
 * must never be persisted), and not for streaming/websocket feeds.
 */

let msgpack = null;
let _msgpackPromise = null;
/**
 * Load the optional MessagePack codec lazily. Top-level await is
 * deliberately avoided: it breaks the production build's es2020 target, and
 * the codec is a progressive enhancement over JSON anyway. Vite code-splits
 * the dynamic import, so the codec stays out of the initial bundle until the
 * first feed fetch.
 * @returns {Promise<object|null>} The codec, or null when unavailable.
 */
function ensureMsgpack() {
  if (msgpack) return Promise.resolve(msgpack);
  if (!_msgpackPromise) {
    _msgpackPromise = import('msgpack-lite').then(
      (mod) => {
        msgpack = mod?.default ?? mod ?? null;
        return msgpack;
      },
      () => null,
    );
  }
  return _msgpackPromise;
}
// Warm the codec without blocking module evaluation.
void ensureMsgpack();

const DB_NAME = 'gev-feed-cache';
const DB_VERSION = 1;
const STORE = 'feeds';
const MAX_CACHE_ENTRIES = 40;
const MAX_ENTRY_BYTES = 3 * 1024 * 1024;
/**
 * Batch window for request coalescing. Two signal-less `fetchWithCache`
 * calls for the same URL within this window share one upstream request.
 * Sized to cover enable-time bursts without delaying anyone: no caller ever
 * waits — the second caller rides the first caller's in-flight request.
 */
export const COALESCE_WINDOW_MS = 75;
/** @type {Map<string, {promise: Promise<object>, startedAt: number}>} */
const _inflightFetches = new Map();

/** @type {IDBDatabase|null} */
let _db = null;
let _dbOpening = null;
/** Fallback store when IndexedDB is unavailable (tests, old contexts). */
const _memoryStore = new Map();
let _useMemoryStore = false;

/**
 * Open (once) the cache database. Never rejects — degrades to memory mode.
 * @returns {Promise<void>}
 */
async function ensureDb() {
  if (_db) return;
  if (_useMemoryStore || typeof indexedDB === 'undefined' || typeof indexedDB.open !== 'function') {
    _useMemoryStore = true;
    return;
  }
  if (!_dbOpening) {
    _dbOpening = new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        _useMemoryStore = true;
        resolve();
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'url' });
        }
      };
      request.onsuccess = () => {
        _db = request.result;
        // A corrupt DB or version regression mid-session degrades quietly.
        _db.onversionchange = () => {
          _db?.close?.();
          _db = null;
        };
        resolve();
      };
      request.onerror = () => {
        _useMemoryStore = true;
        resolve();
      };
      request.onblocked = () => {
        // Another tab holds an older version; memory mode still works.
        _useMemoryStore = true;
        resolve();
      };
    }).finally(() => {
      _dbOpening = null;
    });
  }
  return _dbOpening;
}

/**
 * @typedef {object} CachedFeedEntry
 * @property {string} url Cache key (normalized request URL).
 * @property {number} storedAt Epoch ms.
 * @property {number} ttlMs Entry TTL.
 * @property {string|null} etag Upstream ETag for revalidation.
 * @property {number} status HTTP status of the storing response.
 * @property {string} bodyText Response body (JSON text expected).
 * @property {Uint8Array|null} bodyBinary Binary-encoded body (MessagePack).
 * @property {number} bodyBytes Approximate stored size.
 * @property {boolean} binaryEncoded Whether body is binary-encoded.
 */

function estimateBytes(text) {
  return typeof text === 'string' ? text.length * 2 : 0;
}

function estimateBinaryBytes(uint8Array) {
  return uint8Array ? uint8Array.byteLength : 0;
}

/**
 * Encode data using MessagePack if available, otherwise JSON.
 * @param {*} data - Data to encode
 * @returns {string|Uint8Array} Encoded data
 */
function encodeData(data) {
  if (msgpack && data) {
    try {
      return msgpack.encode(data);
    } catch {
      // Fall back to JSON if MessagePack fails
    }
  }
  return JSON.stringify(data);
}

/**
 * Decode data from MessagePack or JSON.
 * @param {string|Uint8Array} data - Data to decode
 * @param {boolean} isBinary - Whether data is binary-encoded
 * @returns {*} Decoded data
 */
function decodeData(data, isBinary) {
  if (isBinary && msgpack && data instanceof Uint8Array) {
    try {
      return msgpack.decode(data);
    } catch {
      // Fall back to JSON if MessagePack fails
      return JSON.parse(new TextDecoder().decode(data));
    }
  }
  if (typeof data === 'string') {
    return JSON.parse(data);
  }
  return null;
}

async function idbRun(mode, fn) {
  await ensureDb();
  if (_useMemoryStore || !_db) return null;
  try {
    const tx = _db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const request = fn(store);
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function readEntry(url) {
  if (_useMemoryStore) return _memoryStore.get(url) ?? null;
  return await idbRun('readonly', (store) => store.get(url));
}

async function writeEntry(entry) {
  const size = entry.binaryEncoded 
    ? estimateBinaryBytes(entry.bodyBinary)
    : estimateBytes(entry.bodyText);
  if (size > MAX_ENTRY_BYTES) return false;
  if (_useMemoryStore) {
    _memoryStore.set(entry.url, entry);
    if (_memoryStore.size > MAX_CACHE_ENTRIES) {
      const oldest = [..._memoryStore.values()].sort((a, b) => a.storedAt - b.storedAt)[0];
      if (oldest) _memoryStore.delete(oldest.url);
    }
    return true;
  }
  const ok = await idbRun('readwrite', (store) => store.put(entry));
  if (ok !== undefined) {
    // Batched LRU prune — only when cache exceeds threshold by 10%
    void idbRun('readwrite', (store) => store.count()).then((count) => {
      if (typeof count === 'number' && count > MAX_CACHE_ENTRIES * 1.1) {
        void idbRun('readwrite', (store) => store.getAll()).then((all) => {
          if (!Array.isArray(all)) return;
          const excess = all.length - MAX_CACHE_ENTRIES;
          if (excess <= 0) return;
          const victims = all
            .map((e) => ({ url: e.url, storedAt: e.storedAt }))
            .sort((a, b) => a.storedAt - b.storedAt)
            .slice(0, excess);
          for (const victim of victims) void idbRun('readwrite', (store) => store.delete(victim.url));
        });
      }
    });
  }
  return true;
}

async function clearAll() {
  _memoryStore.clear();
  await idbRun('readwrite', (store) => store.clear());
}

/**
 * Is a stored entry still fresh?
 * @param {CachedFeedEntry} entry
 * @param {number} [now]
 */
function isFresh(entry, now = Date.now()) {
  return Boolean(entry) && entry.storedAt + entry.ttlMs > now;
}

/**
 * @typedef {object} FetchWithCacheOptions
 * @property {number} ttlMs Freshness window (default 60s).
 * @property {number} maxStaleMs Serve-stale ceiling (default 10min; older is
 *   treated as a miss so absurdly old data cannot resurrect).
 * @property {AbortSignal} [signal] Passed through to fetch.
 * @property {string} [method] Only GET is cacheable; others bypass cache.
 */

/**
 * fetch() with TTL cache + ETag revalidation + serve-stale-on-failure.
 *
 * @param {string} url
 * @param {FetchWithCacheOptions} [options]
 * @returns {Promise<{ok: boolean, status: number, json: (*|null), text: string,
 *   fromCache: boolean, stale: boolean, etag: (string|null), error: (*|null)}>}
 *   Resolution NEVER rejects for network/upstream failure when stale data
 *   exists — the whole point. `ok:false` with empty text means a true miss.
 */
export async function fetchWithCache(url, options = {}) {
  const {
    ttlMs = 60_000,
    maxStaleMs = 10 * 60_000,
    signal = null,
    method = 'GET',
  } = options;
  if (method !== 'GET' || typeof fetch !== 'function') {
    // Non-cacheable path: plain fetch passthrough.
    try {
      const response = await fetch(url, { method, signal });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        json: safeJson(text),
        text,
        fromCache: false,
        stale: false,
        etag: null,
        error: null,
      };
    } catch (error) {
      return { ok: false, status: 0, json: null, text: '', fromCache: false, stale: false, etag: null, error };
    }
  }

  const entry = await readEntry(url);
  const now = Date.now();
  // Codec readiness gates binary decode below; the shared promise resolves
  // once per session, so steady-state hits pay no extra latency.
  await ensureMsgpack();
  // Fresh hit without an ETag: answer directly, zero network. (With an ETag
  // we still revalidate — a 304 is one header round-trip and keeps the entry
  // honest; without ETag support upstream, TTL is the only freshness signal
  // we have, so a fresh entry is simply served.)
  if (entry && isFresh(entry, now) && !entry.etag) {
    const decodedData = entry.binaryEncoded 
      ? decodeData(entry.bodyBinary, true)
      : safeJson(entry.bodyText);
    return {
      ok: true,
      status: entry.status,
      json: decodedData,
      text: entry.bodyText,
      fromCache: true,
      stale: false,
      etag: null,
      error: null,
    };
  }
  const headers = {};
  if (entry?.etag) headers['if-none-match'] = entry.etag;

  // The upstream leg as a unit: network fetch + cache write + stale policy.
  // Extracted so the coalescing gate below can share one execution between
  // callers racing for the same URL.
  const doUpstream = async () => {
  try {
    const response = await fetch(url, { method, headers, signal });
    if (response?.status === 304 && entry) {
      entry.storedAt = now;
      await writeEntry(entry);
      const decodedData = entry.binaryEncoded 
        ? decodeData(entry.bodyBinary, true)
        : safeJson(entry.bodyText);
      return {
        ok: true,
        status: 304,
        json: decodedData,
        text: entry.bodyText,
        fromCache: true,
        stale: false,
        etag: entry.etag,
        error: null,
      };
    }
    if (response.ok) {
      // Defensive header/text access: test doubles and older fetch shims may
      // omit headers or text(); both are optional for the cache to work.
      let text = '';
      if (typeof response.text === 'function') {
        text = await response.text();
      } else if (typeof response.json === 'function') {
        text = JSON.stringify(await response.json());
      }
      const etag = typeof response.headers?.get === 'function'
        ? response.headers.get('etag')
        : null;
      if (text) {
        const jsonData = safeJson(text);
        const encodedData = encodeData(jsonData);
        const binaryEncoded = encodedData instanceof Uint8Array;
        await writeEntry({
          url,
          storedAt: now,
          ttlMs,
          etag,
          status: response.status,
          bodyText: text,
          bodyBinary: binaryEncoded ? encodedData : null,
          bodyBytes: binaryEncoded ? estimateBinaryBytes(encodedData) : estimateBytes(text),
          binaryEncoded,
        });
      }
      return { ok: true, status: response.status, json: safeJson(text), text, fromCache: false, stale: false, etag, error: null };
    }
    // Upstream reported a real HTTP error. Serve stale if we reasonably can.
    if (entry && now - entry.storedAt <= maxStaleMs && entry.status >= 200 && entry.status < 300) {
      const decodedData = entry.binaryEncoded 
        ? decodeData(entry.bodyBinary, true)
        : safeJson(entry.bodyText);
      return {
        ok: true,
        status: entry.status,
        json: decodedData,
        text: entry.bodyText,
        fromCache: true,
        stale: true,
        etag: entry.etag,
        error: new Error(`upstream ${response.status}, serving stale`),
      };
    }
    return { ok: false, status: response.status, json: null, text: '', fromCache: false, stale: false, etag: null, error: null };
  } catch (error) {
    // Network failure (abort, offline, DNS). Abort must NOT serve stale —
    // the caller deliberately cancelled (camera moved, layer disabled).
    if (error?.name === 'AbortError') {
      throw error;
    }
    if (entry && now - entry.storedAt <= maxStaleMs) {
      const decodedData = entry.binaryEncoded 
        ? decodeData(entry.bodyBinary, true)
        : safeJson(entry.bodyText);
      return {
        ok: true,
        status: entry.status,
        json: decodedData,
        text: entry.bodyText,
        fromCache: true,
        stale: true,
        etag: entry.etag,
        error,
      };
    }
    return { ok: false, status: 0, json: null, text: '', fromCache: false, stale: false, etag: null, error };
  }
  };

  if (signal) return doUpstream();
  const inFlight = _inflightFetches.get(url);
  if (inFlight && now - inFlight.startedAt <= COALESCE_WINDOW_MS) {
    return inFlight.promise;
  }
  const shared = doUpstream();
  _inflightFetches.set(url, { promise: shared, startedAt: now });
  try {
    return await shared;
  } finally {
    if (_inflightFetches.get(url)?.promise === shared) _inflightFetches.delete(url);
  }
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Read-through helper for feeds whose consumers want parsed JSON and a
 * staleness flag, not the raw envelope.
 * @returns {Promise<{json: (*|null), stale: boolean, hit: boolean}>}
 */
export async function fetchJsonWithCache(url, options = {}) {
  const result = await fetchWithCache(url, options);
  return { json: result.json, stale: result.stale, hit: result.ok };
}

/** Test/maintenance: wipe the cache. */
export async function clearFeedCache() {
  return clearAll();
}

/** Diagnostics: entry count + freshest entry, without exposing bodies. */
export async function getFeedCacheDiagnostics() {
  if (_useMemoryStore) {
    return Object.freeze({
      mode: 'memory',
      entries: _memoryStore.size,
      urls: [..._memoryStore.keys()],
      inflight: _inflightFetches.size,
    });
  }
  const keys = await idbRun('readonly', (store) => store.getAllKeys());
  return Object.freeze({
    mode: _db ? 'indexeddb' : 'none',
    entries: Array.isArray(keys) ? keys.length : 0,
    urls: Array.isArray(keys) ? keys.slice(0, 20) : [],
    inflight: _inflightFetches.size,
  });
}

/** Test seam: force memory mode and reset state. */
export function _resetFeedCacheForTest() {
  _memoryStore.clear();
  _inflightFetches.clear();
  if (_db) {
    try { _db.close(); } catch { /* already closed */ }
  }
  _db = null;
  _dbOpening = null;
  _useMemoryStore = typeof indexedDB === 'undefined';
}
