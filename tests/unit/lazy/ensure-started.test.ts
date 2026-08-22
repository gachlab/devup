import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createLazyProxy } from '../../../src/lazy/proxy.js';

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

describe('LazyProxy.ensureStarted', () => {
  it('runs the on-demand start and reports the service reachable', { timeout: 15000 }, async () => {
    const listenPort = await findFreePort();
    const targetPort = await findFreePort();
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
    const listenPort = await findFreePort();
    const targetPort = await findFreePort();
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
    const listenPort = await findFreePort();
    const targetPort = await findFreePort();
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
