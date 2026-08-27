import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import type { EnvironmentConfig } from '../config/types.js';
import { redactUrl } from '../utils/redact.js';
import {
  buildUpstreamHeaders, resolveHeaderValues, transformResponseHeaders,
  type RemoteContext,
} from './headers.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_INTERVAL_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const READ_ONLY_METHODS = ['GET', 'HEAD', 'OPTIONS'];

export interface RemoteProxyOpts {
  listenPort: number;
  /** Absolute upstream base, e.g. `https://check-in-api.qa.norelian.com`. */
  target: string;
  envName: string;
  env: EnvironmentConfig;
  /** Every remote origin in this run, for redirect localization. */
  originMap: Map<string, string>;
  processEnv?: Record<string, string | undefined>;
  onLog?: (msg: string) => void;
  /** An upstream that could not be reached. Distinct from an upstream that
   *  answered 500: the first means the environment is unreachable from here,
   *  the second is the service's own business. */
  onUpstreamError?: (err: Error) => void;
  /** Result of each liveness probe. The proxy owns the timer that drives this
   *  so that `destroy()` is the single place that releases it — a stray
   *  interval writing health for a service that was removed is the same class
   *  of bug as a proxy left holding its port. */
  onHealth?: (reachable: boolean) => void;
}

export interface RemoteProxy {
  server: http.Server;
  target: string;
  envName: string;
  /** One probe against the environment. */
  probe: () => Promise<boolean>;
  destroy: () => void;
}

