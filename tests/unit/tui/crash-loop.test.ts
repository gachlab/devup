import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCrashLooped, MAX_RESTARTS } from '../../../src/tui/StatsPanel.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const svc: ServiceConfig = { name: 'x', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0 };

function mkState(over: Partial<ProcessState>): ProcessState {
  // `Object.assign`, not a Partial spread: spreading a Partial makes every
  // member optional, so a fixture that lags the type still compiles — which
  // is how a fake comes to lag the interface (CLAUDE.md rule 5).
  const base: ProcessState = {
    svc, proc: null, pid: null,
    status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: null,
    intentionalStop: false, colorIdx: 0, crashLog: null,
  };
  return Object.assign(base, over);
}

describe('isCrashLooped', () => {
  it('false when status is running', () => {
    assert.equal(isCrashLooped(mkState({ status: 'running', restarts: MAX_RESTARTS + 5 })), false);
  });

  it('false when crashed but under MAX_RESTARTS', () => {
    assert.equal(isCrashLooped(mkState({ status: 'crashed', restarts: MAX_RESTARTS - 1 })), false);
  });

  it('true when crashed and at MAX_RESTARTS', () => {
    assert.equal(isCrashLooped(mkState({ status: 'crashed', restarts: MAX_RESTARTS })), true);
  });

  it('true when crashed and above MAX_RESTARTS', () => {
    assert.equal(isCrashLooped(mkState({ status: 'crashed', restarts: MAX_RESTARTS + 2 })), true);
  });

  it('MAX_RESTARTS matches the ProcessManager constant', () => {
    // Manual sync constant — guard against future drift
    assert.equal(MAX_RESTARTS, 3);
  });
});
