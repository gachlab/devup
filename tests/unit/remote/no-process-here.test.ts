import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from '../../../src/process/start-service.js';
import { restartService } from '../../../src/process/restart-service.js';
import { debugService } from '../../../src/process/debug-service.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const svc: ServiceConfig = {
  name: 'app-api', cwd: '.', cmd: 'node', args: ['index.js'], type: 'api', port: 3000, phase: 0,
};

const remoteState = (): ProcessState => ({
  svc, proc: null, pid: null, status: 'running', health: 'up',
  errors: 0, restarts: 0, startedAt: Date.now(), intentionalStop: false,
  colorIdx: 0, crashLog: null,
  remote: { envName: 'qa', target: 'https://app-api.qa.norelian.com', readOnly: false },
});

function mkHost(state: Map<string, ProcessState>) {
  const calls = { installed: 0, started: 0, stopped: 0, cancelled: 0 };
  return {
    calls,
    host: {
      state,
      install: async () => { calls.installed++; return true; },
      start: async () => { calls.started++; },
      stop: () => { calls.stopped++; },
      cancelPendingRestart: () => { calls.cancelled++; },
    },
  };
}

describe('a service with no process here', () => {
  it('start reports it is serving and names the environment, without spawning', async () => {
    // `ok: true` because it *is* answering — from somewhere else. Saying
    // `false` would call a perfectly healthy service a failure; saying `true`
    // with nothing else would claim a spawn that never happened.
    const state = new Map([['app-api', remoteState()]]);
    const { host, calls } = mkHost(state);
    const res = await startService(host, undefined, 'app-api');
    assert.deepEqual(res, { ok: true, skippedRemote: 'qa' });
    assert.equal(calls.started, 0);
    assert.equal(calls.installed, 0, 'it ran an install for a service it was never going to spawn');
  });

  it('restart skips it rather than failing the batch', async () => {
    // `restart --all` on a hybrid stack is an ordinary thing to do between
    // suites. Reporting these as failures would exit 1 on a healthy stack.
    const state = new Map([['app-api', remoteState()]]);
    const { host, calls } = mkHost(state);
    const res = await restartService(host, undefined, 'app-api');
    assert.deepEqual(res, { ok: true, skippedIdle: false, skippedRemote: 'qa' });
    assert.equal(calls.stopped, 0, 'it called stop on something with no process');
    assert.equal(calls.started, 0);
  });

  it('restart leaves the remote marker and the status alone', async () => {
    // The failure this replaces: the port guard in the spawner saw the port
    // held by devup's own proxy, could not recognise it as ours, and called
    // `recordCrashedState` — which builds a fresh state object and drops
    // `remote`. A service serving QA perfectly showed up as crashed.
    const state = new Map([['app-api', remoteState()]]);
    const { host } = mkHost(state);
    await restartService(host, undefined, 'app-api');
    const st = state.get('app-api')!;
    assert.equal(st.status, 'running');
    assert.equal(st.health, 'up');
    assert.equal(st.remote?.envName, 'qa');
    assert.equal(st.crashes ?? 0, 0);
  });

  it('debug refuses, because the inspector runs inside a process that is elsewhere', async () => {
    const state = new Map([['app-api', remoteState()]]);
    const { host, calls } = mkHost(state);
    const res = await debugService(host, undefined, 'app-api', true);
    assert.deepEqual(res, { debug: false, port: null, ok: false, skippedRemote: 'qa' });
    assert.equal(calls.started, 0);
    // And it did not leave `--inspect` on the config for the next real start.
    assert.equal(state.get('app-api')!.svc.debug, undefined);
  });
});
