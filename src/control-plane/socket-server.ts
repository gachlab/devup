import { connect, createServer, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { existsSync, unlinkSync, chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProcessState } from '../process/types.js';
import { defaultSocketPath } from './socket-path.js';
import { readVersion } from '../utils/version.js';
import type { LogWindow, LogWindowOpts } from '../process/log-reader.js';
import { CONTRACT_VERSION } from './types.js';
import type {
  RemoteResult,
  RestartResult,
  StartResult,
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
  /** Restart a service by name, through its lazy proxy when it has one.
   *  Reports whether it came back, and whether it was left asleep. */
  restart(name: string): Promise<RestartResult>;
  /** Stop a service by name. */
  stop(name: string): void;
  /** Read a window out of the service's persistent log — the last N lines, or
   *  everything written since a timestamp. See `readLogWindow`. */
  tailLogs(svcName: string, opts: LogWindowOpts): Promise<LogWindow>;
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
  /** Start a stopped service. `ok` is whether it is up — the spawner returns
   *  normally after recording a crash, so "no exception" is not success.
   *  Already running counts as up, and so does a service served from an
   *  environment, which reports `skippedRemote` to say devup spawned nothing. */
  start(name: string): Promise<StartResult>;
  /** Per-service CPU/mem stats + system totals. */
  getStats(): Promise<StatsResult>;
  /** Active proxy configuration, or null when no proxy is running. */
  getProxyInfo(): ProxyInfo | null;
  /** Project metadata: name, instance, and the profiles defined in config. */
  getInfo(): ProjectInfo;
  /** Move a service between running locally and being served from a named
   *  environment. `null` brings it back local. Reports the outcome, not that
   *  the request was accepted: the port has to change hands, and it can fail
   *  to. */
  setRemote(name: string, envName: string | null): Promise<RemoteResult>;
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

  // A socket file from a run that crashed is stale and goes; one that still
  // answers belongs to a live devup — a second TUI for the same project, say.
  // Unlinking that one took its control plane away, and whichever of the two
  // exited first then deleted the other's socket.
  if (existsSync(path)) {
    let isSocket = false;
    try { isSocket = statSync(path).isSocket(); } catch { /* listen() will say */ }
    if (isSocket) {
      if (await socketAnswers(path)) {
        throw new Error(`another devup is already serving ${path} — use --instance <name> to run a second stack`);
      }
      try { unlinkSync(path); } catch { /* listen() will surface the real error */ }
    }
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
    if (STREAM_METHODS.includes(req.method)) {
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
  // A subscription made after the client already left — `logs.follow` awaits
  // a replay of up to 10 MB first — would never be released: 'close' has
  // fired. Each abandoned follow (the extension reconnecting) used to leave a
  // listener running on every log line for the life of the daemon.
  const keep = (unsub: () => void) => {
    if (socket.destroyed) unsub();
    else unsubs.add(unsub);
  };
  if (req.method === 'logs.follow') {
    const rawSvc = params['svc'] ?? params['service'];
    const svcName = rawSvc != null ? stringOrThrow(rawSvc, 'svc') : null;
    const tail = clampTail(params['tail']);
    // The replay can be a window too. Someone watching a service that just
    // failed a test wants the window *and* what happens next, and offering
    // `--since` alongside `--follow` and then ignoring it is the quiet wrong
    // answer this whole change is against.
    const rawSince = params['since'];
    if (rawSince !== undefined && rawSince !== null && typeof rawSince !== 'number') {
      throw new Error('param "since" must be a number (epoch milliseconds)');
    }
    const since = typeof rawSince === 'number' ? rawSince : undefined;

    // The replay is read *before* the ack, so the ack can carry what the
    // window turned out to be — `oldestRetained` and `truncated`, the same two
    // `logs.tail` answers. Without them a follow could not say whether the
    // window lost its beginning, and `devup ctl logs --since … --follow` had
    // to ask the daemon a second time just to find out.
    let replay: { lines: string[]; oldestRetained: number | null; truncated: boolean } | null = null;
    if (svcName && tail > 0) {
      replay = await ctx.tailLogs(svcName, { lines: tail, since });
    }
    respond(socket, {
      id: req.id,
      result: {
        ok: true,
        ...(replay ? { oldestRetained: replay.oldestRetained, truncated: replay.truncated } : {}),
      },
    });

    if (replay) {
      const { lines } = replay;
      for (const l of lines) {
        // `svc` on the replay too: a client routing by frame.svc would drop or
        // misattribute the whole tail otherwise.
        // Paced: up to 1000 lines of any length go out at once, faster than
        // any socket drains, so the replay waits for the client rather than
        // piling up — it is bounded, and the client is reading.
        await respondPaced(socket, { id: req.id, event: 'log', data: l, svc: svcName });
        if (socket.destroyed) return;
      }
    }

    const unsub = ctx.watchLogs(svcName, logFeed(socket, req.id));
    keep(unsub);

  } else if (req.method === 'status.follow') {
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
    keep(unsub);

    const unsubRemoved = ctx.watchRemoved(name => {
      respond(socket, { id: req.id, event: 'removed', data: [name] });
    });
    keep(unsubRemoved);

  } else {
    // `handleClient` routes here off STREAM_METHODS, so a name added there and
    // not here used to fall into the `status.follow` arm: the daemon would ack
    // it, push a status snapshot and register watchers, all under a method it
    // was never asked for. Removing one hand-kept list only to leave the
    // routing branch as the next one is not a fix.
    throw new Error(`unknown method: ${req.method}`);
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
    originalPort: st.svc.originalPort ?? st.svc.port,
    type: st.svc.type,
    phase: st.svc.phase,
    cmd: st.svc.cmd,
    cwd: st.svc.cwd,
    errors: st.errors,
    restarts: st.restarts,
    crashes: st.crashes ?? 0,
    // Relative on the wire; see the field's note.
    restartPendingIn: st.restartPendingUntil != null
      ? Math.max(0, st.restartPendingUntil - Date.now())
      : null,
    pid: st.pid,
    startedAt: st.startedAt,
    crashLog: st.crashLog ?? null,
    debugPort: st.debugPort ?? null,
    // Null rather than omitted: a client reading `snapshot.remote?.envName`
    // gets the same answer either way, and the field being always present is
    // what lets the golden test pin it.
    remote: st.remote
      ? { envName: st.remote.envName, target: st.remote.target, readOnly: st.remote.readOnly }
      : null,
  };
}

/** How much live log output may sit unsent for one follower. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

function respond(socket: Socket, payload: object): void {
  if (socket.writable) socket.write(JSON.stringify(payload) + '\n');
}

/** Write, then wait until the socket can take more. */
function respondPaced(socket: Socket, payload: object): Promise<void> {
  if (!socket.writable) return Promise.resolve();
  if (socket.write(JSON.stringify(payload) + '\n')) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { socket.off('drain', done); socket.off('close', done); resolve(); };
    socket.once('drain', done);
    socket.once('close', done);
  });
}

/** The live half of `logs.follow`. A follower that stops reading — `devup ctl
 *  logs -f | less` while paused, a hung extension — made the daemon buffer
 *  every line for it, without limit. Past the cap, lines are skipped instead,
 *  and once the client catches up it is told how many, as an ordinary `log`
 *  frame. The connection stays: the VS Code extension does not reconnect a
 *  closed log stream, and dropping it would end the user's log view. */
function logFeed(socket: Socket, id: unknown): (svc: string, line: string) => void {
  let dropped = 0;
  const onDrain = () => {
    if (!dropped) return;
    respond(socket, { id, event: 'log', data: `[devup] ${dropped} line(s) dropped: this client fell behind`, svc: 'devup' });
    dropped = 0;
  };
  socket.on('drain', onDrain);
  return (svc, line) => {
    if (socket.writableLength > MAX_BUFFERED_BYTES) { dropped++; return; }
    respond(socket, { id, event: 'log', data: line, svc });
  };
}

/** The RPC methods this daemon serves.
 *
 *  A map rather than a `switch` so `info` can advertise the list without a
 *  second copy of it: `unknown method` is what every client currently probes
 *  for to discover what a daemon can do, and a hand-maintained list would go
 *  stale the first time someone added a method and forgot it. */
type RpcHandler = (params: Record<string, unknown>, ctx: RpcContext) => Promise<unknown> | unknown;

const HANDLER_TABLE = {
  status: (_params, ctx) => {
    const out: ServiceSnapshot[] = [];
    for (const [name, st] of ctx.states()) {
      out.push(serializeState(name, st));
    }
    return { services: out, proxy: ctx.getProxyInfo() };
  },

  stats: (_params, ctx) => ctx.getStats(),

  info: (_params, ctx) => ({
    ...ctx.getInfo(),
    // Composed here rather than asked of the RpcContext: `getInfo` has two
    // implementations (the daemon and the TUI) and they have drifted from
    // each other before. Nothing that is the same for every daemon of a given
    // build should have to be supplied twice.
    version: readVersion(),
    contract: CONTRACT_VERSION,
    methods: METHODS,
    // The daemon's own pid, and composed here for the same reason as the rest:
    // it is the same answer for every daemon of every build, so neither
    // `getInfo` implementation should have to remember to supply it.
    pid: process.pid,
  }),

  restart: async (params, ctx) => {
    const svc = stringOrThrow(params['svc'] ?? params['service'], 'svc');
    // `ok` is the outcome, as it is for `start`: a lazy service restarted
    // through its proxy can fail to come back, and answering `true` regardless
    // would hand a client a tick over a dead service.
    return await ctx.restart(svc);
  },

  start: async (params, ctx) => {
    const svc = stringOrThrow(params['svc'] ?? params['service'], 'svc');
    // `ok` reflects the outcome, not merely that the request was accepted —
    // otherwise a client reports success while the service sits crashed.
    return await ctx.start(svc);
  },

  debug: async (params, ctx) => {
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
  },

  stop: (params, ctx) => {
    const svc = stringOrThrow(params['svc'] ?? params['service'], 'svc');
    ctx.stop(svc);
    return { ok: true };
  },

  remote: async (params, ctx) => {
    const svc = stringOrThrow(params['svc'] ?? params['service'], 'svc');
    const rawEnv = params['env'];
    const local = params['local'];
    if (local !== undefined && typeof local !== 'boolean') {
      throw new Error('param "local" must be a boolean');
    }
    if (rawEnv !== undefined && rawEnv !== null && typeof rawEnv !== 'string') {
      throw new Error('param "env" must be a string');
    }
    // Neither is not "leave it as it is": a caller that meant one and sent
    // neither would get a silent no-op reported as success, and only find out
    // when traffic went somewhere it did not expect.
    if (local !== true && !rawEnv) throw new Error('pass either "env" or "local": true');
    if (local === true && rawEnv) throw new Error('pass "env" or "local", not both');
    return await ctx.setRemote(svc, local === true ? null : rawEnv as string);
  },

  'logs.tail': async (params, ctx) => {
    const svc = stringOrThrow(params['svc'] ?? params['service'], 'svc');
    const lines = clampLines(params['lines']);
    const rawSince = params['since'];
    // Not coerced with Number(): `since: "yesterday"` becoming NaN and then
    // silently meaning "everything" is how a harness attaches the wrong
    // evidence to a failed test and never finds out.
    if (rawSince !== undefined && rawSince !== null && typeof rawSince !== 'number') {
      throw new Error('param "since" must be a number (epoch milliseconds)');
    }
    const since = typeof rawSince === 'number' ? rawSince : undefined;
    if (since !== undefined && !Number.isFinite(since)) {
      throw new Error('param "since" must be a finite number (epoch milliseconds)');
    }
    return await ctx.tailLogs(svc, { lines, since });
  },

  ping: () => ({ ok: true, ts: Date.now() }),
} satisfies Record<string, RpcHandler>;

/** A Map, not the literal above, because a plain object answers for its
 *  prototype: `HANDLERS['toString']` on an object literal is a function, so
 *  `{"method":"toString"}` returned `"[object Undefined]"` instead of `unknown
 *  method`, and `"constructor"` echoed the params back. The method name comes
 *  off the wire, so this is the shape to reach for rather than a `hasOwn`
 *  guard someone has to remember. */
const HANDLERS = new Map<string, RpcHandler>(Object.entries(HANDLER_TABLE));

/** Handled in `handleClient` before `dispatch` ever sees them, so they are not
 *  in HANDLERS — and a client asking what this daemon can do still has to be
 *  told about them.
 *
 *  `handleClient` routes on **this list**, not on its own copy of the two
 *  names. The whole reason `METHODS` is derived from a table is that a
 *  hand-kept list goes stale the first time someone adds a method and forgets
 *  it; a second hand-kept list here would have exactly that problem, and its
 *  failure is quiet — a daemon that answers a method it does not advertise,
 *  so a client checking `info.methods` refuses a feature that works. */
export const STREAM_METHODS: readonly string[] = Object.freeze(['logs.follow', 'status.follow']);

/** Every method this daemon answers, streaming ones included. Advertised by
 *  `info` so a client can ask instead of probing for `unknown method`. */
// Frozen because it is handed back verbatim as the `info` result: a consumer
// that sorted or pushed into it would be changing what the daemon advertises,
// and for STREAM_METHODS also how it routes.
export const METHODS: readonly string[] = Object.freeze([...HANDLERS.keys(), ...STREAM_METHODS].sort());

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  ctx: RpcContext,
): Promise<unknown> {
  const handler = HANDLERS.get(method);
  if (!handler) throw new Error(`unknown method: ${method}`);
  return await handler(params, ctx);
}

