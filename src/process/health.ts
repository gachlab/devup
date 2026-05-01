import net from 'node:net';
import type { HealthStatus } from './types.js';

export function checkPort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
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
