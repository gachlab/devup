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
  /** Bring the service up as a connection would, and report whether it is
   *  reachable. Callers outside the proxy — the control plane's `start` — must
   *  go through this rather than spawning directly: the proxy's own
   *  `serviceReady` / in-flight flags would otherwise stay false and the next
   *  request would start a *second* process. Concurrent calls share one start. */
  ensureStarted: () => Promise<boolean>;
}

export function createLazyProxy(opts: LazyProxyOpts): LazyProxy {
  const { listenPort, targetPort, timeoutMin, onDemandStart, onIdleStop, isAlive, onLog } = opts;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActivity = Date.now();
  let startInFlight: Promise<boolean> | null = null;
  let serviceReady = false;
  let pendingConns: net.Socket[] = [];
  const activeConns = new Set<net.Socket>();

  function bumpActivity() {
    lastActivity = Date.now();
  }

  function scheduleIdleCheck() {
    if (idleTimer) clearTimeout(idleTimer);
    if (timeoutMin <= 0) return;
    const periodMs = timeoutMin * 60_000;
    idleTimer = setTimeout(() => {
      const elapsed = Date.now() - lastActivity;
      if (activeConns.size > 0 || elapsed < periodMs) {
        // Aún activa o tráfico reciente — re-agenda
        scheduleIdleCheck();
        return;
      }
      serviceReady = false;
      onLog?.(`💤 idle ${timeoutMin}min — stopping`);
      onIdleStop();
    }, periodMs);
  }

  function pipeToTarget(client: net.Socket) {
    const target = net.createConnection({ port: targetPort, host: '127.0.0.1', allowHalfOpen: true });
    activeConns.add(client);

    const cleanup = () => {
      activeConns.delete(client);
      bumpActivity();
    };

    target.on('error', () => { client.destroy(); cleanup(); });
    client.on('error', () => { target.destroy(); cleanup(); });
    client.on('close', cleanup);
    target.on('close', cleanup);

    target.on('connect', () => {
      target.on('data', (chunk) => { bumpActivity(); if (!client.destroyed) client.write(chunk); });
      client.on('data', (chunk) => { bumpActivity(); if (!target.destroyed) target.write(chunk); });
      target.on('end', () => { if (!client.destroyed) client.end(); });
      client.on('end', () => { if (!target.destroyed) target.end(); });
    });
  }

  /** The on-demand start, shared by an incoming connection and by an explicit
   *  request from the control plane. One start at a time: later callers await
   *  the in-flight one instead of spawning again. */
  async function ensureStarted(): Promise<boolean> {
    if (serviceReady && isAlive()) return true;
    if (!startInFlight) {
      startInFlight = (async () => {
        onLog?.('⚡ on-demand start');
        let ok = false;
        try {
          await onDemandStart();
          ok = await waitForPort(targetPort, { timeout: 45000, interval: 500 });
          if (ok) serviceReady = true;
          else onLog?.('⚠ timeout waiting for service');
        } catch (e: unknown) {
          onLog?.(`❌ start failed: ${(e as Error).message}`);
        }
        return ok;
      })().finally(() => { startInFlight = null; });
    }
    return startInFlight;
  }

  async function handleConnection(client: net.Socket) {
    bumpActivity();
    client.on('error', () => {}); // Prevent uncaught ECONNRESET

    if (serviceReady && isAlive()) {
      pipeToTarget(client);
      return;
    }

    pendingConns.push(client);
    client.on('close', () => { pendingConns = pendingConns.filter(s => s !== client); });

    const ok = await ensureStarted();

    const conns = pendingConns.splice(0);
    if (!ok) {
      for (const conn of conns) {
        if (!conn.destroyed) conn.destroy();
      }
      return;
    }
    for (const conn of conns) {
      if (!conn.destroyed) pipeToTarget(conn);
    }
  }

  const server = net.createServer({ allowHalfOpen: true }, socket => handleConnection(socket));
  server.listen(listenPort, '0.0.0.0');
  scheduleIdleCheck();

  return {
    server,
    resetTimer: bumpActivity,
    ensureStarted,
    destroy: () => {
      if (idleTimer) clearTimeout(idleTimer);
      pendingConns.forEach(s => s.destroy());
      activeConns.forEach(s => s.destroy());
      server.close();
    },
  };
}
