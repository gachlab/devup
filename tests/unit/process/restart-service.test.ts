import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { restartService, type RestartServiceHost } from '../../../src/process/restart-service.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const svc: ServiceConfig = { name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0 };

function mkState(over: Partial<ProcessState> = {}): ProcessState {
  return {
    svc, proc: null, pid: 1, status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: 1, intentionalStop: false, colorIdx: 0, crashLog: null,
    ...over,
  };
}

function mkHost(states: Map<string, ProcessState>, log: string[]): RestartServiceHost {
  return {
    state: states,
    restart: async n => { log.push(`manager.restart:${n}`); },
    stop: n => { log.push(`stop:${n}`); },
  };
}

describe('restartService', () => {
  it('uses the plain manager restart for an always-on service', async () => {
    const log: string[] = [];
    const states = new Map([['api', mkState()]]);
    const res = await restartService(mkHost(states, log), new Map(), 'api');
    assert.deepEqual(res, { ok: true, skippedIdle: false });
    assert.deepEqual(log, ['manager.restart:api']);
  });

  it('brings a running lazy service back through its proxy, never around it', async () => {
    // `ProcessManager.restart` goes straight to the spawner. For a lazy
    // service that leaves the proxy's `serviceReady` false, so the next
    // request through the public port starts a *second* process — and a lazy
    // web has no `isPortBindable` pre-flight to catch it.
    const log: string[] = [];
    const states = new Map([['api', mkState()]]);
    const proxies = new Map([['api', { ensureStarted: async () => { log.push('ensureStarted:api'); return true; } }]]);
    const res = await restartService(mkHost(states, log), proxies, 'api');
    assert.deepEqual(res, { ok: true, skippedIdle: false });
    assert.deepEqual(log, ['stop:api', 'ensureStarted:api']);
    assert.ok(!log.some(l => l.startsWith('manager.restart')), 'must not spawn around the proxy');
  });

  it('reports failure when the proxy cannot bring it back', async () => {
    const log: string[] = [];
    const states = new Map([['api', mkState()]]);
    const proxies = new Map([['api', { ensureStarted: async () => false }]]);
    const res = await restartService(mkHost(states, log), proxies, 'api');
    assert.equal(res.ok, false, 'a tick over a dead service is the failure worth avoiding');
  });

  it('leaves a sleeping lazy service asleep', async () => {
    // There is no process to restart and its state is already fresh. Waking it
    // is the opposite of what `restart --all` between test suites is for.
    const log: string[] = [];
    const states = new Map([['api', mkState({ status: 'idle', health: 'idle', pid: null })]]);
    const proxies = new Map([['api', { ensureStarted: async () => { log.push('ensureStarted'); return true; } }]]);
    const res = await restartService(mkHost(states, log), proxies, 'api');
    assert.deepEqual(res, { ok: true, skippedIdle: true });
    assert.deepEqual(log, [], 'nothing should have been touched');
  });

  it('refuses a service the daemon does not have', async () => {
    await assert.rejects(
      restartService(mkHost(new Map(), []), new Map(), 'ghost'),
      /unknown service: ghost/,
    );
  });
});
