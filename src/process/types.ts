import type { ChildProcess } from 'node:child_process';
import type { ServiceConfig } from '../config/types.js';

export type ProcessStatus = 'starting' | 'running' | 'stopped' | 'crashed' | 'idle' | 'timeout';
export type HealthStatus = 'up' | 'down' | 'wait' | 'idle';

export interface ProcessState {
  svc: ServiceConfig;
  proc: ChildProcess | null;
  pid: number | null;
  status: ProcessStatus;
  health: HealthStatus;
  errors: number;
  restarts: number;
  startedAt: number | null;
  intentionalStop: boolean;
  colorIdx: number;
  /** Last N stderr lines captured before most recent crash. Null when not crashed or after clean restart. */
  crashLog: string[] | null;
  /** Epoch ms when the queued auto-restart is due, or null when none is.
   *
   *  The reason it exists: `Restarter` bumps `restarts` to `MAX_RESTARTS` and
   *  *then* schedules the last attempt, so "crashed and out of budget" is also
   *  what a service looks like for the eight seconds before the restart that
   *  saves it. Nothing else tells the two apart, and a wait that gives up on
   *  the wrong one aborts a run that was about to succeed. */
  restartPendingUntil?: number | null;
  /** How many times this service has crashed since the daemon started.
   *
   *  Distinct from `restarts`, which is a **budget** and gets reset to 0 by
   *  every manual restart and every explicit start — so it cannot answer "did
   *  anything die between these two moments?", which is what `devup exec
   *  --fail-on-crash` has to know. This one only ever goes up. */
  crashes?: number;
  /** Side-car watch process spawned alongside the main one (when `watchBuild` is set). */
  watchProc?: ChildProcess | null;
  /** Port the Node inspector bound to, parsed from the process's startup line.
   *  Null unless the service is running under `--inspect`. */
  debugPort?: number | null;
  /** Set when this service is not a process at all: devup holds its configured
   *  port and forwards to a remote environment.
   *
   *  Anything that reasons about a local process has to check this first.
   *  `pid` is null and stays null, and the port answers unconditionally
   *  because devup's own proxy is what answers — so a TCP probe there reports
   *  a healthy service no matter what the environment is doing. */
  remote?: RemoteState;
}

export interface RemoteState {
  /** Which entry of `config.environments` this is served from. */
  envName: string;
  /** Absolute upstream base, e.g. `https://check-in-api.qa.norelian.com`. */
  target: string;
  /** Whether writes are refused with 405. */
  readOnly: boolean;
}

export interface ProcessManagerEvents {
  onLog: (svcName: string, text: string, colorIdx: number) => void;
  onStateChange: (name: string, state: ProcessState) => void;
  /** A service left the running set — removed by a config reload, not stopped.
   *  Optional so existing consumers (TUI, `--once`) need no change. */
  onServiceRemoved?: (name: string) => void;
}
