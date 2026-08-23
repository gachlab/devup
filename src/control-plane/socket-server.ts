import { createServer, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { existsSync, unlinkSync, chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProcessState } from '../process/types.js';
import { defaultSocketPath } from './socket-path.js';
import type {
  ServiceSnapshot, ProxyInfo, ProjectInfo, StatsResult, ServiceStatEntry, DebugResult,
} from './types.js';

// The wire types live in ./types.ts so `@gachlab/devup/client` can import them
// without dragging this server in. Re-exported here because the daemon and the
// tests reach for them through this module.
export type { ServiceSnapshot, ProxyInfo, ProjectInfo, StatsResult, ServiceStatEntry };
export { defaultSocketPath };

/** Minimal JSON-RPC-like protocol over a local Unix socket.
 *  Request  ─►  { id?, method, params? }  newline-terminated JSON
 *  Response ─►  { id?, result | error }   newline-terminated JSON
 *  Stream   ─►  { id, event, data }       pushed until socket closes
 *
 *  Auth model: unix socket created with `chmod 0600`. Anyone with read access
 *  to the socket file already has the same uid as the devup process — no
 *  additional auth needed. Strictly local; TCP exposure is intentionally
 *  out of scope. */

export interface RpcContext {
  /** State of every service (read-only snapshot). */
  states(): Map<string, ProcessState>;
  /** Restart a service by name. */
  restart(name: string): Promise<void>;
  /** Stop a service by name. */
  stop(name: string): void;
  /** Tail N most recent log lines for the given service (from the persistent log file). */
  tailLogs(svcName: string, lines: number): Promise<string[]>;
  /** Subscribe to live log lines. Pass null to receive logs from all services.
   *  Returns an unsubscribe function. */
  watchLogs(svcName: string | null, onLine: (svc: string, line: string) => void): () => void;
  /** Subscribe to service-state changes. Returns an unsubscribe function. */
  watchStatus(onUpdate: (name: string, state: ProcessState) => void): () => void;
  /** Subscribe to services leaving the set (config reload). Returns an
   *  unsubscribe function. Without this a client can only ever add or update,
   *  so a removed service lingers until it reconnects. */
  watchRemoved(onRemoved: (name: string) => void): () => void;
  /** Turn the Node inspector on or off for a service, restarting it. */
  debug(name: string, enable: boolean, port?: number, brk?: boolean): Promise<DebugResult>;
  /** Start a stopped service. Resolves to whether it is up: the spawner
   *  returns normally after recording a crash, so "no exception" is not
   *  success. Already running counts as up. */
  start(name: string): Promise<boolean>;
  /** Per-service CPU/mem stats + system totals. */
  getStats(): Promise<StatsResult>;
  /** Active proxy configuration, or null when no proxy is running. */
  getProxyInfo(): ProxyInfo | null;
  /** Project metadata: name and profiles defined in config. */
  getInfo(): ProjectInfo;
}

export interface SocketServerHandle {
  server: Server;
  path: string;
  close(): Promise<void>;
}

export async function startSocketServer(
  projectName: string,
  ctx: RpcContext,
  opts: { path?: string; onLog?: (msg: string) => void } = {},
): Promise<SocketServerHandle> {
  const path = opts.path ?? defaultSocketPath(projectName);
  mkdirSync(dirname(path), { recursive: true });

  // Stale socket from a crashed previous run.
  if (existsSync(path)) {
    try {
      const st = statSync(path);
      if (st.isSocket()) unlinkSync(path);
    } catch { /* ignore — listen() will surface the real error */ }
  }

  // Track every active client socket so `close()` can destroy them. Without
  // this, `server.close()` waits for all clients to disconnect on their own
  // — and long-lived streaming clients (logs.follow / status.follow, e.g.
  // the VS Code extension) keep the connection open indefinitely, which
  // means `devup down` would hang past its 10 s grace and SIGKILL the daemon
  // before cleanup could run, leaking child processes.
  const activeClients = new Set<Socket>();
  const server = createServer(socket => {
    activeClients.add(socket);
    socket.once('close', () => activeClients.delete(socket));
    handleClient(socket, ctx);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      try { chmodSync(path, 0o600); } catch { /* best effort on platforms without chmod */ }
      opts.onLog?.(`🔌 control plane at ${path}`);
      resolve();
    });
  });

  return {
    server,
    path,
    async close() {
      // Destroy active clients first so server.close() can complete promptly.
      for (const sock of activeClients) sock.destroy();
      activeClients.clear();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (existsSync(path)) {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    },
  };
}

