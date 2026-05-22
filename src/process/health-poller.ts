import type { ProcessState, ProcessManagerEvents } from './types.js';
import { checkHealth, deriveHealth } from './health.js';

interface HealthPollerOpts {
  state: Map<string, ProcessState>;
  events: ProcessManagerEvents;
}

/** Runs one round of health probes across every service in `state`.
 *  Suppresses probes during `healthCheck.startPeriod` grace window. */
export class HealthPoller {
  private readonly state: Map<string, ProcessState>;
  private readonly events: ProcessManagerEvents;

  constructor(opts: HealthPollerOpts) {
    this.state = opts.state;
    this.events = opts.events;
  }

  async checkAll(): Promise<void> {
    for (const [name, st] of this.state) {
      if (!st.pid || st.status === 'idle') {
        st.health = st.status === 'idle' ? 'idle' : 'down';
        continue;
      }
      // Grace period: suppress probes during the first N seconds after startedAt.
      // Keeps state.errors clean during slow boots (Angular cold-start, etc.).
      const startPeriodMs = (st.svc.healthCheck?.startPeriod ?? 0) * 1000;
      if (startPeriodMs > 0 && st.startedAt && Date.now() - st.startedAt < startPeriodMs) {
        continue; // status stays 'starting', health stays 'wait'
      }
      const isUp = await checkHealth(st.svc.port, st.svc.healthCheck);
      const prev = st.health;
      st.health = deriveHealth(isUp, st.status);
      if (st.health === 'up' && st.status === 'starting') st.status = 'running';
      if (prev !== st.health) this.events.onStateChange(name, st);
    }
  }
}
