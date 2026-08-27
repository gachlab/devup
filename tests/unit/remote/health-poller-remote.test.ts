import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HealthPoller } from '../../../src/process/health-poller.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const svc: ServiceConfig = {
  name: 'app-api', cwd: '.', cmd: 'node', args: ['index.js'], type: 'api', port: 3000, phase: 0,
};

const remoteState = (health: ProcessState['health']): ProcessState => ({
  svc, proc: null, pid: null, status: 'running', health,
  errors: 0, restarts: 0, startedAt: Date.now(), intentionalStop: false,
  colorIdx: 0, crashLog: null,
  remote: { envName: 'qa', target: 'https://app-api.qa.norelian.com', readOnly: false },
});

describe('HealthPoller with remote services', () => {
  it('leaves a remote service alone', async () => {
    // Two ways this goes wrong without the guard, and both are silent: the
    // `!st.pid` branch marks it down every round, and a TCP probe on its port
    // would answer *yes* because devup's own proxy is what is listening —
    // reporting the environment reachable when it may be unreachable.
    const state = new Map<string, ProcessState>([['app-api', remoteState('up')]]);
    const poller = new HealthPoller({
      state,
      events: { onLog: () => {}, onStateChange: () => {} },
    });

    await poller.checkAll();
    assert.equal(state.get('app-api')!.health, 'up');
  });

  it('does not promote a remote service the probe has not answered for yet', async () => {
    const state = new Map<string, ProcessState>([['app-api', remoteState('wait')]]);
    const poller = new HealthPoller({
      state,
      events: { onLog: () => {}, onStateChange: () => {} },
    });

    await poller.checkAll();
    assert.equal(state.get('app-api')!.health, 'wait');
  });
});
