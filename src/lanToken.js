/**
 * @module lanToken
 * @description Client half of the LAN-share session token (SECURITY).
 *
 * When the app is served in LAN-share mode (HOST=0.0.0.0), the server gates
 * every /api/* proxy behind a per-boot session token. This module makes the
 * client able to pass that gate without touching every fetch call site:
 *
 * 1. **Ingestion** — a token arrives either as `?gev_token=` on the URL (the
 *    share link the host hands out) or, for the host's own loopback browser,
 *    from GET /api/lan-token (loopback-only endpoint).
 * 2. **Persistence** — stored in sessionStorage (scoped to the LAN tab's
 *    session; never written to durable localStorage where it would outlive
 *    the server boot that minted it).
 * 3. **Attachment** — a single window.fetch wrapper adds `x-gev-token` to
 *    same-origin /api/* requests and strips `gev_token` from URLs so the
 *    token never leaks into proxy logs or referrers.
 *
 * Loopback dev sessions without a token are untouched: the gate is inert
 * unless the server actually bound to the LAN.
 */

const TOKEN_STORAGE_KEY = 'gev:lan-share-token';
const TOKEN_URL_PARAM = 'gev_token';

/** @returns {string|null} the currently stored session token. */
export function getLanShareToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Read the token from the URL (page or hash) without leaving it in
 * history: replaces the noisy query, keeps everything else identical.
 * @returns {string|null}
 */
function ingestTokenFromUrl() {
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get(TOKEN_URL_PARAM);
    if (fromQuery) {
      url.searchParams.delete(TOKEN_URL_PARAM);
      window.history.replaceState(null, '', url);
      return fromQuery;
    }
    // Hash form: #gev_token=... (used when the query string is reserved).
    const hashMatch = window.location.hash.match(new RegExp(`[#&]${TOKEN_URL_PARAM}=([^&]+)`));
    if (hashMatch) {
      const cleaned = window.location.hash.replace(
        new RegExp(`([#&])${TOKEN_URL_PARAM}=[^&]+&?`),
        '$1',
      );
      window.history.replaceState(null, '', window.location.pathname + window.location.search + cleaned);
      return decodeURIComponent(hashMatch[1]);
    }
  } catch {
    // URL APIs unavailable — skip URL ingestion.
  }
  return null;
}

/** Store the token for this tab's session. */
function storeToken(token) {
  if (!token) return;
  try {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // sessionStorage unavailable (privacy mode): the wrapper still uses the
    // in-memory copy for this page lifetime.
  }
}

/**
 * The host's own browser is (almost always) loopback; ask the loopback-only
 * endpoint for the token so share links can embed it.
 */
async function fetchTokenFromLoopbackEndpoint() {
  try {
    const response = await fetch('/api/lan-token', { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.token || null;
  } catch {
    return null;
  }
}

/**
 * Wrap window.fetch once: attach the token header to same-origin /api/*
 * requests and strip the token query from outgoing URLs.
 */
function installFetchAttachment(tokenRef) {
  if (typeof window.fetch !== 'function' || window.__gevLanTokenFetchWrapped) return;
  window.__gevLanTokenFetchWrapped = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const token = tokenRef();
      if (!token) return originalFetch(input, init);
      let url = typeof input === 'string' ? input : (input instanceof URL ? input.href : null);
      if (!url) return originalFetch(input, init);
      const parsed = new URL(url, window.location.origin);
      const isApi = parsed.pathname.startsWith('/api/');
      const sameOrigin = parsed.origin === window.location.origin;
      if (!isApi || !sameOrigin) return originalFetch(input, init);
      if (parsed.searchParams.has(TOKEN_URL_PARAM)) {
        parsed.searchParams.delete(TOKEN_URL_PARAM);
        url = parsed.pathname + (parsed.search || '') + (parsed.hash || '');
        if (typeof input === 'string') input = url;
        else input = new Request(url, input);
      }
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      if (!headers.has('x-gev-token')) headers.set('x-gev-token', token);
      return originalFetch(input, { ...init, headers });
    } catch {
      // Never let token plumbing break a fetch.
      return originalFetch(input, init);
    }
  };
}

/**
 * Initialize LAN token handling. Call once at boot (before data layers
 * start fetching). Safe to call in loopback mode — everything no-ops when
 * no token ever materializes.
 * @returns {Promise<void>}
 */
export async function initLanShareToken() {
  let token = ingestTokenFromUrl();
  if (token) {
    storeToken(token);
  } else {
    token = getLanShareToken();
  }
  if (!token) {
    // No token in URL or storage: try the loopback endpoint (host browser).
    const minted = await fetchTokenFromLoopbackEndpoint();
    if (minted) {
      storeToken(minted);
      token = minted;
    }
  }
  installFetchAttachment(getLanShareToken);
}

/**
 * Build a tokenized share URL for guests (host-side helper).
 * @param {string} baseUrl e.g. 'http://192.168.1.20:4173/'
 * @returns {string} URL with the token attached, or the base URL unchanged.
 */
export function buildLanShareUrl(baseUrl) {
  const token = getLanShareToken();
  if (!token) return baseUrl;
  try {
    const url = new URL(baseUrl);
    url.searchParams.set(TOKEN_URL_PARAM, token);
    return url.toString();
  } catch {
    return baseUrl;
  }
}
