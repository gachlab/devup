import type { ProcessState, ProcessManagerEvents } from './types.js';
import { checkHealth, deriveHealth } from './health.js';

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
      if (!st.pid || st.status === 'idle' || st.status === 'timeout') {
        st.health = st.status === 'idle' ? 'idle' : 'down';
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
        st.health = deriveHealth(true, st.status);
        if (st.health === 'up' && st.status === 'starting') st.status = 'running';
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
