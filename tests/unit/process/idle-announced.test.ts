import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HealthPoller } from '../../../src/process/health-poller.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const svc: ServiceConfig = {
  name: 'app-api', cwd: '.', cmd: 'node', args: ['i.js'], type: 'api', port: 3000, phase: 0,
};

function state(over: Partial<ProcessState>): ProcessState {
  const base: ProcessState = {
    svc, proc: null, pid: null, status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false,
    colorIdx: 0, crashLog: null,
  };
  return Object.assign(base, over);
}

function poller(states: Map<string, ProcessState>) {
  const emitted: Array<{ name: string; health: string; status: string }> = [];
  const p = new HealthPoller({
    state: states,
    events: {
      onLog: () => {},
      onStateChange: (name, st) => emitted.push({ name, health: st.health, status: st.status }),
    },
  });
  return { p, emitted };
}

describe('transitions a follower can only learn from an emit', () => {
  it('announces a lazy service that went idle', async () => {
    // The idle write happens outside the manager — the lazy proxy's
    // `onIdleStop` — and does not emit. The poller's early `continue` then
    // skipped the emit at the bottom of the loop, so nothing ever pushed it:
    // `ctl status` was right because it re-reads the map, while
    // `status.follow` showed the service as running/up for the rest of the
    // session. That is the whole failure, and it is invisible from the
    // snapshot side.
    const states = new Map([['app-api', state({ status: 'idle', health: 'up', pid: null })]]);
    const { p, emitted } = poller(states);

    await p.checkAll();

    assert.equal(states.get('app-api')!.health, 'idle');
    assert.deepEqual(emitted, [{ name: 'app-api', health: 'idle', status: 'idle' }]);
  });

  it('announces a service whose process is gone', async () => {
    const states = new Map([['app-api', state({ status: 'stopped', health: 'up', pid: null })]]);
    const { p, emitted } = poller(states);

    await p.checkAll();

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.health, 'down');
  });

  it('stays quiet when nothing changed', async () => {
    // The store is quiet, not silent: a follower that redraws per frame must
    // not be woken three times a second by a service sitting still.
    const states = new Map([['app-api', state({ status: 'idle', health: 'idle', pid: null })]]);
    const { p, emitted } = poller(states);

    await p.checkAll();

    assert.deepEqual(emitted, []);
  });

  it('leaves a remote service alone, emit included', async () => {
    // Its port is held by devup's own proxy, so a probe there answers whatever
    // the environment is doing. Health belongs to the proxy's own probe.
    const states = new Map([['app-api', state({
      status: 'running', health: 'up', pid: null,
      remote: { envName: 'qa', target: 'https://x.test', readOnly: false },
    })]]);
    const { p, emitted } = poller(states);

    await p.checkAll();

    assert.equal(states.get('app-api')!.health, 'up');
    assert.deepEqual(emitted, []);
  });
});

describe('the poller does not use pid as a liveness test', () => {
  it('marks a crashed service down even though it kept a dead pid', async () => {
    // CLAUDE.md §2: the spawner's close handler never clears `pid`, so a
    // crashed service keeps one. Gating on `!st.pid` therefore lets a dead
    // service through to the probe path, where it takes `failureThreshold`
    // rounds to be called down — in the module the hazard is most about.
    // `isRunning` reads the child, which is what the hazard says to do.
    const states = new Map([['app-api', state({
      status: 'crashed', health: 'up', pid: 4242, proc: null,
    })]]);
    const { p, emitted } = poller(states);

    await p.checkAll();

    assert.equal(states.get('app-api')!.health, 'down');
    assert.deepEqual(emitted, [{ name: 'app-api', health: 'down', status: 'crashed' }]);
  });

  it('still probes a service whose process is genuinely alive', async () => {
    // The guard must not swallow the live case: a running child with an open
    // port has to reach the probe, or nothing is ever health-checked at all.
    const alive = { exitCode: null, signalCode: null } as unknown as NonNullable<ProcessState['proc']>;
    const states = new Map([['app-api', state({
      status: 'running', health: 'up', pid: 4242, proc: alive,
      svc: { ...svc, port: 1, healthCheck: { type: 'tcp', failureThreshold: 1, timeoutMs: 150 } },
    })]]);
    const { p, emitted } = poller(states);

    await p.checkAll();

    // Port 1 answers nothing, so the probe ran and failed — which is the proof
    // it was not short-circuited by the guard above.
    assert.equal(states.get('app-api')!.health, 'down');
    assert.equal(emitted.length, 1);
  });
});
