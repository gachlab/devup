import net from 'node:net';
import http from 'node:http';
import type { HealthStatus } from './types.js';
import type { HealthCheckConfig } from '../config/types.js';

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
