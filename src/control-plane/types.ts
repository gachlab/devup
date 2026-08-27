/** The wire shape of the control plane.
 *
 *  These types are the ones a client sees. They live apart from
 *  `socket-server.ts` so `./client` can be imported without dragging the
 *  server in, and apart from `process/types.ts` because `ProcessState` holds
 *  live handles (`proc`, `watchProc`) that never cross the socket.
 *
 *  Changing anything here is an API change — see the three-places note in
 *  CLAUDE.md and `docs/control-plane.md`.
 *
 *  **These types describe the daemon that ships with this version of the
 *  package.** A devup installed globally can be older than the copy a project
 *  depends on, and an older daemon omits fields added since — `originalPort`
 *  (0.12.0), `debugPort` (0.14.0). They are typed as present anyway: making
 *  them optional would push a `?? fallback` onto every call site, which is the
 *  hand-written guessing this module exists to end. Ask the daemon what it is
 *  instead of guarding each field. */
import type { ProcessStatus, HealthStatus } from '../process/types.js';

export type { ProcessStatus, HealthStatus };

/** One service in a `status` result or a `status.follow` frame.
 *
 *  Produced by `serializeState`, which is typed as returning this — so a field
 *  renamed there stops compiling here instead of surfacing in a client. */
export interface ServiceSnapshot {
  name: string;
  status: ProcessStatus;
  health: HealthStatus;
  /** Where the **service process** listens. For a lazy service this is *not*
   *  the configured port: devup runs it on `port + 10000` and keeps the
   *  on-demand proxy on the configured one. Attach a debugger here; connect to
   *  `originalPort`. */
  port: number;
  /** The **configured** port, and the one to connect to — the lazy proxy
   *  listens there, so reaching it starts the service on demand. Equal to
   *  `port` for always-on services and whenever lazy mode is off.
   *  Sent since 0.12.0 — see the note on daemon age at the top of this file. */
  originalPort: number;
  type: 'api' | 'web';
  phase: number;
  cmd: string;
  cwd: string;
  errors: number;
  /** Auto-restarts left behind — a **budget**, not a history: every manual
   *  restart and every explicit start resets it to 0. Do not use it to ask
   *  whether something died between two moments; use `crashes`. */
  restarts: number;
  /** How many times this service has crashed since the daemon started. Only
   *  ever goes up, which is what makes it usable as a window signal — see
   *  `devup exec --fail-on-crash`. Sent since 0.16.0. */
  crashes: number;
  /** Milliseconds until the queued auto-restart fires, or `null` when none is
   *  queued.
   *
   *  Relative, not an absolute timestamp: a client comparing the daemon's clock
   *  against its own gets the answer wrong by whatever they disagree on, and
   *  every consumer would have to do that subtraction.
   *
   *  This is what separates a service that has spent its restart budget from
   *  one that is eight seconds away from coming back — `Restarter` raises
   *  `restarts` to the maximum *before* scheduling the final attempt, so
   *  `status`/`restarts` alone cannot tell them apart, and a wait that gives up
   *  on the wrong one aborts a run that was about to succeed. Sent since
   *  0.17.0. */
  restartPendingIn: number | null;
  /** OS pid, `null` when not currently running. Note that a **stopped or
   *  crashed service keeps a dead pid** in the daemon's own state; this field
   *  is nulled on the idle transitions only. Use `status`/`health` for
   *  liveness, never this. */
  pid: number | null;
  /** Epoch ms of the current spawn, `null` when not running. */
  startedAt: number | null;
  /** Last stderr lines captured when the service crashed, else `null`. */
  crashLog: string[] | null;
  /** Port Node's inspector bound to, once announced. `null` unless the service
   *  runs under `--inspect`. Sent since 0.14.0 — see the note on daemon age at
   *  the top of this file. */
  debugPort: number | null;
  /** Set when the service is not a local process at all: devup holds its
   *  configured port and forwards to a remote environment. `null` for an
   *  ordinary service. Sent since 0.18.0.
   *
   *  Deliberately an added field rather than a new member of `ProcessStatus`.
   *  Widening that union breaks every exhaustive switch written against it,
   *  including the hand-written copy in gachlab/devup-vscode; a client that
   *  does not know this field yet renders a remote service as the running
   *  service it is — wrong in detail, right in substance.
   *
   *  Two things follow from it that a client cannot infer from anywhere else.
   *  `pid` is null and stays null, so anything offering to attach a debugger
   *  has nothing to attach to. And there is no process to sample, so the
   *  service is absent from `stats` — which is not the same as 0% CPU. */
  remote: RemoteInfo | null;
}

export interface RemoteInfo {
  /** Which entry of `config.environments` serves it. */
  envName: string;
  /** Absolute upstream base, e.g. `https://check-in-api.qa.norelian.com`. */
  target: string;
  /** Whether writes are refused with 405. When false — the default — requests
   *  made against this port change data in a shared environment. */
  readOnly: boolean;
}

export interface ProxyInfo {
  active: boolean;
  provider: string;
  domain: string;
  tls: boolean;
  routes: Record<string, string>;
}

/** The `status` result. Note that `status.follow` frames carry the bare
 *  `ServiceSnapshot[]` as `data`, not this wrapper. */
export interface StatusResult {
  services: ServiceSnapshot[];
  proxy: ProxyInfo | null;
}

export interface ServiceStatEntry {
  cpu: number;   // percent (e.g. 2.3)
  memMB: number; // RSS in MB (e.g. 184.2)
}

