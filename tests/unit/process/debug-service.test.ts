import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { debugService, type DebugServiceHost } from '../../../src/process/debug-service.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const svc: ServiceConfig = {
  name: 'api', cwd: '.', cmd: 'node', args: ['index.js'], type: 'web', port: 4321, phase: 0,
};

function mkState(over: Partial<ProcessState> = {}): ProcessState {
  return {
    svc, proc: null, pid: null, status: 'stopped', health: 'down',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 0, crashLog: null,
    ...over,
  };
}

function mkHost(state: Map<string, ProcessState>, onStart?: (s: ServiceConfig) => void) {
  const calls = { stopped: [] as string[], startedWith: [] as ServiceConfig[] };
  const host: DebugServiceHost = {
    state,
    stop: (n) => { calls.stopped.push(n); },
    install: async () => true,
    start: async (s, ci) => {
      calls.startedWith.push(s);
      onStart?.(s);
      const prev = state.get(s.name);
      state.set(s.name, { ...mkState({ status: 'running', colorIdx: ci }), svc: s, debugPort: prev?.debugPort ?? null });
    },
    cancelPendingRestart: () => {},
  };
  return { host, calls };
}

describe('debugService', () => {
  it('restarts the service with the inspector flag set', async () => {
    const state = new Map([['api', mkState()]]);
    const { host, calls } = mkHost(state);
    const res = await debugService(host, undefined, 'api', true);
    assert.equal(res.debug, true);
    assert.equal(res.ok, true);
    assert.deepEqual(calls.stopped, ['api']);
    assert.equal(calls.startedWith[0]!.debug, true, 'the restart did not carry the flag');
  });

  it('pins the port when one is given', async () => {
    const state = new Map([['api', mkState()]]);
    const { host, calls } = mkHost(state);
    await debugService(host, undefined, 'api', true, 9230);
    assert.equal(calls.startedWith[0]!.debug, 9230);
  });

  it('clears the flag when turned off', async () => {
    const state = new Map([['api', mkState({ svc: { ...svc, debug: true }, debugPort: 39481 })]]);
    const { host, calls } = mkHost(state);
    const res = await debugService(host, undefined, 'api', false);
    assert.equal(res.debug, false);
    assert.equal(calls.startedWith[0]!.debug, undefined, 'the flag survived being turned off');
  });

  it('drops a stale port before restarting', async () => {
    // The old process announced it; the new one announces its own, and until
    // it does a client would otherwise attach to a port that is gone.
    const state = new Map([['api', mkState({ debugPort: 39481 })]]);
    const { host } = mkHost(state);
    const res = await debugService(host, undefined, 'api', true);
    assert.equal(res.port, null);
  });

  it('reports the port once the process announces it', async () => {
    const state = new Map([['api', mkState()]]);
    const { host } = mkHost(state, () => { state.get('api')!.debugPort = 39481; });
    const res = await debugService(host, undefined, 'api', true);
    assert.equal(res.port, 39481);
  });

  it('refuses a service that does not run node', async () => {
    // --inspect would be handed to npx as a script argument and silently
    // ignored, leaving the user waiting for a debugger that never listens.
    const state = new Map([['api', mkState({ svc: { ...svc, cmd: 'npx' } })]]);
    const { host, calls } = mkHost(state);
    await assert.rejects(() => debugService(host, undefined, 'api', true), /does not run node/);
    assert.deepEqual(calls.stopped, [], 'it stopped the service before finding out');
  });

  it('throws for a service it does not know', async () => {
    const { host } = mkHost(new Map());
    await assert.rejects(() => debugService(host, undefined, 'nope', true), /unknown service/);
  });

  it('rejects an out-of-range port before touching the service', async () => {
    // The bad value would reach --inspect=<n>, Node would refuse to start, and
    // the flag persists — so every later restart fails the same way until
    // someone turns it off.
    const state = new Map([['api', mkState()]]);
    const { host, calls } = mkHost(state);
    await assert.rejects(() => debugService(host, undefined, 'api', true, 70000), /invalid inspector port/);
    await assert.rejects(() => debugService(host, undefined, 'api', true, 0), /invalid inspector port/);
    assert.deepEqual(calls.stopped, []);
  });

  it('rolls the flag back when the restart fails', async () => {
    // Otherwise the service is unstartable: every auto-restart and every later
    // `ctl start` reuses the same bad value — a port already in use, most
    // likely — until someone thinks to run `ctl debug --off`.
    const state = new Map([['api', mkState()]]);
    const host: DebugServiceHost = {
      state,
      stop: () => {},
      install: async () => true,
      start: async (s, ci) => { state.set(s.name, { ...mkState({ status: 'crashed', colorIdx: ci }), svc: s }); },
      cancelPendingRestart: () => {},
    };
    const res = await debugService(host, undefined, 'api', true, 9230);
    assert.equal(res.ok, false);
    assert.equal(state.get('api')!.svc.debug, undefined, 'the bad flag survived a failed restart');
  });

  it('does not re-arm the inspector when turning it off fails', async () => {
    // Rolling back on --off restores the flag the user just disabled, and the
    // next restart brings --inspect back. Turning it off is never the cause of
    // an unstartable service.
    const state = new Map([['api', mkState({ svc: { ...svc, debug: 9230 } })]]);
    const host: DebugServiceHost = {
      state,
      stop: () => {},
      install: async () => true,
      start: async (s, ci) => { state.set(s.name, { ...mkState({ status: 'crashed', colorIdx: ci }), svc: s }); },
      cancelPendingRestart: () => {},
    };
    const res = await debugService(host, undefined, 'api', false);
    assert.equal(res.ok, false);
    assert.equal(state.get('api')!.svc.debug, undefined, 'the flag the user disabled came back');
  });

  it('cancels the queued auto-restart when rolling back', async () => {
    // Restarter re-spawns the config captured at crash time, so without this
    // it keeps retrying with the bad flag no matter what state says.
    const state = new Map([['api', mkState()]]);
    const cancelled: string[] = [];
    const host: DebugServiceHost = {
      state,
      stop: () => {},
      install: async () => true,
      start: async (s, ci) => { state.set(s.name, { ...mkState({ status: 'crashed', colorIdx: ci }), svc: s }); },
      cancelPendingRestart: (n) => { cancelled.push(n); },
    };
    await debugService(host, undefined, 'api', true, 9230);
    assert.ok(cancelled.filter(n => n === 'api').length >= 2, 'the pending restart survived the rollback');
  });
});
