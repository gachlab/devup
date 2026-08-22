import type { ProcessState } from './types.js';

/** Whether a service's process is actually alive.
 *
 *  `state.pid` is not a liveness signal: Spawner's close handler returns early
 *  on an intentional stop and otherwise only touches `status`/`health`, so a
 *  stopped or crashed service keeps a dead pid. Gating on it silently turns a
 *  branch into a permanent no-op. */
export function isRunning(st: ProcessState | undefined): boolean {
  const proc = st?.proc;
  return !!proc && proc.exitCode === null && proc.signalCode === null;
}
