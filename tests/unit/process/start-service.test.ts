import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startService, type StartServiceHost } from '../../../src/process/start-service.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const svc: ServiceConfig = {
  name: 'api', cwd: '.', cmd: 'node', args: [], type: 'web', port: 4321, phase: 0,
};

/** A fake child that reports liveness the way ChildProcess does. */
function fakeProc(alive: boolean) {
  const listeners: Array<() => void> = [];
  return {
    exitCode: alive ? null : 0,
    signalCode: null,
    once(ev: string, fn: () => void) { if (ev === 'exit') listeners.push(fn); return this; },
    off() { return this; },
    /** Simulate the child finally exiting. */
    finish() { this.exitCode = 0; listeners.splice(0).forEach(fn => fn()); },
  };
}

function mkState(over: Partial<ProcessState> = {}): ProcessState {
  return {
    svc, proc: null, pid: null, status: 'stopped', health: 'down',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 0, crashLog: null,
    ...over,
  };
}

function mkHost(state: Map<string, ProcessState>, over: Partial<StartServiceHost> = {}) {
  const calls = { installed: 0, started: 0, cancelled: [] as string[] };
  const host: StartServiceHost = {
    state,
    install: async () => { calls.installed++; return true; },
    start: async (s, ci) => {
      calls.started++;
      // Mirrors Spawner: the new state carries the previous counters forward.
      const prev = state.get(s.name);
      state.set(s.name, mkState({ status: 'running', colorIdx: ci, restarts: prev?.restarts ?? 0 }));
    },
    cancelPendingRestart: (n) => { calls.cancelled.push(n); },
    ...over,
  };
  return { host, calls };
}

describe('startService', () => {
  it('throws for a service it does not know', async () => {
    const { host } = mkHost(new Map());
    await assert.rejects(() => startService(host, undefined, 'nope'), /unknown service/);
  });

  it('is a no-op for a service that is genuinely running', async () => {
    const state = new Map([['api', mkState({ proc: fakeProc(true) as never, status: 'running' })]]);
    const { host, calls } = mkHost(state);
    assert.equal((await startService(host, undefined, 'api')).ok, true);
    assert.equal(calls.started, 0);
  });

  it('gives up rather than racing a service that will not stop', async () => {
    // Spawning while the old child still holds the port lands in
    // recordCrashedState, which drops the daemon's handle on a live process.
    const state = new Map([['api', mkState({ proc: fakeProc(true) as never, intentionalStop: true })]]);
    const { host, calls } = mkHost(state);
    assert.equal((await startService(host, undefined, 'api')).ok, false);
    assert.equal(calls.started, 0, 'it spawned on top of a process that had not exited');
  });

  it('cancels a queued auto-restart and restores the restart budget', async () => {
    const state = new Map([['api', mkState({ restarts: 3 })]]);
    const { host, calls } = mkHost(state);
    await startService(host, undefined, 'api');
    assert.deepEqual(calls.cancelled, ['api']);
    assert.equal(state.get('api')!.restarts, 0, 'an explicit start earns a fresh budget');
  });

  it('routes a lazy service through its proxy instead of spawning', async () => {
    const state = new Map([['api', mkState()]]);
    const { host, calls } = mkHost(state);
    let ensured = 0;
    const proxies = new Map([['api', { ensureStarted: async () => { ensured++; return true; } }]]);
    assert.equal((await startService(host, proxies, 'api')).ok, true);
    assert.equal(ensured, 1);
    assert.equal(calls.started, 0, 'spawning directly leaves the proxy believing nothing is up');
  });

  it('reports failure when the spawner recorded a crash', async () => {
    const state = new Map([['api', mkState()]]);
    const { host } = mkHost(state, {
      start: async () => { state.set('api', mkState({ status: 'crashed' })); },
    });
    assert.equal((await startService(host, undefined, 'api')).ok, false);
  });

  it('gives up when a config reload removes the service while a stop drains', async () => {
    const proc = fakeProc(true);
    const state = new Map([['api', mkState({ proc: proc as never, intentionalStop: true })]]);
    const { host, calls } = mkHost(state);
    const started = startService(host, undefined, 'api');
    // The reload lands while we are waiting for the old child to exit.
    state.delete('api');
    proc.finish();
    assert.equal((await started).ok, false);
    assert.equal(calls.started, 0, 'it resurrected a service clients were told had gone');
    // The mid-install guard would also return false, so assert on the work
    // that should never have begun — otherwise this test passes without the
    // check it exists for.
    assert.equal(calls.installed, 0, 'it kept going after the service was removed');
  });

  it('gives up when a config reload removes the service mid-install', async () => {
    const state = new Map([['api', mkState()]]);
    const { host, calls } = mkHost(state, {
      install: async () => { state.delete('api'); return true; },
    });
    assert.equal((await startService(host, undefined, 'api')).ok, false);
    assert.equal(calls.started, 0, 'it resurrected a service clients were told had gone');
  });
});
