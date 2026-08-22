import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createLazyProxy, type LazyProxy } from '../../../src/lazy/proxy.js';

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

const servers: net.Server[] = [];
const proxies: LazyProxy[] = [];

// Suppress ECONNRESET from piped sockets during proxy tests
let origListeners: Function[] = [];
beforeEach(() => {
  origListeners = process.listeners('uncaughtException').slice();
  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
    throw err;
  });
});

afterEach(() => {
  proxies.forEach(p => p.destroy());
  proxies.length = 0;
  servers.forEach(s => s.close());
  servers.length = 0;
  process.removeAllListeners('uncaughtException');
  origListeners.forEach(l => process.on('uncaughtException', l as any));
});

function echoServer(port: number, response: string): Promise<net.Server> {
  return new Promise(resolve => {
    const srv = net.createServer(socket => {
      socket.on('error', () => {});
      socket.write(response);
      socket.on('end', () => socket.end());
    });
    srv.listen(port, () => { servers.push(srv); resolve(srv); });
  });
}

describe('createLazyProxy', () => {
  it('pipes to target when alive', { timeout: 5000 }, async () => {
    const targetPort = await findFreePort();
    const listenPort = await findFreePort();
    await echoServer(targetPort, 'hello');

    const proxy = createLazyProxy({
      listenPort, targetPort, timeoutMin: 0,
      onDemandStart: async () => {},
      onIdleStop: () => {},
      isAlive: () => true,
    });
    proxies.push(proxy);

    const data = await new Promise<string>((resolve) => {
      const client = net.createConnection(listenPort, '127.0.0.1');
      client.on('error', () => {});
      let buf = '';
      client.on('data', d => { buf += d.toString(); client.end(); });
      client.on('end', () => resolve(buf));
      setTimeout(() => resolve(buf), 2000);
    });

    assert.ok(data.includes('hello'));
  });

  it('triggers onDemandStart when not alive', { timeout: 10000 }, async () => {
    const targetPort = await findFreePort();
    const listenPort = await findFreePort();
    let started = false;

    const proxy = createLazyProxy({
      listenPort, targetPort, timeoutMin: 0,
      onDemandStart: async () => {
        started = true;
        await echoServer(targetPort, 'lazy');
      },
      onIdleStop: () => {},
      isAlive: () => false,
    });
    proxies.push(proxy);

    const data = await new Promise<string>((resolve) => {
      const client = net.createConnection(listenPort, '127.0.0.1');
      client.on('error', () => {});
      let buf = '';
      client.on('data', d => { buf += d.toString(); client.end(); });
      client.on('end', () => resolve(buf));
      setTimeout(() => resolve(buf), 5000);
    });

    assert.equal(started, true);
    assert.ok(data.includes('lazy'));
  });

  it('calls onIdleStop after timeout', { timeout: 3000 }, async () => {
    const listenPort = await findFreePort();
    let idleStopped = false;

    const proxy = createLazyProxy({
      listenPort, targetPort: 19999, timeoutMin: 0.001,
      onDemandStart: async () => {},
      onIdleStop: () => { idleStopped = true; },
      isAlive: () => true,
    });
    proxies.push(proxy);

    await new Promise(r => setTimeout(r, 200));
    assert.equal(idleStopped, true);
  });

  it('does not stop a service that is under the inspector', { timeout: 4000 }, async () => {
    // Un servicio pausado en un breakpoint no recibe tráfico por definición:
    // leer código y volver son minutos sin una sola conexión. Pararlo ahí mata
    // la sesión de depuración mientras su dueño la está usando.
    const listenPort = await findFreePort();
    let idleStopped = false;
    let debugging = true;

    const proxy = createLazyProxy({
      listenPort, targetPort: 19999, timeoutMin: 0.001,
      onDemandStart: async () => {},
      onIdleStop: () => { idleStopped = true; },
      isAlive: () => true,
      isDebugging: () => debugging,
    });
    proxies.push(proxy);

    // Varios periodos de sobra: sin la guarda, el primero ya lo habría parado.
    await new Promise(r => setTimeout(r, 250));
    assert.equal(idleStopped, false, 'no debe pararse mientras el inspector está activo');

    // Y cuando deja de estar bajo el inspector vuelve la regla normal. Ojo:
    // aquí se apaga el flag a mano; en producción `debugPort` sólo se limpia
    // al apagar el debug o al morir el proceso, porque el inspector de Node
    // sigue escuchando tras un desacople.
    debugging = false;
    await new Promise(r => setTimeout(r, 250));
    assert.equal(idleStopped, true, 'debe pararse una vez que ya no se depura');
  });

  it('destroy cleans up server', { timeout: 3000 }, async () => {
    const listenPort = await findFreePort();
    const proxy = createLazyProxy({
      listenPort, targetPort: 19999, timeoutMin: 0,
      onDemandStart: async () => {},
      onIdleStop: () => {},
      isAlive: () => false,
    });
    proxy.destroy();

    const ok = await new Promise<boolean>(resolve => {
      const client = net.createConnection(listenPort, '127.0.0.1');
      client.on('connect', () => { client.destroy(); resolve(true); });
      client.on('error', () => resolve(false));
    });
    assert.equal(ok, false);
  });
});
