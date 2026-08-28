import type { ProcessState, ProcessManagerEvents } from './types.js';
import { checkHealth, deriveHealth } from './health.js';
import { isRunning } from './liveness.js';

interface HealthPollerOpts {
  state: Map<string, ProcessState>;
  events: ProcessManagerEvents;
}

/** Runs one round of health probes across every service in `state`.
 *  Suppresses probes during `healthCheck.startPeriod` grace window.
 *  Requires `failureThreshold` consecutive failures before marking down. */
export class HealthPoller {
  private readonly state: Map<string, ProcessState>;
  private readonly events: ProcessManagerEvents;
  private readonly failureCounts = new Map<string, number>();

  constructor(opts: HealthPollerOpts) {
    this.state = opts.state;
    this.events = opts.events;
  }

  /** Drop the failure streak for a service that no longer exists.
   *
   *  `checkAll` iterates `state`, so a removed service stops being probed on
   *  its own — but its count would survive and be inherited by a service later
   *  re-added under the same name, which could then be marked down on its very
   *  first failed probe. */
  forget(name: string): void {
    this.failureCounts.delete(name);
  }

  async checkAll(): Promise<void> {
    for (const [name, st] of this.state) {
      // `timeout` used to be skipped here, which made it a state nothing came
      // back from: a service that started slowly and then served perfectly
      // well stayed marked down for the rest of the session. It is probed like
      // any other now, and promoted below when it answers.
      // A remote service has no local process, and probing its port would
      // answer the wrong question: devup's own proxy holds that port, so a
      // check there says "the proxy is listening" and never "the environment
      // is reachable". Worse, it would land in the `!st.pid` branch below and
      // be marked down every round. Its health belongs to the proxy's probe
      // against the upstream — see `createRemoteProxy`.
      if (st.remote) continue;
      if (!isRunning(st) || st.status === 'idle') {
        // `isRunning`, not `!st.pid`: a stopped or crashed service keeps a
        // dead pid (CLAUDE.md §2), so the pid test is the anti-pattern the
        // hazard forbids — in the module most exposed to it. `liveness.ts`
        // exists for exactly this and was adopted at the spawn-race sites but
        // not here.
        const next = st.status === 'idle' ? 'idle' : 'down';
        // Announced, not just written. The idle transition is made from
        // outside the manager (the lazy proxy's `onIdleStop`), which does not
        // emit — and this `continue` used to skip the emit at the bottom of
        // the loop, so nothing ever pushed it. `ctl status` was right because
        // it re-reads the map; `status.follow` showed a lazy service as
        // running/up for the rest of the session after it idled out.
        if (st.health !== next) {
          st.health = next;
          this.events.onStateChange(name, st);
        }
        continue;
      }
      const startPeriodMs = (st.svc.healthCheck?.startPeriod ?? 0) * 1000;
      if (startPeriodMs > 0 && st.startedAt && Date.now() - st.startedAt < startPeriodMs) {
        continue;
      }
      const result = await checkHealth(st.svc.port, st.svc.healthCheck);
      // The probe can outlive the service: a config reload during it removes
      // the entry, and writing the result would push a `status` frame *after*
      // the `removed` one, re-adding the service in every client.
      if (this.state.get(name) !== st) continue;
      const threshold = st.svc.healthCheck?.failureThreshold ?? 2;
      const prev = st.health;

      if (result.ok) {
        this.failureCounts.delete(name);
        // A service that declares a `readyPattern` has said how it announces
        // itself, and its port answering is not that announcement: `ng serve`
        // opens :4200 seconds before the bundle exists, so promoting it here
        // marks a front end ready while a browser still gets nothing. The
        // pattern gets the startup window to itself.
        //
        // Keyed on `health`, **not** on `status === 'starting'`: boot flips
        // every web to `running` the moment it is spawned (`bootStack`), and
        // the poller only starts after
        // that — so a status-based guard never fires for the very services it
        // was written for. `health` is still `wait` until something says
        // otherwise, which is exactly the window meant here.
        //
        // The window ends at `timeout`: once the startup timer has given up,
        // the port is accepted, because a pattern that never matches — a typo,
        // a tool that changed its wording — must not keep a working service
        // marked down for ever.
        if (st.svc.readyPattern && st.health !== 'up' && st.status !== 'timeout') continue;
        st.health = deriveHealth(true, st.status);
        if (st.health === 'up' && (st.status === 'starting' || st.status === 'timeout')) st.status = 'running';
      } else {
        const count = (this.failureCounts.get(name) ?? 0) + 1;
        this.failureCounts.set(name, count);
        if (count >= threshold) {
          const reason = result.reason ?? 'probe failed';
          this.events.onLog(name, `[health] ✗ ${name}: ${reason} (${count} consecutive failure${count > 1 ? 's' : ''})`, st.colorIdx);
          st.health = deriveHealth(false, st.status);
        }
      }

      if (prev !== st.health) this.events.onStateChange(name, st);
    }
  }
}