export interface StatsResult {
  services: Record<string, ServiceStatEntry>;
  system: {
    totalMemMB: number;
    freeMemMB: number;
    cpuCores: number;
    /** 1-minute load average. Absent on platforms that do not report one
     *  (Windows returns zeroes, so it is omitted there rather than sent as 0). */
    loadAvg1?: number;
    /** Load average as a percentage of available cores — comparable across
     *  machines, and the figure a client wants to show as "CPU". */
    cpuPercent?: number;
  };
}

/** The devup release a daemon reports as `contract`.
 *
 *  A plain integer, bumped whenever `ServiceSnapshot` or the other wire shapes
 *  change in a way a client can see. It exists because the package version
 *  alone makes every client keep its own table of what arrived in which
 *  release — `originalPort` in 0.12.0, `debugPort` in 0.14.0 — and those
 *  tables are exactly what goes stale.
 *
 *  Bump it in the same commit as the shape change, and say so in the
 *  changelog. `npm run contract:update` reminds you, and the golden test pins
 *  the field list against the number so a snapshot change cannot ship without
 *  moving it.
 *
 *  `1` is the shape 0.16.0 settled on. `2` adds `restartPendingIn` to the
 *  snapshot and the window fields to the `logs.follow` ack — 0.16.0 is
 *  published, so this one is a real bump rather than an invented version.
 *  `3` adds `remote` to the snapshot: a service devup serves by forwarding its
 *  configured port to an environment rather than by running a process. */
export const CONTRACT_VERSION = 3;

export interface ProjectInfo {
  project: string;
  /** Which parallel instance this daemon is, from `--instance`. Absent for the
   *  ordinary single stack. Without it two instances of the same project are
   *  indistinguishable over the control plane — and telling them apart is the
   *  entire point of having them. Sent since 0.16.0. */
  instance?: string;
  /** The daemon's own process id.
   *
   *  Not decoration: in lazy mode the on-demand proxy listens on the
   *  *configured* port from inside this process, so when a port conflict names
   *  a holder, this is the pid it names — no service of ours will match it.
   *  Sent since 0.16.0. */
  pid?: number;
  profiles: Record<string, string[]>;
  /** The devup release running this daemon, or `'unknown'` if it could not
   *  read its own manifest. */
  version?: string;
  /** Which revision of the wire shapes this daemon speaks — see
   *  `CONTRACT_VERSION`. What a client actually needs to decide whether it can
   *  trust a field, without keeping a release table of its own. */
  contract?: number;
  /** Every RPC method this daemon answers, streaming ones included. Ask this
   *  instead of probing for an `unknown method` error. */
  methods?: string[];

  // Optional, unlike the snapshot fields — and deliberately so. These three
  // exist to answer "how old is this daemon", so the answer has to survive
  // being asked of an old one: a daemon before 0.16.0 sends none of them, and
  // typing them as always-present would be the exact lie they are here to
  // remove. Their absence *is* the answer.
}

export interface PingResult {
  ok: boolean;
  /** The **daemon's** clock, not yours. */
  ts: number;
}

export interface OkResult {
  ok: boolean;
}

export interface RestartResult {
  /** Whether the service is running again. */
  ok: boolean;
  /** True when it was lazy and idle, so there was nothing to restart — and
   *  waking it is not what someone resetting state between suites asked for.
   *  Sent since 0.16.0. */
  skippedIdle?: boolean;
}

export interface DebugResult {
  debug: boolean;
  /** `null` while the service is still starting — `status` reports it as
   *  `debugPort` once Node announces it. */
  port: number | null;
  /** Whether the service came back up, not whether the request was accepted. */
  ok: boolean;
}

export interface LogsTailResult {
  lines: string[];
  /** When the oldest line **in the files this call read** was written; `null`
   *  when there were none, and `null` too for a plain tail with no `since`,
   *  because that only opens the current file and half an answer to "the
   *  oldest devup holds" is worse than none.
   *
   *  A fact, not a verdict: `oldestRetained > since` means the log *starts*
   *  after your window, which covers both "rotated away" and "the service had
   *  not written yet". devup cannot tell those apart. Sent since 0.16.0. */
  oldestRetained?: number | null;
  /** Whether lines were dropped to fit `lines` — and since the cap keeps the
   *  most recent, what a window loses is its **beginning**. Sent since 0.16.0. */
  truncated?: boolean;

  // Optional, unlike `crashes` and `originalPort` on ServiceSnapshot, and the
  // rule is the failure mode rather than the field's kind: `undefined` here is
  // *silently indistinguishable from a meaningful value*. A client writing
  // `res.oldestRetained > since` against an older daemon gets `false` and
  // concludes its window is whole; `!res.truncated` reads as "nothing was
  // dropped". Where absence lies quietly, the type has to force the branch.
}

/** The ack a `logs.follow` answers with, before the frames start.
 *
 *  Carries the same two window answers as `logs.tail`, when a service was
 *  named and a replay was asked for: a follow that could not say whether its
 *  window lost its beginning made every caller ask twice. Sent since 0.17.0. */
export interface LogsFollowAck {
  ok: boolean;
  /** See `LogsTailResult.oldestRetained`. Absent when no replay was requested. */
  oldestRetained?: number | null;
  /** See `LogsTailResult.truncated`. Absent when no replay was requested. */
  truncated?: boolean;
}

/** A pushed frame from `status.follow` / `logs.follow`. */
export interface StreamFrame {
  event: string;
  data: unknown;
  svc?: string;
}
