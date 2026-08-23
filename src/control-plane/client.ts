/** Client for the devup control plane.
 *
 *  Public API — exported as `@gachlab/devup/client`. Anything reachable from
 *  here is something consumers can depend on, so additions are cheap and
 *  removals are not. See docs/control-plane.md.
 *
 *  The transport is newline-delimited JSON over a Unix socket: one connection
 *  per one-shot call, a persistent one for the `*.follow` methods. */
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { defaultSocketPath } from './socket-path.js';
import type {
  DebugResult, LogsTailResult, OkResult, PingResult, ProjectInfo,
  StatsResult, StatusResult, StreamFrame,
} from './types.js';

export { defaultSocketPath };
export type {
  ServiceSnapshot, ProxyInfo, StatusResult, StatsResult, ServiceStatEntry,
  ProjectInfo, PingResult, OkResult, DebugResult, LogsTailResult, StreamFrame,
  ProcessStatus, HealthStatus,
} from './types.js';

/** Resolve the socket path, preferring an explicit override. */
export function resolveSocket(projectName: string, overridePath?: string): string {
  return overridePath ?? defaultSocketPath(projectName);
}

/** Throw a friendly error if the socket doesn't exist (devup not running). */
export function assertSocketExists(socketPath: string, projectName: string): void {
  if (!existsSync(socketPath)) {
    throw new Error(
      `devup is not running for project "${projectName}".\nStart it with \`devup\` first.`,
    );
  }
}

export interface SendRpcOpts {
  /** Give up after this many ms. Unset means wait indefinitely, which is the
   *  historical behaviour and the right one for `debug` and `restart` — both
   *  restart a service and can legitimately take a minute. Set it for calls a
   *  script must not hang on. */
  timeoutMs?: number;
}