function handleClient(socket: Socket, ctx: RpcContext): void {
  const rl = createInterface({ input: socket });
  const unsubs = new Set<() => void>();

  socket.on('close', () => {
    for (const unsub of unsubs) unsub();
    unsubs.clear();
  });

  rl.on('line', async (line: string) => {
    if (!line.trim()) return;
    let req: { id?: unknown; method?: unknown; params?: unknown };
    try {
      req = JSON.parse(line);
    } catch (e: any) {
      respond(socket, { error: { code: -32700, message: `parse error: ${e.message}` } });
      return;
    }
    if (typeof req.method !== 'string') {
      respond(socket, { id: req.id, error: { code: -32600, message: 'method required' } });
      return;
    }
    const params = (req.params ?? {}) as Record<string, unknown>;
    if (req.method === 'logs.follow' || req.method === 'status.follow') {
      try {
        await handleFollow(socket, req as { id?: unknown; method: string }, params, ctx, unsubs);
      } catch (e: any) {
        respond(socket, { id: req.id, error: { code: -32603, message: e.message ?? String(e) } });
      }
      return;
    }
    try {
      const result = await dispatch(req.method, params, ctx);
      respond(socket, { id: req.id, result });
    } catch (e: any) {
      respond(socket, { id: req.id, error: { code: -32603, message: e.message ?? String(e) } });
    }
  });
  socket.on('error', () => {/* swallow ECONNRESET etc. */});
}

async function handleFollow(
  socket: Socket,
  req: { id?: unknown; method: string },
  params: Record<string, unknown>,
  ctx: RpcContext,
  unsubs: Set<() => void>,
): Promise<void> {
  if (req.method === 'logs.follow') {
    const rawSvc = params['svc'] ?? params['service'];
    const svcName = rawSvc != null ? stringOrThrow(rawSvc, 'svc') : null;
    const tail = Math.max(0, Math.min(1000, Number(params['tail'] ?? 50)));

    respond(socket, { id: req.id, result: { ok: true } });

    // Replay recent history before going live.
    if (svcName) {
      const lines = await ctx.tailLogs(svcName, tail);
      for (const l of lines) {
        // `svc` on the replay too: a client routing by frame.svc would drop or
        // misattribute the whole tail otherwise.
        respond(socket, { id: req.id, event: 'log', data: l, svc: svcName });
      }
    }

    const unsub = ctx.watchLogs(svcName, (svc, line) => {
      respond(socket, { id: req.id, event: 'log', data: line, svc });
    });
    unsubs.add(unsub);

  } else {
    // status.follow
    respond(socket, { id: req.id, result: { ok: true } });

    // Send current snapshot immediately so the client has something to render.
    const snapshot: ServiceSnapshot[] = [];
    for (const [name, st] of ctx.states()) {
      snapshot.push(serializeState(name, st));
    }
    // Sent even when empty: a client cannot otherwise tell "connected, nothing
    // configured" from "still waiting for the first frame".
    respond(socket, { id: req.id, event: 'status', data: snapshot });

    const unsub = ctx.watchStatus((name, state) => {
      respond(socket, { id: req.id, event: 'status', data: [serializeState(name, state)] });
    });
    unsubs.add(unsub);

    const unsubRemoved = ctx.watchRemoved(name => {
      respond(socket, { id: req.id, event: 'removed', data: [name] });
    });
    unsubs.add(unsubRemoved);
  }
}

