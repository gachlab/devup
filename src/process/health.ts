import net from 'node:net';
import http from 'node:http';
import type { HealthStatus } from './types.js';
import type { HealthCheckConfig } from '../config/types.js';

/** "Is something accepting connections at port?" — connect-based test.
 *  Use this for health checks and waitForPort, where "occupied" means
 *  "the service is up". Do NOT use this to decide whether to spawn — use
 *  `isPortBindable` instead (a bound but pre-accept server would slip
 *  through this check). */
export function checkPort(port: number, host = '127.0.0.1', timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

/** "Can I bind to this port right now?" — bind-based test. Returns true
 *  if a server could listen on the port on every wildcard address. Used as
 *  the pre-flight before spawning a service: catches every case that would
 *  cause the spawned process to die with EADDRINUSE, including bound-but-
 *  not-yet-accepting states that `checkPort` misses.
 *
 *  Implementation detail: tests both IPv4 (`0.0.0.0`) and IPv6 (`::`)
 *  wildcards. On Linux these usually share an address space (IPV6_V6ONLY=0),
 *  so a single test suffices; on Windows the defaults isolate the stacks,
 *  so a one-stack test can miss a conflicting bind on the other. We require
 *  both stacks to be free to call the port bindable. */
export async function isPortBindable(port: number): Promise<boolean> {
  // Sequential, not parallel — on Linux the IPv4/IPv6 wildcards share an
  // address space, so two simultaneous test-binds race each other and the
  // second loses with EADDRINUSE even when the port is genuinely free.
  for (const host of ['0.0.0.0', '::']) {
    if (!(await tryBind(port, host))) return false;
  }
  return true;
}

function tryBind(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      // EADDRINUSE / EACCES → conflict. Other errors (e.g. EAFNOSUPPORT on an
      // IPv6-disabled box) we treat as "stack unavailable, not a conflict".
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false);
      else resolve(true);
    });
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

export function checkHttp(
  port: number,
  opts: { path?: string; expect?: number | number[]; host?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const path = opts.path ?? '/';
  const host = opts.host ?? '127.0.0.1';
  const timeoutMs = opts.timeoutMs ?? 2000;
  const accept = (code: number) => {
    if (opts.expect === undefined) return code >= 200 && code < 300;
    if (Array.isArray(opts.expect)) return opts.expect.includes(code);
    return code === opts.expect;
  };
  return new Promise(resolve => {
    const req = http.get({ host, port, path, timeout: timeoutMs }, res => {
      const ok = typeof res.statusCode === 'number' && accept(res.statusCode);
      res.resume();
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Run the right check for a service, given its optional healthCheck config. */
export function checkHealth(port: number, hc?: HealthCheckConfig): Promise<boolean> {
  if (hc?.type === 'http') {
    return checkHttp(port, {
      path: hc.path, expect: hc.expect, host: hc.host, timeoutMs: hc.timeoutMs,
    });
  }
  return checkPort(port, '127.0.0.1', hc?.timeoutMs);
}

export function waitForPort(port: number, opts: { timeout?: number; interval?: number } = {}): Promise<boolean> {
  const { timeout = 45000, interval = 1000 } = opts;
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      checkPort(port).then(ok => {
        if (ok) return resolve(true);
        if (Date.now() - start > timeout) return resolve(false);
        setTimeout(check, interval);
      });
    };
    check();
  });
}

export function deriveHealth(isUp: boolean, currentStatus: string): HealthStatus {
  if (currentStatus === 'idle') return 'idle';
  if (isUp) return 'up';
  return currentStatus === 'starting' ? 'wait' : 'down';
}
