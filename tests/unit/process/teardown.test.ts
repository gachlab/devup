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
  it('corre el teardown en SIGTERM y sale con 128 + 15', async () => {
    const host = fakeHost();
    let runs = 0;
    onFatal(async () => { runs++; }, { host, report: () => {} });
    host.emit('SIGTERM');
    await tick();
    assert.equal(runs, 1);
    assert.deepEqual(host.exits, [143]);
  });

  it('SIGHUP también: cerrar la terminal no puede dejar el stack vivo', async () => {
    const host = fakeHost();
    let runs = 0;
    onFatal(async () => { runs++; }, { host, report: () => {} });
    host.emit('SIGHUP');
    await tick();
    assert.equal(runs, 1);
    assert.deepEqual(host.exits, [129]);
  });

  it('una segunda señal durante el teardown no lo repite ni sale antes', async () => {
    const host = fakeHost();
    let runs = 0;
    let release!: () => void;
    onFatal(() => { runs++; return new Promise<void>(r => { release = r; }); }, { host, report: () => {} });
    host.emit('SIGINT');
    host.emit('SIGINT');
    host.emit('SIGTERM');
    await tick();
    assert.equal(runs, 1);
    assert.deepEqual(host.exits, [], 'salir antes de terminar es lo que deja huérfanos');
    release();
    await tick();
    assert.deepEqual(host.exits, [130]);
  });

  it('una excepción no capturada se reporta, limpia y sale con 1', async () => {
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

  it('un rechazo no manejado también', async () => {
    const host = fakeHost();
    let runs = 0;
    onFatal(async () => { runs++; }, { host, report: () => {} });
    host.emit('unhandledRejection', new Error('nope'));
    await tick();
    assert.equal(runs, 1);
    assert.deepEqual(host.exits, [1]);
  });

  it('signalExitCode permite al daemon salir con 0', async () => {
    const host = fakeHost();
    onFatal(async () => {}, { host, report: () => {}, signalExitCode: () => 0 });
    host.emit('SIGTERM');
    await tick();
    assert.deepEqual(host.exits, [0]);
  });

  it('el disposer quita todos los listeners', () => {
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
});
