import { PROXY_SIGNAL_HEADERS } from './keySetupCore.mjs';

/**
 * @module localRequestGate
 * @description Same-site admission gate for the dev/preview server's
 * paid-or-writable endpoints (`/api/realtime/token`,
 * `/api/openai/hud-summary`, `/api/google/nearby-places`,
 * `/api/realtime/debug-log`).
 *
 * Threat: with the dev server running, a hostile page open in the same
 * browser can reach those endpoints cross-site. A `fetch` carries a foreign
 * Origin; an `<img src="http://localhost:4173/api/realtime/token">` carries
 * no Origin at all but does carry `Sec-Fetch-Site: cross-site`. Either mints
 * a paid Realtime token, spends provider quota, or appends attacker bytes to
 * the debug log.
 *
 * The gate refuses, with 403 semantics:
 * - reverse-proxy / CDN forwarding headers (a request carrying them did not
 *   originate on this machine, whatever the socket says);
 * - a `Sec-Fetch-Site` other than `same-origin`/`none` (missing is allowed —
 *   non-browser clients such as the Node QA harnesses and curl send none);
 * - a present-but-foreign or unparseable (opaque) Origin, compared against
 *   the request's own Host.
 *
 * It deliberately does NOT require a loopback socket, an Origin, or JSON, so
 * the documented `HOST=0.0.0.0` LAN opt-in and headerless Node clients keep
 * working. Pure and unit-tested; the credential panel's stricter
 * `admitKeySetupRequest` gate is unchanged.
 *
 * @param {object} [input]
 * @param {string} [input.method]
 * @param {string} [input.hostHeader] - Raw `Host` header value.
 * @param {string} [input.origin] - Raw `Origin` header value, if any.
 * @param {string} [input.secFetchSite] - Raw `Sec-Fetch-Site` value, if any.
 * @param {object} [input.proxyHeaders] - Lowercase header map for proxy signals.
 * @returns {{ok: true} | {ok: false, status: 403, error: string}}
 */
export function admitSameSiteRequest({
  method,
  hostHeader,
  origin,
  secFetchSite,
  proxyHeaders = {},
} = {}) {
  void method;
  const lowered = {};
  for (const [name, value] of Object.entries(proxyHeaders || {})) {
    lowered[String(name).toLowerCase()] = value;
  }
  if (PROXY_SIGNAL_HEADERS.some((name) => String(lowered[name] || '').trim() !== '')) {
    return { ok: false, status: 403, error: 'Proxied requests are refused by this endpoint' };
  }
  const site = String(secFetchSite || '').trim().toLowerCase();
  if (site !== '' && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, error: 'Cross-site requests are refused by this endpoint' };
  }
  const rawOrigin = origin === undefined || origin === null ? '' : String(origin).trim();
  if (rawOrigin !== '') {
    let parsed;
    try {
      parsed = new URL(rawOrigin);
    } catch {
      return { ok: false, status: 403, error: 'Opaque Origin refused by this endpoint' };
    }
    const host = String(hostHeader || '').trim().toLowerCase();
    if (!host || parsed.host.toLowerCase() !== host) {
      return { ok: false, status: 403, error: 'Foreign Origin refused by this endpoint' };
    }
  }
  return { ok: true };
}
