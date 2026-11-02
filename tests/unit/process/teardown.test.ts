import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { onFatal, type FatalHost } from '../../../src/process/teardown.js';

function fakeHost(): FatalHost & EventEmitter & { exits: number[] } {
  const em = new EventEmitter() as EventEmitter & { exits: number[]; exit: (c: number) => void };
  em.exits = [];
  em.exit = (code: number) => { em.exits.push(code); };
  return em as any;
}

const tick = () => new Promise(r => setImmediate(r));

describe('onFatal', () => {
  it('runs the teardown on SIGTERM and exits 128 + 15', async () => {
    const host = fakeHost();
    let runs = 0;
    onFatal(async () => { runs++; }, { host, report: () => {} });
    host.emit('SIGTERM');
    await tick();
    assert.equal(runs, 1);
    assert.deepEqual(host.exits, [143]);
  });

  it('handles SIGHUP too: closing the terminal must not leave the stack alive', async () => {
    const host = fakeHost();
    let runs = 0;
    onFatal(async () => { runs++; }, { host, report: () => {} });
    host.emit('SIGHUP');
    await tick();
    assert.equal(runs, 1);
    assert.deepEqual(host.exits, [129]);
  });

  it('a second signal during teardown neither repeats it nor exits early', async () => {
    const host = fakeHost();
    let runs = 0;
    let release!: () => void;
    onFatal(() => { runs++; return new Promise<void>(r => { release = r; }); }, { host, report: () => {} });
    host.emit('SIGINT');
    host.emit('SIGINT');
    host.emit('SIGTERM');
    await tick();
    assert.equal(runs, 1);
    assert.deepEqual(host.exits, [], 'exiting before it finishes is what orphans children');
    release();
    await tick();
    assert.deepEqual(host.exits, [130]);
  });

  it('an uncaught exception is reported, cleaned up, and exits 1', async () => {
    const host = fakeHost();
    const reported: unknown[] = [];
    let runs = 0;
    onFatal(async () => { runs++; }, { host, report: e => reported.push(e) });
    const err = new Error('boom');
    host.emit('uncaughtException', err);
    await tick();
    assert.equal(runs, 1);
    assert.deepEqual(reported, [err]);
    assert.deepEqual(host.exits, [1]);
  });

  it('so is an unhandled rejection', async () => {
    const host = fakeHost();
    let runs = 0;
    onFatal(async () => { runs++; }, { host, report: () => {} });
    host.emit('unhandledRejection', new Error('nope'));
    await tick();
    assert.equal(runs, 1);
    assert.deepEqual(host.exits, [1]);
  });

  it('signalExitCode lets the daemon exit 0', async () => {
    const host = fakeHost();
    onFatal(async () => {}, { host, report: () => {}, signalExitCode: () => 0 });
    host.emit('SIGTERM');
    await tick();
    assert.deepEqual(host.exits, [0]);
  });

  it('the disposer removes every listener', () => {
    const host = fakeHost();
    const dispose = onFatal(async () => {}, { host, report: () => {} });
    for (const ev of ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection']) {
      assert.equal(host.listenerCount(ev), 1, ev);
    }
    dispose();
    for (const ev of ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection']) {
      assert.equal(host.listenerCount(ev), 0, ev);
    }
  });

  it('a throwing report breaks nothing and the teardown still runs', async () => {
    // A throw inside an 'uncaughtException' listener kills the process on the
    // spot, mid-teardown.
    const host = fakeHost();
    let runs = 0;
    onFatal(async () => { runs++; }, { host, report: () => { throw new Error('EPIPE'); } });
    assert.doesNotThrow(() => host.emit('uncaughtException', new Error('boom')));
    await tick();
    assert.equal(runs, 1);
    assert.deepEqual(host.exits, [1]);
  });

  it('reports with a budget: a closed terminal does not become an error loop', async () => {
    const host = fakeHost();
    let reports = 0;
    onFatal(() => new Promise<void>(() => {}), { host, report: () => { reports++; } });
    for (let i = 0; i < 50; i++) host.emit('uncaughtException', new Error(`write EIO ${i}`));
    await tick();
    assert.equal(reports, 3);
  });
});
