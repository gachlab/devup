import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Platform } from '../platform/types.js';
import type { ServiceConfig } from '../config/types.js';
import type { ProcessState, ProcessManagerEvents } from './types.js';
import { installService } from './installer.js';
import { Spawner } from './spawner.js';
import { Restarter } from './restarter.js';
import { HealthPoller } from './health-poller.js';
import { Lifecycle } from './lifecycle.js';

// Re-export the helpers + constants so existing imports keep working.
export { compileReadyPattern, extractWatchPaths } from './internals.js';

/** Thin facade composing Spawner, Restarter, HealthPoller, and Lifecycle.
 *  All four components share the same `state` Map and `procs` Set, so
 *  mutations from one are visible to the others.
 *
 *  Public API is unchanged from the pre-refactor monolithic class —
 *  every TUI / orchestrator / control-plane call site keeps working. */
export class ProcessManager {
  readonly state = new Map<string, ProcessState>();
  private readonly procs = new Set<ChildProcess>();
  private readonly baseCwd: string;
  private readonly env: Record<string, string>;
  private readonly events: ProcessManagerEvents;
  private readonly spawner: Spawner;
  private readonly restarter: Restarter;
  private readonly healthPoller: HealthPoller;
  private readonly lifecycle: Lifecycle;

  constructor(opts: {
    baseCwd: string;
    env: Record<string, string>;
    platform: Platform;
    events: ProcessManagerEvents;
  }) {
    this.baseCwd = opts.baseCwd;
    this.env = opts.env;
    this.events = opts.events;

    this.lifecycle = new Lifecycle({
      state: this.state, procs: this.procs, platform: opts.platform,
    });

    // Forward declaration: the spawner needs onCrash, which the restarter implements.
    // We assign after both exist via the closure below.
    let restarterRef: Restarter | null = null;
    this.spawner = new Spawner({
      baseCwd: opts.baseCwd, env: opts.env,
      state: this.state, procs: this.procs,
      events: opts.events, lifecycle: this.lifecycle,
      onCrash: (svc, state, colorIdx) => restarterRef?.scheduleAutoRestart(svc, state, colorIdx),
    });
    this.restarter = new Restarter({
      state: this.state, events: opts.events,
      spawner: this.spawner, lifecycle: this.lifecycle,
    });
    restarterRef = this.restarter;

    this.healthPoller = new HealthPoller({
      state: this.state, events: opts.events,
    });
  }

  install(svc: ServiceConfig, colorIdx?: number): Promise<boolean> {
    const cwd = join(this.baseCwd, svc.cwd);
    const idx = colorIdx ?? this.state.get(svc.name)?.colorIdx ?? 0;
    return installService(cwd, this.env, msg => this.events.onLog(svc.name, msg, idx));
  }

  start(svc: ServiceConfig, colorIdx: number, isRestart = false): Promise<void> {
    return this.spawner.start(svc, colorIdx, isRestart);
  }

  stop(name: string): void {
    this.lifecycle.stop(name);
  }

  restart(name: string): Promise<void> {
    return this.restarter.restart(name);
  }

  checkAllHealth(): Promise<void> {
    return this.healthPoller.checkAll();
  }

  cleanup(opts: { gracePeriodMs?: number } = {}): Promise<void> {
    return this.lifecycle.cleanup(opts);
  }
}