export function createRemoteProxy(opts: RemoteProxyOpts): RemoteProxy {
  const { listenPort, target, envName, env, originMap, onLog, onUpstreamError } = opts;
  const targetUrl = new URL(target);
  const agent = targetUrl.protocol === 'https:' ? https : http;
  const timeoutMs = env.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const ctx: RemoteContext = {
    target: targetUrl,
    localOrigin: `http://localhost:${listenPort}`,
    env,
    originMap,
    // Resolved once, at construction: a missing `${VAR}` becomes a boot error
    // naming the environment and the header, instead of an empty value the
    // upstream answers 401 to on every request.
    setHeaders: resolveHeaderValues(env.headers?.set, opts.processEnv ?? process.env, envName),
  };

  const inFlight = new Set<http.ClientRequest>();
  const upgraded = new Set<Duplex>();
  let probeTimer: ReturnType<typeof setInterval> | null = null;

  function upstreamOptions(over: https.RequestOptions): https.RequestOptions {
    return {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      // Only meaningful over https; ignored by the http module.
      rejectUnauthorized: env.tlsVerify !== false,
      // The certificate is issued for the environment's hostname, and `host`
      // is rewritten to it — but SNI comes from the connection, not the
      // header, so it has to be said again here.
      servername: targetUrl.hostname,
      ...over,
    };
  }

  function forward(req: http.IncomingMessage, res: http.ServerResponse): void {
    const startedAt = Date.now();
    const path = req.url ?? '/';

    if (env.readOnly && !READ_ONLY_METHODS.includes(req.method ?? 'GET')) {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end(`devup: ${envName} is mounted read-only\n`);
      onLog?.(`⛔ ${req.method} ${redactUrl(path)} → 405 (read-only)`);
      req.resume();
      return;
    }

    const upstream = agent.request(upstreamOptions({
      method: req.method,
      path,
      headers: buildUpstreamHeaders(req.headers, ctx),
    }));

    inFlight.add(upstream);
    upstream.setTimeout(timeoutMs, () => {
      upstream.destroy(new Error(`upstream timeout after ${timeoutMs}ms`));
    });

    upstream.on('response', up => {
      const headers = transformResponseHeaders(up.headers, ctx, asString(req.headers.origin));
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
      up.on('end', () => {
        onLog?.(`${req.method} ${redactUrl(path)} → ${up.statusCode} (${Date.now() - startedAt}ms)`);
      });
    });

    upstream.on('error', (err: Error) => {
      inFlight.delete(upstream);
      onUpstreamError?.(err);
      onLog?.(`❌ ${req.method} ${redactUrl(path)} → ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      if (!res.writableEnded) res.end(`devup: ${envName} unreachable — ${err.message}\n`);
    });
    upstream.on('close', () => inFlight.delete(upstream));

    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  }

  /** A protocol switch — a WebSocket, and in practice the HMR channel of Vite
   *  or `ng serve`, which is what makes it possible to serve a *web* service
   *  from an environment at all.
   *
   *  Nothing here can go through `forward`: an upgrade has no response body to
   *  pipe, the 101 has to be written to the raw socket, and the two headers
   *  that are hop-by-hop everywhere else are the ones carrying the request. */
  function upgrade(req: http.IncomingMessage, client: Duplex, head: Buffer): void {
    const path = req.url ?? '/';
    const upstream = agent.request(upstreamOptions({
      method: req.method,
      path,
      headers: buildUpstreamHeaders(req.headers, ctx, { upgrade: true }),
    }));
    inFlight.add(upstream);
    client.on('error', () => upstream.destroy());

    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      inFlight.delete(upstream);
      upgraded.add(client);
      upgraded.add(upSocket);
      const headers = Object.entries(upRes.headers)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
      // Bytes each side had already read past the handshake. Dropping them
      // loses the first frame, which on an HMR channel is the one that says
      // the connection is alive.
      if (upHead?.length) upSocket.unshift(upHead);
      if (head?.length) client.unshift(head);
      upSocket.on('error', () => client.destroy());
      const forget = () => { upgraded.delete(client); upgraded.delete(upSocket); };
      client.on('close', forget);
      upSocket.on('close', forget);
      upSocket.pipe(client).pipe(upSocket);
      onLog?.(`🔌 ${path} → 101 (upgraded)`);
    });

    // The upstream answered normally: it does not speak this protocol, or the
    // path is wrong. There is no response to relay onto a socket that is
    // waiting for a 101, so say so and close rather than hanging.
    upstream.on('response', up => {
      inFlight.delete(upstream);
      up.resume();
      onLog?.(`⚠ ${path} → ${up.statusCode} (upgrade refused)`);
      client.end(`HTTP/1.1 ${up.statusCode ?? 502} Upgrade Refused\r\n\r\n`);
    });

    upstream.on('error', (err: Error) => {
      inFlight.delete(upstream);
      onUpstreamError?.(err);
      onLog?.(`❌ ${path} → ${err.message}`);
      client.destroy();
    });

    upstream.end();
  }

  const server = http.createServer(forward);
  server.on('upgrade', upgrade);
  server.listen(listenPort, '0.0.0.0');

  /** Reachability, not correctness: an environment answering 401 to an
   *  unauthenticated probe is up, and treating that as down would paint a
   *  working stack red. Only a response that never arrives counts as down. */
  function probe(): Promise<boolean> {
    const hc = env.healthCheck ?? {};
    return new Promise(resolve => {
      const req = agent.request(upstreamOptions({
        method: 'GET',
        path: hc.path ?? '/',
        headers: { host: targetUrl.host, ...(env.origin ? { origin: env.origin } : {}) },
      }), up => {
        up.resume();
        resolve(matchesExpectation(up.statusCode, hc.expect));
      });
      req.setTimeout(hc.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, () => req.destroy());
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  if (opts.onHealth) {
    const tick = () => probe().then(opts.onHealth!);
    void tick();
    probeTimer = setInterval(tick, probeIntervalMs(env));
    // Nothing waits on this interval, and a stack of 20 remote services would
    // otherwise be 20 reasons the process cannot exit on its own.
    probeTimer.unref?.();
  }

  return {
    server,
    target,
    envName,
    probe,
    destroy: () => {
      if (probeTimer) clearInterval(probeTimer);
      probeTimer = null;
      for (const req of inFlight) req.destroy();
      inFlight.clear();
      // An upgraded connection is no longer a request: it is two sockets
      // piped together, and `server.close()` does not touch it. Left alone
      // they hold the event loop open for as long as the far end stays quiet.
      for (const socket of upgraded) socket.destroy();
      upgraded.clear();
      server.close();
    },
  };
}

export function probeIntervalMs(env: EnvironmentConfig): number {
  return env.healthCheck?.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
}

function matchesExpectation(status: number | undefined, expect: number | number[] | undefined): boolean {
  if (status === undefined) return false;
  if (expect === undefined) return true;
  return Array.isArray(expect) ? expect.includes(status) : status === expect;
}

function asString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