/** The wire shape of one service in a `status` snapshot.
 *
 *  Exported for the contract fixture: `contract/status-snapshot.json` is
 *  generated from this function, so a field renamed here fails a golden test
 *  instead of surfacing in a client weeks later. See docs/control-plane.md. */
export function serializeState(name: string, st: ProcessState): ServiceSnapshot {
  return {
    name,
    status: st.status,
    health: st.health,
    port: st.svc.port,
    // For a lazy service `port` above is the rewritten internal port, because
    // rewriteServicePort replaces it with port + LAZY_PORT_OFFSET and runs the
    // service there. The configured port — where the on-demand proxy listens,
    // and what clients are actually pointed at — survives as originalPort.
    // Always-on services are never rewritten, so the two coincide.
    originalPort: (st.svc as { originalPort?: number }).originalPort ?? st.svc.port,
    type: st.svc.type,
    phase: st.svc.phase,
    cmd: st.svc.cmd,
    cwd: st.svc.cwd,
    errors: st.errors,
    restarts: st.restarts,
    crashes: st.crashes ?? 0,
    pid: st.pid,
    startedAt: st.startedAt,
    crashLog: st.crashLog ?? null,
    debugPort: st.debugPort ?? null,
  };
}

function respond(socket: Socket, payload: object): void {
  if (socket.writable) socket.write(JSON.stringify(payload) + '\n');
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  ctx: RpcContext,
): Promise<unknown> {
  switch (method) {
    case 'status': {
      const out: ServiceSnapshot[] = [];
      for (const [name, st] of ctx.states()) {
        out.push(serializeState(name, st));
      }
      return { services: out, proxy: ctx.getProxyInfo() };
    }
    case 'stats':
      return await ctx.getStats();
    case 'info':
      return ctx.getInfo();
    case 'restart': {
      const svc = stringOrThrow(params['svc'] ?? params['service'], 'svc');
      await ctx.restart(svc);
      return { ok: true };
    }
    case 'start': {
      const svc = stringOrThrow(params['svc'] ?? params['service'], 'svc');
      // `ok` reflects the outcome, not merely that the request was accepted —
      // otherwise a client reports success while the service sits crashed.
      return { ok: await ctx.start(svc) };
    }
    case 'debug': {
      const svc = stringOrThrow(params['svc'] ?? params['service'], 'svc');
      const rawEnable = params['enable'];
      if (rawEnable !== undefined && typeof rawEnable !== 'boolean') {
        throw new Error('param "enable" must be a boolean');
      }
      const rawPort = params['port'];
      // Discarding a bad value silently would hand a programmatic client an
      // OS-chosen port while it believes it pinned one.
      if (rawPort !== undefined && rawPort !== null && typeof rawPort !== 'number') {
        throw new Error('param "port" must be a number');
      }
      const rawBrk = params['brk'];
      if (rawBrk !== undefined && typeof rawBrk !== 'boolean') {
        throw new Error('param "brk" must be a boolean');
      }
      return await ctx.debug(svc, rawEnable ?? true, typeof rawPort === 'number' ? rawPort : undefined, rawBrk === true);
    }
    case 'stop': {
      const svc = stringOrThrow(params['svc'] ?? params['service'], 'svc');
      ctx.stop(svc);
      return { ok: true };
    }
    case 'logs.tail': {
      const svc = stringOrThrow(params['svc'] ?? params['service'], 'svc');
      const lines = Math.max(1, Math.min(10_000, Number(params['lines'] ?? 100)));
      return { lines: await ctx.tailLogs(svc, lines) };
    }
    case 'ping':
      return { ok: true, ts: Date.now() };
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

function stringOrThrow(v: unknown, paramName: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`param "${paramName}" must be a non-empty string`);
  }
  return v;
}
