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
  /** Side-car watch process spawned alongside the main one (when `watchBuild` is set). */
  watchProc?: ChildProcess | null;
}

export interface ProcessManagerEvents {
  onLog: (svcName: string, text: string, colorIdx: number) => void;
  onStateChange: (name: string, state: ProcessState) => void;
}
