import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { EnvironmentConfig } from '../config/types.js';

/** Headers that describe one hop and must not be forwarded to the next.
 *  `upgrade` and `connection` are in the list for the ordinary request path;
 *  the WebSocket path builds its own headers and keeps them. */
const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
];

const FORWARDED_HEADERS = ['x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for'];

export interface RemoteContext {
  /** Upstream base, e.g. `https://check-in-api.qa.norelian.com`. */
  target: URL;
  /** What the browser is talking to, e.g. `http://localhost:3050`. */
  localOrigin: string;
  env: EnvironmentConfig;
  /** Remote origin → local origin, for every service in this run. See
   *  `buildOriginMap`. */
  originMap: Map<string, string>;
  /** `headers.set` with `${VAR}` already resolved — see `resolveHeaderValues`,
   *  which does it once at boot so a missing variable is a startup error and
   *  not an empty header on every request. */
  setHeaders: Record<string, string>;
}

/** `${VAR}` from the process environment, resolved once.
 *
 *  Throws on a missing variable rather than substituting an empty string: a
 *  blank `Authorization` reaches the upstream as an anonymous request, and
 *  what comes back is a 401 that looks like bad credentials rather than a
 *  misspelled variable name. */
export function resolveHeaderValues(
  set: Record<string, string> | undefined,
  processEnv: Record<string, string | undefined>,
  envName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(set ?? {})) {
    out[key] = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const value = processEnv[name];
      if (value === undefined) {
        throw new Error(
          `environments.${envName}.headers.set["${key}"] references \${${name}}, which is not set`,
        );
      }
      return value;
    });
  }
  return out;
}

export interface UpstreamHeaderOpts {
  /** Keep `connection` and `upgrade`, which are hop-by-hop everywhere except
   *  on the request that is asking for the hop to change protocol. Stripping
   *  them there turns a WebSocket handshake into an ordinary GET, and the
   *  upstream answers 200 to a client waiting for 101. */
  upgrade?: boolean;
}

/** The headers to send upstream, from the ones the local client sent. */
export function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  ctx: RemoteContext,
  opts: UpstreamHeaderOpts = {},
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const stripped = opts.upgrade
    ? HOP_BY_HOP.filter(h => h !== 'connection' && h !== 'upgrade')
    : HOP_BY_HOP;
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (stripped.includes(key.toLowerCase())) continue;
    out[key] = value;
  }

  // The ingress in front of the environment routes on Host. Leaving the local
  // one there is a 404 from a server that never saw the service.
  out.host = ctx.env.host === 'passthrough' ? (incoming.host ?? ctx.target.host) : ctx.target.host;

  if (ctx.env.origin) {
    // Set unconditionally, including on requests that arrived without one.
    // Upstreams that read the origin tend to *index* on it — selecting a
    // tenant, or matching an allowlist — and some index without checking it is
    // there at all. Asking for an origin means every request carries it.
    out.origin = ctx.env.origin;
    const referer = incoming.referer;
    if (typeof referer === 'string') out.referer = rewriteOrigin(referer, ctx.localOrigin, ctx.env.origin);
  }

  if (ctx.env.forwarded) {
    out['x-forwarded-host'] = incoming.host ?? '';
    out['x-forwarded-proto'] = 'http';
  } else {
    // Not merely "devup does not add these": a forwarded header that arrives
    // from a local reverse proxy names a *local* host, and an upstream using
    // it to resolve a tenant either finds nothing or finds the wrong one. An
    // environment that needs one sets it explicitly through `headers.set`,
    // which is applied after this.
    for (const key of FORWARDED_HEADERS) delete out[key];
  }

  for (const key of ctx.env.headers?.remove ?? []) delete out[key.toLowerCase()];
  for (const [key, value] of Object.entries(ctx.setHeaders)) out[key.toLowerCase()] = value;

  return out;
}

/** The headers to send back to the local client, from the upstream's. */
export function transformResponseHeaders(
  upstream: IncomingHttpHeaders,
  ctx: RemoteContext,
  requestOrigin: string | undefined,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(upstream)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.includes(key.toLowerCase())) continue;
    out[key] = value;
  }

  if (ctx.env.cookies !== 'passthrough' && upstream['set-cookie']) {
    out['set-cookie'] = upstream['set-cookie'].map(localizeSetCookie);
  }

  if (ctx.env.location !== 'passthrough' && typeof upstream.location === 'string') {
    out.location = localizeLocation(upstream.location, ctx.originMap, ctx.localOrigin, ctx.target.origin);
  }

  // The other half of `origin`. An upstream that echoes the origin it was given
  // answers with the *rewritten* one, and a browser on localhost rejects a
  // reply whose allow-origin is somebody else's. Anything that was already `*`
  // is left alone — it already permits the local page.
  const acao = out['access-control-allow-origin'];
  if (ctx.env.origin && typeof acao === 'string' && acao !== '*') {
    out['access-control-allow-origin'] = requestOrigin ?? ctx.localOrigin;
  }

  return out;
}

/** Make a cookie scoped to the remote environment stick on `http://localhost`.
 *
 *  Two attributes have to go. `Domain=.qa.norelian.com` puts the cookie on a
 *  domain the browser is not on, and `Secure` withholds it from a plain-http
 *  page — a session cookie carrying both is dropped twice over.
 *
 *  `SameSite=None` is dropped *with* `Secure`, because the two are only valid
 *  together: a browser rejects `SameSite=None` without `Secure`, so removing
 *  one and keeping the other trades a cookie the browser ignores for a cookie
 *  the browser refuses. `Lax` is the closest thing that survives the trip.
 *  `HttpOnly`, `Path`, `Max-Age` and `SameSite=Strict` are kept as they came —
 *  Strict still matches, since same-site does not look at the port. */
export function localizeSetCookie(cookie: string): string {
  const parts = cookie.split(';').map(p => p.trim()).filter(Boolean);
  const kept: string[] = [];
  let sameSiteNone = false;

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'secure') continue;
    if (lower.startsWith('domain=')) continue;
    if (lower === 'samesite=none') { sameSiteNone = true; continue; }
    kept.push(part);
  }

  if (sameSiteNone) kept.push('SameSite=Lax');
  return kept.join('; ');
}

/** Point a redirect back at the local stack.
 *
 *  Any origin this run fronts is mapped, not just the service's own: a login
 *  redirect crosses from the authorization API to the app, and a redirect left
 *  pointing at the environment takes the browser — and the session it just
 *  received — out of the local stack. Relative locations and unknown hosts are
 *  left untouched; rewriting a host devup does not serve would send the
 *  browser to a port with nothing on it. */
export function localizeLocation(
  location: string,
  originMap: Map<string, string>,
  localOrigin: string,
  targetOrigin: string,
): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return location; // relative — already local
  }
  const mapped = originMap.get(url.origin) ?? (url.origin === targetOrigin ? localOrigin : undefined);
  if (!mapped) return location;
  return `${mapped}${url.pathname}${url.search}${url.hash}`;
}

function rewriteOrigin(value: string, from: string, to: string): string {
  return value.startsWith(from) ? `${to}${value.slice(from.length)}` : value;
}
