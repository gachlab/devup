import { createServer, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { existsSync, unlinkSync, chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProcessState } from '../process/types.js';

/** Minimal JSON-RPC-like protocol over a local Unix socket.
 *  Request  ─►  { id?, method, params? }  newline-terminated JSON
 *  Response ─►  { id?, result | error }   newline-terminated JSON
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
}

export interface SocketServerHandle {
  server: Server;
  path: string;
  close(): Promise<void>;
}

export function defaultSocketPath(projectName: string): string {
  const safe = projectName.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'devup';
  return join(homedir(), '.devup', `sock-${safe}.sock`);
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

  const server = createServer(socket => handleClient(socket, ctx));
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
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (existsSync(path)) {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    },
  };
}

function handleClient(socket: Socket, ctx: RpcContext): void {
  const rl = createInterface({ input: socket });
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
    try {
      const result = await dispatch(req.method, (req.params ?? {}) as Record<string, unknown>, ctx);
      respond(socket, { id: req.id, result });
    } catch (e: any) {
      respond(socket, { id: req.id, error: { code: -32603, message: e.message ?? String(e) } });
    }
  });
  socket.on('error', () => {/* swallow ECONNRESET etc. */});
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
      const out: Array<Record<string, unknown>> = [];
      for (const [name, st] of ctx.states()) {
        out.push({
          name,
          status: st.status,
          health: st.health,
          port: st.svc.port,
          type: st.svc.type,
          errors: st.errors,
          restarts: st.restarts,
          pid: st.pid,
          startedAt: st.startedAt,
        });
      }
      return { services: out };
    }
    case 'restart': {
      const svc = stringOrThrow(params['svc'] ?? params['service'], 'svc');
      await ctx.restart(svc);
      return { ok: true };
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