/** How many lines to return, or a refusal.
 *
 *  Not `Number(...)`: `lines: "abc"` gave NaN, and `Math.max(1, Math.min(10_000,
 *  NaN))` is NaN, so the reader's `length > opts.lines` cap was never true and
 *  the daemon serialised the whole file — up to 10 MB, and now potentially the
 *  rotated one too — back over the socket. */
export const MAX_LOG_LINES = 10_000;

/** How many lines to replay before going live. Its own ceiling, lower than
 *  `logs.tail`'s: this is a backlog, not a query.
 *
 *  Hardened for the same reason as `lines`. `tail: "abc"` gave NaN, `NaN > 0`
 *  is false, and the replay was skipped in silence — the client got its ack
 *  and an empty backlog with nothing to say why. */
export const MAX_FOLLOW_TAIL = 1_000;

function clampTail(raw: unknown): number {
  if (raw === undefined || raw === null) return 50;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new Error('param "tail" must be a non-negative integer');
  }
  return Math.min(MAX_FOLLOW_TAIL, raw);
}

function clampLines(raw: unknown): number {
  if (raw === undefined || raw === null) return 100;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error('param "lines" must be a positive integer');
  }
  return Math.min(MAX_LOG_LINES, raw);
}

function stringOrThrow(v: unknown, paramName: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`param "${paramName}" must be a non-empty string`);
  }
  return v;
}

/** Whether something is listening on a unix socket path. */
export function socketAnswers(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const c = connect(path);
    const done = (v: boolean) => { clearTimeout(t); c.destroy(); resolve(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
  });
}
