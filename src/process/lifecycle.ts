import type { ChildProcess } from 'node:child_process';
import type { Platform } from '../platform/types.js';
import type { ProcessState } from './types.js';

interface LifecycleOpts {
  state: Map<string, ProcessState>;
  procs: Set<ChildProcess>;
  platform: Platform;
}

/** Owns the kill-tree, watchBuild teardown, and graceful cleanup with SIGKILL
 *  fallback. Stateless beyond what's passed in via opts. */
export class Lifecycle {
  private readonly state: Map<string, ProcessState>;
  private readonly procs: Set<ChildProcess>;
  private readonly platform: Platform;

  constructor(opts: LifecycleOpts) {
    this.state = opts.state;
    this.procs = opts.procs;
    this.platform = opts.platform;
  }

  /** Manual / external stop of a single service. Marks `intentionalStop` so the
   *  close handler doesn't auto-restart, kills the process tree, tears down the
   *  side-car watchBuild process if any. */
  stop(name: string): void {
    const st = this.state.get(name);
    if (!st?.proc || !st.pid) return;
    st.intentionalStop = true;
    this.platform.killTree(st.pid);
    this.stopWatchProc(st);
  }

  /** Tears down the side-car `watchBuild` process for a service (if any) and
   *  clears the reference. Safe to call repeatedly. */
  stopWatchProc(state: ProcessState): void {
    const wp = state.watchProc;
    if (!wp || !wp.pid) return;
    try { this.platform.killTree(wp.pid); } catch { /* already dead */ }
    state.watchProc = null;
  }

  /** Graceful shutdown of every spawned process. Waits `gracePeriodMs` (default
   *  3000) for clean exits, then SIGKILLs anything still alive. */
  async cleanup(opts: { gracePeriodMs?: number } = {}): Promise<void> {
    const grace = opts.gracePeriodMs ?? 3000;
    const procs = [...this.procs];
    if (!procs.length) return;

    for (const proc of procs) {
      const st = this.findStateByProc(proc);
      if (st) {
        st.intentionalStop = true;
        this.stopWatchProc(st);
      }
      if (proc.pid) this.platform.killTree(proc.pid);
    }
    // Any side-car watch processes whose service hasn't been seen above
    // (e.g. preBuild-failed services).
    for (const st of this.state.values()) this.stopWatchProc(st);

    const waits = procs.map(p =>
      p.exitCode !== null || p.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>(resolve => p.once('close', () => resolve())),
    );

    let timedOut = false;
    await Promise.race([
      Promise.all(waits),
      new Promise<void>(resolve => setTimeout(() => { timedOut = true; resolve(); }, grace)),
    ]);

    if (timedOut) {
      for (const proc of procs) {
        if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
          this.platform.killTree(proc.pid, 'SIGKILL');
        }
      }
      await Promise.race([
        Promise.all(waits),
        new Promise<void>(resolve => setTimeout(resolve, 1000)),
      ]);
    }
  }

  private findStateByProc(proc: ChildProcess): ProcessState | undefined {
    for (const st of this.state.values()) if (st.proc === proc) return st;
    return undefined;
  }
}
