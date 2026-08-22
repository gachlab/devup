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

/** Wait for a service's process to actually exit, up to `timeoutMs`.
 *
 *  `stop()` only delivers SIGTERM, so a service that drains on shutdown is
 *  still "running" by any liveness test for as long as it takes. Starting it
 *  again in that window either no-ops or races the dying process for the port.
 *  Resolves true if it exited, false on timeout. */
export function waitForExit(st: ProcessState, timeoutMs: number): Promise<boolean> {
  const proc = st.proc;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = (v: boolean) => { clearTimeout(timer); proc.off('exit', onExit); resolve(v); };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    proc.once('exit', onExit);
  });
}
