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

describe('HealthPoller and concurrent removal', () => {
  it('does not report on a service removed while its probe was in flight', async () => {
    // The probe can outlive the service. If the result is written anyway, the
    // daemon pushes a `status` frame *after* the `removed` one and every client
    // re-adds the service that was just announced gone.
    const state = new Map<string, ProcessState>();
    // Port 1 is privileged and unbound: the probe fails, taking real time.
    // failureThreshold 1 so a single failed probe actually changes `health` —
    // with the default of 2 nothing is emitted and the test proves nothing.
    const st = mkState({
      pid: 1234, status: 'running',
      svc: { ...baseSvc, name: 'legacy', port: 1, healthCheck: { type: 'tcp', failureThreshold: 1 } },
    });
    state.set('legacy', st);
    const events = mkEvents();
    const poller = new HealthPoller({ state, events });

    const inFlight = poller.checkAll();
    // Remove it the way a config reload would, while the probe is running.
    state.delete('legacy');
    poller.forget('legacy');
    await inFlight;

    assert.deepEqual(
      events.changes.filter(c => c[0] === 'legacy'),
      [],
      'a removed service must not emit a state change from a stale probe',
    );
  });
});

describe('HealthPoller and readyPattern', () => {
  /** A real listening port, so the probe genuinely succeeds. */
  async function withOpenPort(fn: (port: number) => Promise<void>): Promise<void> {
    const net = await import('node:net');
    const server = net.createServer(s => s.destroy());
    const port: number = await new Promise(r => server.listen(0, () => r((server.address() as import('node:net').AddressInfo).port)));
    try { await fn(port); } finally { await new Promise<void>(r => server.close(() => r())); }
  }

  it('does not let a bare port probe speak for a service that declares a readyPattern', async () => {
    // `ng serve` opens :4200 seconds before the bundle exists. Promoting on
    // the probe marks a front end ready while a browser still gets nothing —
    // and `ctl wait`, `devup exec` and the TUI all read this field.
    await withOpenPort(async port => {
      const svc: ServiceConfig = {
        ...baseSvc, name: 'web', type: 'web', port,
        readyPattern: 'Application bundle generation complete',
      };
      const state = new Map<string, ProcessState>([
        ['web', mkState({ svc, status: 'starting', health: 'wait', pid: 1234 })],
      ]);
      const poller = new HealthPoller({ state, events: mkEvents() });
      await poller.checkAll();
      assert.equal(state.get('web')!.health, 'wait', 'the port answering is not the announcement');
      assert.equal(state.get('web')!.status, 'starting');
    });
  });

  it('accepts the port once the startup timer has given up on the pattern', async () => {
    // A pattern that never matches — a typo, a tool that changed its wording —
    // must not keep a working service marked down for the rest of the session.
    await withOpenPort(async port => {
      const svc: ServiceConfig = { ...baseSvc, name: 'web', type: 'web', port, readyPattern: 'never appears' };
      const state = new Map<string, ProcessState>([
        ['web', mkState({ svc, status: 'timeout', health: 'down', pid: 1234 })],
      ]);
      const poller = new HealthPoller({ state, events: mkEvents() });
      await poller.checkAll();
      assert.equal(state.get('web')!.health, 'up');
      assert.equal(state.get('web')!.status, 'running');
    });
  });

  it('promotes a service without a readyPattern on the probe, as before', async () => {
    await withOpenPort(async port => {
      const state = new Map<string, ProcessState>([
        ['api', mkState({ svc: { ...baseSvc, port }, status: 'starting', health: 'wait', pid: 1234 })],
      ]);
      const poller = new HealthPoller({ state, events: mkEvents() });
      await poller.checkAll();
      assert.equal(state.get('api')!.health, 'up');
      assert.equal(state.get('api')!.status, 'running');
    });
  });

  it('keeps probing a service in timeout instead of writing it off for good', async () => {
    // `timeout` used to be skipped outright, so a service that started slowly
    // and then served perfectly well stayed marked down for the rest of the
    // session — and every client, the TUI included, believed it.
    await withOpenPort(async port => {
      const state = new Map<string, ProcessState>([
        ['api', mkState({ svc: { ...baseSvc, port }, status: 'timeout', health: 'down', pid: 1234 })],
      ]);
      const events = mkEvents();
      const poller = new HealthPoller({ state, events });
      await poller.checkAll();
      assert.equal(state.get('api')!.health, 'up');
      assert.equal(state.get('api')!.status, 'running', 'it is serving; it is not still timing out');
      assert.ok(events.changes.some(([n, , h]) => n === 'api' && h === 'up'), 'clients have to be told');
    });
  });
});