/** Send a single RPC request and return the result, or throw on error. */
export function sendRpc(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: SendRpcOpts = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = () => {
      settled = true;
      if (timer) clearTimeout(timer);
    };
    const fail = (err: Error) => { if (!settled) { finish(); reject(err); } };
    const ok = (v: unknown) => { if (!settled) { finish(); resolve(v); } };

    const c = createConnection(socketPath);
    const rl = createInterface({ input: c });
    // Both the socket AND the readline interface can emit 'error' (readline
    // re-forwards errors from its input stream). Attach to BOTH so an
    // ECONNREFUSED on the socket can't escape as an unhandled error event.
    c.on('error', fail);
    rl.on('error', fail);
    // A daemon that dies mid-request closes the socket without ever sending a
    // line. Without this the promise never settles and the caller hangs for
    // good — the failure mode a test harness can least afford.
    c.on('close', () => fail(new Error('connection closed before the daemon answered')));
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        // destroy() fires 'close', but `settled` is already true by then.
        c.destroy();
        fail(new Error(`devup did not answer "${method}" within ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
      // Do not hold a script open on our account.
      timer.unref?.();
    }
    rl.once('line', l => {
      c.end();
      try {
        const msg = JSON.parse(l);
        if (msg.error) fail(new Error(msg.error.message ?? String(msg.error)));
        else ok(msg.result);
      } catch (e: any) {
        fail(e);
      }
    });
    c.write(JSON.stringify({ id: 1, method, params }) + '\n');
  });
}

/** Open a streaming RPC (logs.follow / status.follow).
 *  Returns an abort function. The stream runs until abort() is called or the socket closes.
 *
 *  **A throw from `onFrame` is not caught.** It escapes as an uncaught
 *  exception and takes the host process with it — deliberately, because
 *  swallowing it is how `ctl status --follow` once came to print nothing at
 *  all. Wrap your own handler if you are streaming from inside a long-lived
 *  process that must survive a bad frame. */
export function openStream(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  onFrame: (frame: StreamFrame) => void,
  onError?: (err: Error) => void,
): () => void {
  const c = createConnection(socketPath);
  const rl = createInterface({ input: c });
  let ackDone = false;

  // Both the socket and the readline interface can emit 'error'. Listen on
  // both — without an rl handler an ECONNREFUSED can escape as an unhandled
  // 'error' event and crash the host process.
  const onErr = (err: Error) => onError?.(err);
  c.on('error', onErr);
  rl.on('error', onErr);
  c.write(JSON.stringify({ id: 1, method, params }) + '\n');

  rl.on('line', l => {
    let msg: { error?: { message?: string }; event?: string };
    try {
      msg = JSON.parse(l);
    } catch {
      return; // malformed frame — skip it
    }
    // `null` parses fine but is not a frame; reading .error off it would throw
    // out of this listener and take the process down.
    if (!msg || typeof msg !== 'object') return;
    if (!ackDone) {
      ackDone = true;
      if (msg.error) { onError?.(new Error(msg.error.message ?? String(msg.error))); c.destroy(); }
      return;
    }
    // Deliberately outside the try: a throw from onFrame is a bug in the
    // consumer, not a malformed frame, and swallowing it hides the failure —
    // that is how `ctl status --follow` came to print nothing at all when the
    // `removed` event was added. A throw here escapes the 'line' listener and
    // ends the process, which is the right trade for the CLI, where a visible
    // stack beats silence. Documented on the export above.
    if (msg.event) onFrame(msg as StreamFrame);
  });

  return () => c.destroy();
}

// ── Named methods ──────────────────────────────────────────────────────────

/** A typed handle on one daemon.
 *
 *  Thin on purpose: every method is `sendRpc` with the right name and a return
 *  type. It exists so a consumer does not have to cast `unknown` at each call
 *  site — casting is exactly how a client ends up re-describing the protocol
 *  by hand, which is what this module is here to stop. */
export interface DevupClient {
  /** The socket this client talks to. */
  readonly socketPath: string;
  /** Is the daemon there? Prefer this over stat-ing the socket file: a stale
   *  socket from a crashed run exists but answers nothing. */
  ping(): Promise<PingResult>;
  /** Every service, plus the active proxy config (`null` when none). */
  status(): Promise<StatusResult>;
  /** Project name, profiles from config. */
  info(): Promise<ProjectInfo>;
  /** Per-service CPU/memory plus host totals. */
  stats(): Promise<StatsResult>;
  /** Start a stopped service. `ok` is the **outcome**: `false` means it did
   *  not come up, not that the request was refused. */
  start(svc: string): Promise<OkResult>;
  /** Restart a service. Resolves once the request is accepted; the respawn is
   *  async, so poll `status` to see the result. An unknown name is a silent
   *  no-op that still answers `ok: true`. */
  restart(svc: string): Promise<OkResult>;
  /** SIGTERM the service's process tree and suppress the auto-restart. */
  stop(svc: string): Promise<OkResult>;
  /** Restart a service under (or out of) the Node inspector. Omitted options
   *  take the daemon's defaults: `enable` true, an OS-chosen port, no `brk`. */
  debug(svc: string, opts?: { enable?: boolean; port?: number; brk?: boolean }): Promise<DebugResult>;
  /** Last N lines of a service's persisted log file — the daemon's default is
   *  100, capped at 10 000. Empty when the log sink is off (`--no-log-file`)
   *  or the service has not written yet. */
  logsTail(svc: string, opts?: { lines?: number }): Promise<LogsTailResult>;
  /** Live service state. The first frame is the **whole** snapshot; every
   *  later one carries a single service — merge by `name`. `removed` frames
   *  carry an array of names, not services. Returns an abort function. */
  followStatus(onFrame: (frame: StreamFrame) => void, onError?: (err: Error) => void): () => void;
  /** Live log lines, replaying `tail` recent ones first (the daemon's default
   *  is 50). Pass `svc: null` for every service. Returns an abort function. */
  followLogs(
    svc: string | null,
    onFrame: (frame: StreamFrame) => void,
    opts?: { tail?: number; onError?: (err: Error) => void },
  ): () => void;
  /** Any method, including ones newer than this client. The escape hatch for
   *  everything the named methods do not cover. */
  call(method: string, params?: Record<string, unknown>, opts?: SendRpcOpts): Promise<unknown>;
}

export type CreateClientOpts = SendRpcOpts;

/** Build a client for a socket path.
 *
 *  A `timeoutMs` here applies to every one-shot call. Leave it unset for
 *  `restart` and `debug`, which restart a service and can legitimately take a
 *  minute — a slow pre-build is not a dead daemon.
 *
 *  Does not connect: there is no persistent connection to hold, and a client
 *  built before the daemon starts is valid the moment it does. Use `ping()` to
 *  find out whether anyone is home. */
export function createClient(socketPath: string, opts: CreateClientOpts = {}): DevupClient {
  const call = (method: string, params: Record<string, unknown> = {}, o: SendRpcOpts = {}) =>
    sendRpc(socketPath, method, params, { ...opts, ...o });

  return {
    socketPath,
    call,
    ping: () => call('ping') as Promise<PingResult>,
    status: () => call('status') as Promise<StatusResult>,
    info: () => call('info') as Promise<ProjectInfo>,
    stats: () => call('stats') as Promise<StatsResult>,
    start: svc => call('start', { svc }) as Promise<OkResult>,
    restart: svc => call('restart', { svc }) as Promise<OkResult>,
    stop: svc => call('stop', { svc }) as Promise<OkResult>,
    // Omitted options are left out of the request rather than filled in here:
    // the daemon already has the defaults, and a second copy of them in the
    // client is one more thing to drift.
    debug: (svc, o = {}) => call('debug', { svc, enable: o.enable, port: o.port, brk: o.brk }) as Promise<DebugResult>,
    logsTail: (svc, o = {}) => call('logs.tail', { svc, lines: o.lines }) as Promise<LogsTailResult>,
    followStatus: (onFrame, onError) => openStream(socketPath, 'status.follow', {}, onFrame, onError),
    // `svc: null` is sent, not dropped: it is how a caller asks for every
    // service, and the daemon reads a missing key the same way.
    followLogs: (svc, onFrame, o = {}) =>
      openStream(socketPath, 'logs.follow', { svc, tail: o.tail }, onFrame, o.onError),
  };
}

/** `createClient` for a project name, using the default socket location.
 *  Same as `createClient(resolveSocket(projectName, overridePath))`. */
export function createClientForProject(
  projectName: string,
  opts: CreateClientOpts & { socketPath?: string } = {},
): DevupClient {
  const { socketPath, ...rest } = opts;
  return createClient(resolveSocket(projectName, socketPath), rest);
}
