/** The wire shape of the control plane.
 *
 *  These types are the ones a client sees. They live apart from
 *  `socket-server.ts` so `./client` can be imported without dragging the
 *  server in, and apart from `process/types.ts` because `ProcessState` holds
 *  live handles (`proc`, `watchProc`) that never cross the socket.
 *
 *  Changing anything here is an API change — see the three-places note in
 *  CLAUDE.md and `docs/control-plane.md`. */
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
   *  Added in 0.12.0; absent from earlier daemons. */
  originalPort: number;
  type: 'api' | 'web';
  phase: number;
  cmd: string;
  cwd: string;
  errors: number;
  restarts: number;
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
   *  runs under `--inspect`. Added in 0.14.0. */
  debugPort: number | null;
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

export interface ProjectInfo {
  project: string;
  profiles: Record<string, string[]>;
}

export interface PingResult {
  ok: boolean;
  /** The **daemon's** clock, not yours. */
  ts: number;
}

export interface OkResult {
  ok: boolean;
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
}

/** A pushed frame from `status.follow` / `logs.follow`. */
export interface StreamFrame {
  event: string;
  data: unknown;
  svc?: string;
}
