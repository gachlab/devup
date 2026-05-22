import type { ServiceConfig } from '../config/types.js';
import type { ProcessState, ProcessManagerEvents } from './types.js';
import type { Spawner } from './spawner.js';
import type { Lifecycle } from './lifecycle.js';
import { MAX_RESTARTS, BACKOFF_BASE_MS } from './internals.js';

interface RestarterOpts {
  state: Map<string, ProcessState>;
  events: ProcessManagerEvents;
  spawner: Spawner;
  lifecycle: Lifecycle;
}

/** Two responsibilities:
 *  1. Manual restart (`restart(name)`) — full stop + respawn, **resets** the
 *     auto-restart counter so the user gets a fresh budget.
 *  2. Auto-restart on crash (`scheduleAutoRestart`) — exponential backoff,
 *     capped at MAX_RESTARTS. Spawner invokes this in its close handler. */
export class Restarter {
  private readonly state: Map<string, ProcessState>;
  private readonly events: ProcessManagerEvents;
  private readonly spawner: Spawner;
  private readonly lifecycle: Lifecycle;

  constructor(opts: RestarterOpts) {
    this.state = opts.state;
    this.events = opts.events;
    this.spawner = opts.spawner;
    this.lifecycle = opts.lifecycle;
  }

  async restart(name: string): Promise<void> {
    const st = this.state.get(name);
    if (!st) return;
    this.lifecycle.stop(name);
    // Manual restart: reset auto-restart counter so user gets a fresh budget
    st.restarts = 0;
    const delay = st.proc ? 1500 : 100;
    await new Promise(r => setTimeout(r, delay));
    await this.spawner.start(st.svc, st.colorIdx, true);
    this.events.onLog(name, '🔄 manual restart', st.colorIdx);
  }

  scheduleAutoRestart(svc: ServiceConfig, state: ProcessState, colorIdx: number): void {
    if (state.restarts >= MAX_RESTARTS) {
      this.events.onLog(svc.name, '⛔ max restarts reached', colorIdx);
      return;
    }
    state.restarts++;
    const delay = BACKOFF_BASE_MS * Math.pow(2, state.restarts - 1);
    this.events.onLog(svc.name, `🔄 auto-restart ${state.restarts}/${MAX_RESTARTS} in ${delay}ms...`, colorIdx);
    setTimeout(() => void this.spawner.start(svc, colorIdx, true), delay);
  }
}
