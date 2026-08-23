import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { restartService, type RestartServiceHost } from '../../../src/process/restart-service.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const svc: ServiceConfig = { name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0 };

/** A process handle `isRunning` accepts, with a settable exit. */
function fakeProc() {
  const listeners: Array<() => void> = [];
  return {
    exitCode: null as number | null, signalCode: null, killed: false,
    once(ev: string, fn: () => void) { if (ev === 'exit') listeners.push(fn); return this; },
    off() { return this; },
    /** Let it actually die, as a SIGTERM eventually does. */
    finishExiting(this: { exitCode: number | null }) { this.exitCode = 0; listeners.forEach(fn => fn()); },
  };
}

function mkState(over: Partial<ProcessState> = {}): ProcessState {
  return {
    svc, proc: null, pid: 1, status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: 1, intentionalStop: false, colorIdx: 0, crashLog: null,
    ...over,
  };
}

interface Recorded { log: string[]; host: RestartServiceHost }

function mkHost(states: Map<string, ProcessState>, over: Partial<RestartServiceHost> = {}): Recorded {
  const log: string[] = [];
  const host: RestartServiceHost = {
    state: states,
    stop: n => { log.push(`stop:${n}`); const st = states.get(n); if (st) st.intentionalStop = true; },
    cancelPendingRestart: n => { log.push(`cancelPendingRestart:${n}`); },
    install: async () => { log.push('install'); return true; },
    start: async () => { log.push('spawn'); },
    ...over,
  };
  return { log, host };
}

describe('restartService', () => {
  it('waits for the old process to die before starting the new one', async () => {
    // The bug this shape exists to prevent: calling `proxy.ensureStarted()`
    // straight after the stop short-circuits on
    // `serviceReady && isAlive() && checkPort()` — all true in that window —
    // so it returns `true` *without respawning*, and once the draining process
    // finally exits the service is simply down, with `intentionalStop`
    // suppressing the auto-restart.
    const proc = fakeProc();
    const states = new Map([['api', mkState({ proc: proc as never })]]);
    const order: string[] = [];
    const { host } = mkHost(states);
    const proxies = new Map([['api', { ensureStarted: async () => { order.push('ensureStarted'); return true; } }]]);

    const pending = restartService(host, proxies, 'api');
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(order, [], 'it must not have started anything while the old process was alive');

    proc.finishExiting();
    const res = await pending;
    assert.deepEqual(res, { ok: true, skippedIdle: false });
    assert.deepEqual(order, ['ensureStarted']);
  });

  it('brings a running lazy service back through its proxy, never around it', async () => {
    const states = new Map([['api', mkState()]]);   // no live proc: nothing to wait for
    const { log, host } = mkHost(states);
    const proxies = new Map([['api', { ensureStarted: async () => { log.push('ensureStarted'); return true; } }]]);
    const res = await restartService(host, proxies, 'api');
    assert.deepEqual(res, { ok: true, skippedIdle: false });
    assert.ok(log.includes('ensureStarted'));
    assert.ok(!log.includes('spawn'), 'must not spawn around the proxy');
  });

  it('cancels a queued auto-restart, or it spawns a second process seconds later', async () => {
    const states = new Map([['api', mkState()]]);
    const { log, host } = mkHost(states);
    await restartService(host, undefined, 'api');
    assert.ok(log.includes('cancelPendingRestart:api'), log.join('|'));
  });

  it('grants a fresh restart budget, as every other manual path does', async () => {
    const states = new Map([['api', mkState({ restarts: 3 })]]);
    const { host } = mkHost(states);
    await restartService(host, undefined, 'api');
    assert.equal(states.get('api')!.restarts, 0);
  });

  it('reports failure when the service does not come back', async () => {
    // `Restarter.restart` returns void and swallows a failed preBuild, a
    // missing watch path and a port already taken — so the old path answered
    // `ok: true` over a service that never came back.
    const states = new Map([['api', mkState()]]);
    const { host } = mkHost(states, {
      start: async () => { states.set('api', mkState({ status: 'crashed', health: 'down', proc: null })); },
    });
    const res = await restartService(host, undefined, 'api');
    assert.equal(res.ok, false);
  });

  it('reports failure when the proxy cannot bring a lazy service back', async () => {
    const states = new Map([['api', mkState()]]);
    const { host } = mkHost(states);
    const proxies = new Map([['api', { ensureStarted: async () => false }]]);
    assert.equal((await restartService(host, proxies, 'api')).ok, false);
  });

  it('leaves a sleeping lazy service asleep', async () => {
    const states = new Map([['api', mkState({ status: 'idle', health: 'idle', pid: null })]]);
    const { log, host } = mkHost(states);
    const proxies = new Map([['api', { ensureStarted: async () => { log.push('ensureStarted'); return true; } }]]);
    const res = await restartService(host, proxies, 'api');
    assert.deepEqual(res, { ok: true, skippedIdle: true });
    assert.deepEqual(log, [], 'nothing should have been touched');
  });

  it('still restarts an always-on service that happens to be stopped', async () => {
    // Only *lazy* idleness is a reason to leave it alone.
    const states = new Map([['api', mkState({ status: 'stopped', health: 'down', proc: null })]]);
    const { log, host } = mkHost(states);
    await restartService(host, undefined, 'api');
    assert.ok(log.includes('spawn'), log.join('|'));
  });

  it('refuses a service the daemon does not have', async () => {
    const { host } = mkHost(new Map());
    await assert.rejects(restartService(host, undefined, 'ghost'), /unknown service: ghost/);
  });
});
