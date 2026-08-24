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
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
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
    // Otherwise a queued auto-restart fires ~2 s later and spawns a *second*
    // process for the same name: the first is overwritten in `state` but stays
    // in `procs`, so two processes fight over the port behind one row.
    this.cancel(name);
    this.lifecycle.stop(name);
    // Manual restart: reset auto-restart counter so user gets a fresh budget
    st.restarts = 0;
    const delay = st.proc ? 1500 : 100;
    await new Promise(r => setTimeout(r, delay));
    // A config reload can drop the service inside that settle. Spawner guards
    // its own awaits, but it captures its baseline on entry — by then the
    // removal has already happened, so it has nothing to compare against.
    if (!this.state.has(name)) return;
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
    // Tracked, not fire-and-forget: spawner.start re-inserts into `state`, so
    // a timer left running after the service is removed brings it back — and
    // the daemon would then be running a process no longer in the config.
    const timer = setTimeout(() => {
      this.pending.delete(svc.name);
      // Cleared *after* the spawn, not before it. `start` is async and does not
      // publish `starting` for a while — it awaits `isPortBindable` for an API,
      // and an entire `preBuild` before that — so clearing it up front leaves a
      // window reading `crashed` + budget spent + nothing queued, which is
      // precisely the state a waiter now treats as terminal. A `devup exec`
      // polling every 500 ms would abort during the very restart that saves it.
      void this.spawner.start(svc, colorIdx, true).finally(() => this.clearPending(svc.name));
    }, delay);
    this.pending.set(svc.name, timer);
    // Published so a client can tell "out of budget" from "about to come back".
    state.restartPendingUntil = Date.now() + delay;
    this.events.onStateChange(svc.name, state);
  }

  /** Cancel a queued auto-restart. Safe to call for a service with none. */
  cancel(name: string): void {
    this.clearPending(name);
    const timer = this.pending.get(name);
    if (!timer) return;
    clearTimeout(timer);
    this.pending.delete(name);
  }

  /** Stop advertising a queued restart, and say so.
   *
   *  The emit matters as much as the clear: a `status.follow` consumer holds
   *  the last frame it was pushed, so without it the TUI and the VS Code
   *  extension keep showing a countdown that never resolves. `start` can also
   *  return without replacing the state object at all — the "already running,
   *  leaving it alone" path — and then nothing else would ever clear it. */
  private clearPending(name: string): void {
    const st = this.state.get(name);
    if (!st || st.restartPendingUntil == null) return;
    st.restartPendingUntil = null;
    this.events.onStateChange(name, st);
  }
}
