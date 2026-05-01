import net from 'node:net';
import { waitForPort } from '../process/health.js';

export interface LazyProxyOpts {
  listenPort: number;
  targetPort: number;
  timeoutMin: number;
  onDemandStart: () => Promise<void>;
  onIdleStop: () => void;
  isAlive: () => boolean;
  onLog?: (msg: string) => void;
}

export interface LazyProxy {
  server: net.Server;
  resetTimer: () => void;
  destroy: () => void;
}

export function createLazyProxy(opts: LazyProxyOpts): LazyProxy {
  const { listenPort, targetPort, timeoutMin, onDemandStart, onIdleStop, isAlive, onLog } = opts;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let starting = false;
  let serviceReady = false;
  let pendingConns: net.Socket[] = [];

  function resetTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (timeoutMin > 0) {
      idleTimer = setTimeout(() => {
        serviceReady = false;
        onLog?.(`💤 idle ${timeoutMin}min — stopping`);
        onIdleStop();
      }, timeoutMin * 60_000);
    }
  }

  function pipeToTarget(client: net.Socket) {
    const target = net.createConnection({ port: targetPort, host: '127.0.0.1', allowHalfOpen: true });
    target.on('error', () => { client.destroy(); });
    client.on('error', () => { target.destroy(); });
    target.on('connect', () => {
      target.on('data', (chunk) => { if (!client.destroyed) client.write(chunk); });
      client.on('data', (chunk) => { if (!target.destroyed) target.write(chunk); });
      target.on('end', () => { if (!client.destroyed) client.end(); });
      client.on('end', () => { if (!target.destroyed) target.end(); });
    });
  }

  async function handleConnection(client: net.Socket) {
    resetTimer();
    client.on('error', () => {}); // Prevent uncaught ECONNRESET

    if (serviceReady && isAlive()) {
      pipeToTarget(client);
      return;
    }

    pendingConns.push(client);
    client.on('close', () => { pendingConns = pendingConns.filter(s => s !== client); });

    if (starting) return;
    starting = true;

    onLog?.('⚡ on-demand start');
    try {
      await onDemandStart();
      const ok = await waitForPort(targetPort, { timeout: 45000, interval: 500 });
      if (ok) serviceReady = true;
      else onLog?.('⚠ timeout waiting for service');
    } catch (e: unknown) {
      onLog?.(`❌ start failed: ${(e as Error).message}`);
    }
    starting = false;

    const conns = pendingConns.splice(0);
    for (const conn of conns) {
      if (!conn.destroyed) pipeToTarget(conn);
    }
  }

  const server = net.createServer({ allowHalfOpen: true }, socket => handleConnection(socket));
  server.listen(listenPort, '0.0.0.0');
  resetTimer();

  return {
    server,
    resetTimer,
    destroy: () => {
      if (idleTimer) clearTimeout(idleTimer);
      pendingConns.forEach(s => s.destroy());
      server.close();
    },
  };
}
