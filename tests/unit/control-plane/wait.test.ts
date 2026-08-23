import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, selectServices, waitForServices, DEFAULT_WAIT_TIMEOUT_MS,
} from '../../../src/control-plane/wait.js';
import type { DevupClient } from '../../../src/control-plane/client.js';
import type { ServiceSnapshot, StatusResult } from '../../../src/control-plane/types.js';

/** A snapshot row. Defaults to a healthy always-on API; every override below
 *  is a state the daemon can actually produce — a fixture that encodes an
 *  impossible pairing teaches the wrong policy. */
function svc(over: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    name: 'app-api', status: 'running', health: 'up', port: 3000, originalPort: 3000,
    type: 'api', phase: 0, cmd: 'node', cwd: 'app/api', errors: 0, restarts: 0,
    pid: 100, startedAt: 1755800000000, crashLog: null, debugPort: null,
    ...over,
  };
}

/** A client that replays a scripted sequence of snapshots, one per `status()`
 *  call, holding the last one once it runs out. */
function fakeClient(sequence: ServiceSnapshot[][], onStart?: (name: string) => void): DevupClient {
  let i = 0;
  const started: string[] = [];
  const client = {
    socketPath: '/fake.sock',
    async status(): Promise<StatusResult> {
      const services = sequence[Math.min(i, sequence.length - 1)]!;
      i++;
      return { services, proxy: null };
    },
    async start(name: string) { started.push(name); onStart?.(name); return { ok: true }; },
  } as unknown as DevupClient;
  (client as unknown as { started: string[] }).started = started;
  return client;
}
const startsOf = (c: DevupClient) => (c as unknown as { started: string[] }).started;

describe('classify', () => {
  it('calls a healthy service ready whatever its status says', () => {
    assert.equal(classify(svc({ status: 'running', health: 'up' }), false).readiness, 'ready');
    // A service marked up by its readyPattern is still 'starting' until the
    // next poll moves it, and it is serving either way.
    assert.equal(classify(svc({ status: 'starting', health: 'up' }), false).readiness, 'ready');
  });

  it('calls a lazy idle service ready — its proxy is listening', () => {
    // This is the whole reason this function exists. `idle` is not `down`: the
    // on-demand proxy holds originalPort, so the stack serves. Probing the
    // port would say "up" for the proxy and tell you nothing about the service.
    const r = classify(svc({ status: 'idle', health: 'idle' }), false);
    assert.equal(r.readiness, 'ready');
  });

  it('but not when the caller asked for everything to be started', () => {
    // `--start` means "the cold start has already been paid", which idle is
    // precisely not.
    const r = classify(svc({ status: 'idle', health: 'idle' }), true);
    assert.equal(r.readiness, 'waiting');
    assert.match(r.reason!, /lazy/);
  });

  it('gives up on a service in timeout — nothing will probe it again', () => {
    // The health poller skips `timeout` outright, so it is a state the service
    // cannot leave on its own. Waiting out the clock only wastes the clock.
    const r = classify(svc({ status: 'timeout', health: 'down', port: 4201 }), false);
    assert.equal(r.readiness, 'failed');
    assert.match(r.reason!, /4201/);
  });

  it('keeps waiting on a crash — the auto-restarter may still get it back', () => {
    const r = classify(svc({ status: 'crashed', health: 'down', pid: null, startedAt: null }), false);
    assert.equal(r.readiness, 'waiting');
  });

  it('keeps waiting on a service still starting', () => {
    assert.equal(classify(svc({ status: 'starting', health: 'wait' }), false).readiness, 'waiting');
  });
});

describe('selectServices', () => {
  it('returns everything when nothing was asked for', () => {
    const all = [svc(), svc({ name: 'app-web' })];
    assert.deepEqual(selectServices(all, undefined).map(s => s.name), ['app-api', 'app-web']);
    assert.deepEqual(selectServices(all, []).map(s => s.name), ['app-api', 'app-web']);
  });

  it('names what is actually running when asked for something that is not', () => {
    const all = [svc(), svc({ name: 'app-web' })];
    assert.throws(() => selectServices(all, ['app-api', 'nope']), /unknown service: nope.*app-api, app-web/s);
  });

  it('keeps the caller\'s order, not the daemon\'s', () => {
    const all = [svc(), svc({ name: 'app-web' })];
    assert.deepEqual(selectServices(all, ['app-web', 'app-api']).map(s => s.name), ['app-web', 'app-api']);
  });
});

