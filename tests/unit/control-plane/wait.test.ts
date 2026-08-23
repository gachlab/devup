import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, selectServices, waitForServices, UnknownServicesError, DEFAULT_WAIT_TIMEOUT_MS,
} from '../../../src/control-plane/wait.js';
import type { DevupClient } from '../../../src/control-plane/client.js';
import type { ServiceSnapshot, StatusResult } from '../../../src/control-plane/types.js';

/** A snapshot row. Defaults to a healthy always-on API; every override below
 *  is a state the daemon can actually produce — a fixture that encodes an
 *  impossible pairing teaches the wrong policy. */
function svc(over: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    name: 'app-api', status: 'running', health: 'up', port: 3000, originalPort: 3000,
    type: 'api', phase: 0, cmd: 'node', cwd: 'app/api', errors: 0, restarts: 0, crashes: 0,
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

  it('keeps waiting on a service in timeout — its startup timer gave up, not devup', () => {
    // Treating `timeout` as terminal caps every wait at the startup timeout,
    // 45 s by default — well under the two minutes a cold front end can need,
    // and under this function's own default. The health poller keeps probing
    // it, and a readyPattern can still land.
    const r = classify(svc({ status: 'timeout', health: 'down', port: 4201 }), false);
    assert.equal(r.readiness, 'waiting');
    assert.match(r.reason!, /4201/);
  });

  it('keeps waiting on a crash even at the restart limit, and says how many', () => {
    // Tempting to fail fast here, and wrong: `Restarter.scheduleAutoRestart`
    // bumps `restarts` to the maximum and *then* schedules the last restart,
    // so "crashed with the budget spent" is also what a service looks like for
    // the eight seconds before the restart that saves it. Nothing in the
    // snapshot tells the two apart.
    const r = classify(svc({ status: 'crashed', health: 'down', restarts: 3, crashes: 4, pid: null, startedAt: null }), false);
    assert.equal(r.readiness, 'waiting');
    assert.match(r.reason!, /4 times/, 'the count is `crashes`, not the restart budget');
  });

  it('keeps waiting on a crash that still has budget left', () => {
    const r = classify(svc({ status: 'crashed', health: 'down', restarts: 1, crashes: 1, pid: null, startedAt: null }), false);
    assert.equal(r.readiness, 'waiting');
    assert.match(r.reason!, /1 time\b/, 'singular, and from `crashes`');
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

  it('throws a type a caller can tell from a dead socket', () => {
    // Otherwise `devup exec` blames a profile mismatch when the daemon simply
    // stopped answering, and sends someone looking in the wrong place.
    const all = [svc()];
    try {
      selectServices(all, ['ghost']);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof UnknownServicesError);
      assert.deepEqual((e as UnknownServicesError).missing, ['ghost']);
      assert.deepEqual((e as UnknownServicesError).running, ['app-api']);
    }
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

  it('waits out a crash loop rather than calling it early', async () => {
    const dead = svc({ status: 'crashed', health: 'down', restarts: 3, crashes: 3, pid: null, startedAt: null });
    const client = fakeClient([[dead]]);
    const res = await waitForServices(client, { intervalMs: 5, timeoutMs: 60 });
    assert.equal(res.ok, false);
    assert.equal(res.failedFast, false, 'the restarter may still have it');
    assert.deepEqual(res.notReady.map(s => s.name), ['app-api']);
  });

  it('lets a crashed service that comes back count as ready', async () => {
    const client = fakeClient([
      [svc({ status: 'crashed', health: 'down', restarts: 3, crashes: 3, pid: null, startedAt: null })],
      [svc()],
    ]);
    const res = await waitForServices(client, { intervalMs: 5, timeoutMs: 2000 });
    assert.equal(res.ok, true);
  });

  it('stops on the caller\'s abort signal instead of running out its clock', async () => {
    // Ctrl-C during a two-minute wait has to be acted on now, not at the
    // deadline — otherwise `devup exec` sits there while its user waits.
    const controller = new AbortController();
    const client = fakeClient([[svc({ status: 'starting', health: 'wait' })]]);
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const res = await waitForServices(client, { intervalMs: 5, timeoutMs: 30_000, signal: controller.signal });
    assert.equal(res.aborted, true);
    assert.equal(res.ok, false);
    assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started}ms after the abort`);
  });

  it('does not report an abort when nothing aborted it', async () => {
    const client = fakeClient([[svc()]]);
    const res = await waitForServices(client, { intervalMs: 5, timeoutMs: 2000, signal: new AbortController().signal });
    assert.equal(res.aborted, false);
    assert.equal(res.ok, true);
  });

  it('still waits on a service in timeout that comes good late', async () => {
    // 45 s is the startup timer, not devup's patience, and a readyPattern that
    // lands at 60 s is a front end that is genuinely serving.
    const client = fakeClient([
      [svc({ status: 'timeout', health: 'down' })],
      [svc({ status: 'timeout', health: 'down' })],
      [svc({ status: 'running', health: 'up' })],
    ]);
    const res = await waitForServices(client, { intervalMs: 5, timeoutMs: 2000 });
    assert.equal(res.ok, true, JSON.stringify(res.notReady));
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
