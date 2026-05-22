import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HealthPoller } from '../../../src/process/health-poller.js';
import type { ProcessState, ProcessManagerEvents } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const baseSvc: ServiceConfig = { name: 'x', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0 };

function mkState(over: Partial<ProcessState>): ProcessState {
  return {
    svc: baseSvc, proc: null, pid: null, status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 0,
    ...over,
  };
}

function mkEvents(): ProcessManagerEvents & { changes: Array<[string, string, string]> } {
  const changes: Array<[string, string, string]> = [];
  return {
    onLog: () => {},
    onStateChange: (name, st) => changes.push([name, st.status, st.health]),
    changes,
  };
}

describe('HealthPoller', () => {
  it('marks status=idle services as health=idle', async () => {
    const state = new Map<string, ProcessState>([
      ['lazy', mkState({ svc: { ...baseSvc, name: 'lazy' }, status: 'idle', health: 'down' })],
    ]);
    const events = mkEvents();
    const poller = new HealthPoller({ state, events });
    await poller.checkAll();
    assert.equal(state.get('lazy')!.health, 'idle');
  });

  it('marks pid-less non-idle services as health=down (no probe)', async () => {
    const state = new Map<string, ProcessState>([
      ['dead', mkState({ svc: { ...baseSvc, name: 'dead' }, status: 'crashed', pid: null, health: 'up' })],
    ]);
    const poller = new HealthPoller({ state, events: mkEvents() });
    await poller.checkAll();
    assert.equal(state.get('dead')!.health, 'down');
  });

  it('respects healthCheck.startPeriod — skips probe within the grace window', async () => {
    // Service started 1s ago with startPeriod=10s. checkAll should NOT touch health.
    const state = new Map<string, ProcessState>([
      ['grace', mkState({
        svc: { ...baseSvc, name: 'grace', healthCheck: { type: 'tcp', startPeriod: 10 } },
        pid: 12345, status: 'starting', health: 'wait',
        startedAt: Date.now() - 1000,
      })],
    ]);
    const events = mkEvents();
    const poller = new HealthPoller({ state, events });
    await poller.checkAll();
    assert.equal(state.get('grace')!.health, 'wait');
    assert.equal(state.get('grace')!.status, 'starting');
    assert.equal(events.changes.length, 0);
  });
});
