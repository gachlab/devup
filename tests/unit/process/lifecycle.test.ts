import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lifecycle } from '../../../src/process/lifecycle.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';
import type { Platform } from '../../../src/platform/types.js';

const baseSvc: ServiceConfig = { name: 'x', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0 };

function mkState(over: Partial<ProcessState>): ProcessState {
  // `Object.assign`, not a Partial spread: spreading a Partial makes every
  // member optional, so a fixture that lags the type still compiles — which
  // is how a fake comes to lag the interface (CLAUDE.md rule 5).
  const base: ProcessState = {
    svc: baseSvc, proc: null, pid: null, status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 0, crashLog: null,
  };
  return Object.assign(base, over);
}

function mkFakePlatform(): Platform & { kills: number[] } {
  const kills: number[] = [];
  return {
    kills,
    killTree: (pid: number) => { kills.push(pid); },
    getProcessStats: async () => new Map(),
    openBrowser: async () => {},
    detect: () => 'linux',
  } as any;
}

describe('Lifecycle.stop', () => {
  it('no-ops when service has no proc/pid', () => {
    const state = new Map<string, ProcessState>([
      ['x', mkState({})], // no proc, no pid
    ]);
    const platform = mkFakePlatform();
    const lifecycle = new Lifecycle({ state, procs: new Set(), platform });
    lifecycle.stop('x');
    assert.deepEqual(platform.kills, []);
  });

  it('marks intentionalStop and kills tree when proc + pid exist', () => {
    const fakeProc = { pid: 999, killed: false } as any;
    const state = new Map<string, ProcessState>([
      ['x', mkState({ proc: fakeProc, pid: 999 })],
    ]);
    const platform = mkFakePlatform();
    const lifecycle = new Lifecycle({ state, procs: new Set(), platform });
    lifecycle.stop('x');
    assert.equal(state.get('x')!.intentionalStop, true);
    assert.deepEqual(platform.kills, [999]);
  });

  it('stopWatchProc kills the side-car and clears the reference', () => {
    const fakeWp = { pid: 4242 } as any;
    const st = mkState({ watchProc: fakeWp });
    const platform = mkFakePlatform();
    const lifecycle = new Lifecycle({ state: new Map(), procs: new Set(), platform });
    lifecycle.stopWatchProc(st);
    assert.deepEqual(platform.kills, [4242]);
    assert.equal(st.watchProc, null);
  });

  it('stopWatchProc is safe to call when watchProc is null', () => {
    const st = mkState({});
    const lifecycle = new Lifecycle({ state: new Map(), procs: new Set(), platform: mkFakePlatform() });
    lifecycle.stopWatchProc(st);
    assert.equal(st.watchProc, undefined);
  });
});
