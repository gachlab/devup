import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createLazyProxy } from '../../../src/lazy/proxy.js';

/** Two distinct free ports. Taken while both listeners are still open: closing
 *  the first before asking for the second lets the kernel hand back the same
 *  ephemeral port, and the collision surfaces as an unhandled 'error' that
 *  takes down the whole run rather than failing one assertion. */
function findFreePorts(): Promise<[number, number]> {
  const grab = () => new Promise<net.Server>(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return (async () => {
    const [a, b] = await Promise.all([grab(), grab()]);
    const pa = (a.address() as net.AddressInfo).port;
    const pb = (b.address() as net.AddressInfo).port;
    await Promise.all([
      new Promise<void>(r => a.close(() => r())),
      new Promise<void>(r => b.close(() => r())),
    ]);
    return [pa, pb] as [number, number];
  })();
}

describe('LazyProxy.ensureStarted', () => {
  it('runs the on-demand start and reports the service reachable', { timeout: 15000 }, async () => {
    const [listenPort, targetPort] = await findFreePorts();
    let starts = 0;
    let target: net.Server | null = null;

    const proxy = createLazyProxy({
      listenPort, targetPort, timeoutMin: 0,
      onDemandStart: async () => {
        starts++;
        target = net.createServer(s => s.end());
        await new Promise<void>(r => target!.listen(targetPort, '127.0.0.1', r));
      },
      onIdleStop: () => {},
      isAlive: () => !!target,
    });
    try {
      assert.equal(await proxy.ensureStarted(), true);
      assert.equal(starts, 1);
      // Already up: no second start.
      assert.equal(await proxy.ensureStarted(), true);
      assert.equal(starts, 1);
    } finally {
      proxy.destroy();
      target?.close();
    }
  });

  it('shares one start between concurrent callers', { timeout: 15000 }, async () => {
    // A connection arriving while the control plane's `start` is in flight —
    // or two clients racing — must not spawn the service twice.
    const [listenPort, targetPort] = await findFreePorts();
    let starts = 0;
    let target: net.Server | null = null;

    const proxy = createLazyProxy({
      listenPort, targetPort, timeoutMin: 0,
      onDemandStart: async () => {
        starts++;
        await new Promise(r => setTimeout(r, 300)); // slow start, so the calls overlap
        target = net.createServer(s => s.end());
        await new Promise<void>(r => target!.listen(targetPort, '127.0.0.1', r));
      },
      onIdleStop: () => {},
      isAlive: () => !!target,
    });
    try {
      const [a, b, c] = await Promise.all([proxy.ensureStarted(), proxy.ensureStarted(), proxy.ensureStarted()]);
      assert.deepEqual([a, b, c], [true, true, true]);
      assert.equal(starts, 1, 'concurrent callers spawned the service more than once');
    } finally {
      proxy.destroy();
      target?.close();
    }
  });

  it('reports false when the service never comes up', { timeout: 15000 }, async () => {
    const [listenPort, targetPort] = await findFreePorts();
    const proxy = createLazyProxy({
      listenPort, targetPort, timeoutMin: 0,
      onDemandStart: async () => { throw new Error('boom'); },
      onIdleStop: () => {},
      isAlive: () => false,
    });
    try {
      assert.equal(await proxy.ensureStarted(), false);
    } finally {
      proxy.destroy();
    }
  });
});

describe('LazyProxy.ensureStarted after an external stop', () => {
  it('starts again when the service died without the proxy noticing', { timeout: 15000 }, async () => {
    // serviceReady is only cleared when the proxy itself idle-stops the
    // service. An external `ctl stop` leaves it true, and isAlive() agrees for
    // a while — proc is never nulled, .killed stays false for a group kill, and
    // health lags the poller. Trusting it makes `ctl stop && ctl start` a
    // silent no-op: the CLI prints a tick over a service that stays down.
    const [listenPort, targetPort] = await findFreePorts();
    let starts = 0;
    let target: net.Server | null = null;
    let pretendAlive = true;

    const proxy = createLazyProxy({
      listenPort, targetPort, timeoutMin: 0,
      onDemandStart: async () => {
        starts++;
        target = net.createServer(s => s.end());
        await new Promise<void>(r => target!.listen(targetPort, '127.0.0.1', r));
      },
      onIdleStop: () => {},
      isAlive: () => pretendAlive,
    });
    try {
      assert.equal(await proxy.ensureStarted(), true);
      assert.equal(starts, 1);

      // Killed from outside. isAlive() still says yes — that is the trap.
      await new Promise<void>(r => target!.close(() => r()));
      target = null;
      assert.equal(pretendAlive, true, 'the stale belief is the point of this test');

      assert.equal(await proxy.ensureStarted(), true);
      assert.equal(starts, 2, 'the proxy trusted a stale serviceReady and started nothing');
    } finally {
      proxy.destroy();
      target?.close();
    }
  });
});