describe('waitForServices', () => {
  it('returns as soon as everything is ready', async () => {
    const client = fakeClient([[svc(), svc({ name: 'app-web', type: 'web', port: 4200, originalPort: 4200 })]]);
    const res = await waitForServices(client, { intervalMs: 5, timeoutMs: 2000 });
    assert.equal(res.ok, true);
    assert.equal(res.notReady.length, 0);
    assert.equal(res.services.length, 2);
  });

  it('waits for a service that arrives late, and records when it did', async () => {
    const client = fakeClient([
      [svc({ status: 'starting', health: 'wait' })],
      [svc({ status: 'starting', health: 'wait' })],
      [svc()],
    ]);
    const res = await waitForServices(client, { intervalMs: 5, timeoutMs: 2000 });
    assert.equal(res.ok, true);
    assert.equal(typeof res.services[0]!.readyAfterMs, 'number');
  });

  it('gives up immediately on a service in timeout, without burning the clock', async () => {
    const client = fakeClient([[svc({ status: 'timeout', health: 'down' })]]);
    const res = await waitForServices(client, { intervalMs: 5, timeoutMs: 30_000 });
    assert.equal(res.ok, false);
    assert.equal(res.failedFast, true);
    assert.ok(res.elapsedMs < 1000, `should not have waited 30s, waited ${res.elapsedMs}ms`);
    assert.deepEqual(res.notReady.map(s => s.name), ['app-api']);
  });

  it('runs out of time and names what never arrived', async () => {
    const client = fakeClient([[svc({ status: 'starting', health: 'wait' }), svc({ name: 'ok-api', port: 3001, originalPort: 3001 })]]);
    const res = await waitForServices(client, { intervalMs: 5, timeoutMs: 60 });
    assert.equal(res.ok, false);
    assert.equal(res.failedFast, false);
    assert.deepEqual(res.notReady.map(s => s.name), ['app-api']);
    assert.match(res.notReady[0]!.reason!, /starting\/wait/);
  });

  it('treats a service dropped by a config reload as failed, not as pending', async () => {
    // Otherwise the wait sits there until the timeout for something the daemon
    // has already told everyone is gone.
    const client = fakeClient([
      [svc({ status: 'starting', health: 'wait' }), svc({ name: 'legacy-api', port: 3009, originalPort: 3009 })],
      [svc()],
    ]);
    const res = await waitForServices(client, { intervalMs: 5, timeoutMs: 2000 });
    assert.equal(res.ok, false);
    assert.equal(res.failedFast, true);
    assert.deepEqual(res.notReady.map(s => s.name), ['legacy-api']);
    assert.match(res.notReady[0]!.reason!, /no longer/);
  });

  it('start: warms services in ascending phase order', async () => {
    // The config's phase order is the only statement anyone has made about
    // what needs what — starting a phase-4 web before its phase-0 API is how a
    // warm-up turns into a crash loop.
    const idle = (name: string, phase: number, port: number) =>
      svc({ name, phase, port, originalPort: port, status: 'idle', health: 'idle', pid: null, startedAt: null });
    const client = fakeClient([
      [idle('web', 4, 4200), idle('auth', 0, 3002), idle('app', 1, 3000)],
      [svc({ name: 'web' }), svc({ name: 'auth' }), svc({ name: 'app' })],
    ]);
    const res = await waitForServices(client, { start: true, intervalMs: 5, timeoutMs: 2000 });
    assert.equal(res.ok, true);
    assert.deepEqual(startsOf(client), ['auth', 'app', 'web']);
  });

  it('start: leaves alone what is already up', async () => {
    const client = fakeClient([[svc(), svc({ name: 'cold', status: 'idle', health: 'idle', pid: null, startedAt: null, phase: 1 })], [svc(), svc({ name: 'cold' })]]);
    await waitForServices(client, { start: true, intervalMs: 5, timeoutMs: 2000 });
    assert.deepEqual(startsOf(client), ['cold']);
  });

  it('only waits for the services it was asked about', async () => {
    const client = fakeClient([[svc(), svc({ name: 'unrelated', status: 'crashed', health: 'down', pid: null, startedAt: null })]]);
    const res = await waitForServices(client, { services: ['app-api'], intervalMs: 5, timeoutMs: 60 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.services.map(s => s.name), ['app-api']);
  });

  it('reports each service once as it settles', async () => {
    const settled: string[] = [];
    const client = fakeClient([
      [svc({ status: 'starting', health: 'wait' }), svc({ name: 'b', port: 3001, originalPort: 3001 })],
      [svc(), svc({ name: 'b', port: 3001, originalPort: 3001 })],
    ]);
    await waitForServices(client, { intervalMs: 5, timeoutMs: 2000, onSettled: s => settled.push(s.name) });
    assert.deepEqual(settled, ['b', 'app-api']);
  });

  it('defaults to a timeout generous enough for a cold front end', () => {
    assert.equal(DEFAULT_WAIT_TIMEOUT_MS, 120_000);
  });
});
