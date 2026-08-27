import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createRemoteProxy, type RemoteProxy } from '../../src/remote/proxy.js';
import type { EnvironmentConfig } from '../../src/config/types.js';

const isWin = process.platform === 'win32';

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
  });
}

/** Whatever the last request carried, so a test can assert on what actually
 *  travelled rather than on what the transform said it would. */
interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Upstream {
  server: http.Server;
  origin: string;
  seen: Seen;
  reply: (res: http.ServerResponse) => void;
}

async function startUpstream(): Promise<Upstream> {
  const seen: Seen = { headers: {}, body: '' };
  const up: Partial<Upstream> = {
    reply: res => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); },
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.headers = req.headers;
      seen.body = Buffer.concat(chunks).toString();
      up.reply!(res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(up, {
    server, seen,
    origin: `http://127.0.0.1:${port}`,
  }) as Upstream;
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, opts: http.RequestOptions & { body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', ...opts }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => resolve({
        status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('remote-proxy integration', { skip: isWin }, () => {
  let upstream: Upstream;
  let listenPort: number;
  const proxies: RemoteProxy[] = [];

  const mount = (env: EnvironmentConfig, extra: Partial<Parameters<typeof createRemoteProxy>[0]> = {}): RemoteProxy => {
    const proxy = createRemoteProxy({
      listenPort, target: upstream.origin, envName: 'qa', env,
      originMap: new Map([[upstream.origin, `http://localhost:${listenPort}`]]),
      ...extra,
    });
    proxies.push(proxy);
    return proxy;
  };

  before(async () => {
    upstream = await startUpstream();
    listenPort = await findFreePort();
  });

  after(async () => {
    for (const p of proxies) p.destroy();
    await new Promise<void>(resolve => upstream.server.close(() => resolve()));
  });

  const reset = () => {
    for (const p of proxies.splice(0)) p.destroy();
    upstream.reply = res => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); };
    // Cleared, not just overwritten: a test asserting that *nothing* reached
    // the upstream would otherwise read the previous test's request.
    upstream.seen.method = undefined;
    upstream.seen.url = undefined;
    upstream.seen.headers = {};
    upstream.seen.body = '';
  };

  it('rewrites Host and sets Origin on the wire', { timeout: 10000 }, async () => {
    reset();
    mount({ origin: 'https://demoa.app.inprovider.cl' });
    await new Promise(r => setTimeout(r, 50));

    const res = await request(listenPort, { path: '/api/flows', headers: { host: `localhost:${listenPort}` } });
    assert.equal(res.status, 200);
    assert.equal(upstream.seen.url, '/api/flows');
    assert.equal(upstream.seen.headers.host, new URL(upstream.origin).host);
    assert.equal(upstream.seen.headers.origin, 'https://demoa.app.inprovider.cl');
  });

  it('forwards the method and the request body', { timeout: 10000 }, async () => {
    reset();
    mount({});
    await new Promise(r => setTimeout(r, 50));

    await request(listenPort, {
      method: 'POST', path: '/login',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"a@b.c"}',
    });
    assert.equal(upstream.seen.method, 'POST');
    assert.equal(upstream.seen.body, '{"email":"a@b.c"}');
  });

  it('localizes Set-Cookie so a browser on localhost keeps the session', { timeout: 10000 }, async () => {
    reset();
    upstream.reply = res => {
      res.writeHead(200, {
        'set-cookie': ['access_token=xyz; Domain=.qa.norelian.com; Path=/; HttpOnly; Secure; SameSite=Strict'],
      });
      res.end('ok');
    };
    mount({});
    await new Promise(r => setTimeout(r, 50));

    const res = await request(listenPort);
    const cookie = (res.headers['set-cookie'] ?? [])[0] ?? '';
    assert.ok(!/domain=/i.test(cookie), `Domain survived: ${cookie}`);
    assert.ok(!/;\s*secure/i.test(cookie), `Secure survived: ${cookie}`);
    assert.ok(cookie.includes('HttpOnly'));
  });

  it('points a redirect back at the local stack', { timeout: 10000 }, async () => {
    reset();
    upstream.reply = res => { res.writeHead(302, { location: `${upstream.origin}/home` }); res.end(); };
    mount({});
    await new Promise(r => setTimeout(r, 50));

    const res = await request(listenPort);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `http://localhost:${listenPort}/home`);
  });

  it('restores the local origin in the CORS header', { timeout: 10000 }, async () => {
    reset();
    upstream.reply = res => {
      // What an upstream that echoes `req.headers.origin` does — it answers
      // with the rewritten one, which the browser then rejects.
      res.writeHead(200, { 'access-control-allow-origin': 'https://qa.norelian.com' });
      res.end('ok');
    };
    mount({ origin: 'https://qa.norelian.com' });
    await new Promise(r => setTimeout(r, 50));

    const res = await request(listenPort, { headers: { origin: 'http://localhost:4201' } });
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:4201');
  });

  it('refuses writes when the environment is read-only, and still serves reads', { timeout: 10000 }, async () => {
    reset();
    mount({ readOnly: true });
    await new Promise(r => setTimeout(r, 50));

    const post = await request(listenPort, { method: 'POST', path: '/things', body: '{}' });
    assert.equal(post.status, 405);
    assert.equal(upstream.seen.method, undefined, 'the write reached the environment');

    const get = await request(listenPort, { path: '/things' });
    assert.equal(get.status, 200);
  });

  it('answers 502 and reports the failure when the environment is unreachable', { timeout: 10000 }, async () => {
    reset();
    const deadPort = await findFreePort();
    const errors: Error[] = [];
    const proxy = createRemoteProxy({
      listenPort, target: `http://127.0.0.1:${deadPort}`, envName: 'qa', env: {},
      originMap: new Map(),
      onUpstreamError: err => errors.push(err),
    });
    proxies.push(proxy);
    await new Promise(r => setTimeout(r, 50));

    const res = await request(listenPort);
    assert.equal(res.status, 502);
    assert.equal(errors.length, 1);
  });

  it('probe answers true for a reachable environment and false for a dead one', { timeout: 10000 }, async () => {
    reset();
    const alive = mount({});
    assert.equal(await alive.probe(), true);

    const deadPort = await findFreePort();
    const dead = createRemoteProxy({
      listenPort: await findFreePort(), target: `http://127.0.0.1:${deadPort}`,
      envName: 'qa', env: {}, originMap: new Map(),
    });
    proxies.push(dead);
    assert.equal(await dead.probe(), false);
  });

  it('probe counts any answer as reachable, 401 included', { timeout: 10000 }, async () => {
    reset();
    upstream.reply = res => { res.writeHead(401); res.end(); };
    const proxy = mount({});
    // An environment that answers 401 to an unauthenticated probe is up.
    // Treating that as down paints a working stack red.
    assert.equal(await proxy.probe(), true);
  });

  it('frees the port on destroy', { timeout: 10000 }, async () => {
    reset();
    const proxy = mount({});
    await new Promise(r => setTimeout(r, 50));
    proxy.destroy();

    // Asserted by binding it again, not by reading a flag: a proxy that still
    // holds the port answers for a service every client was told had gone.
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(listenPort, '0.0.0.0', () => s.close(() => resolve()));
    });
  });
});

describe('remote-proxy upgrades', { skip: isWin }, () => {
  /** A minimal protocol switch: enough of a handshake to prove the pair of
   *  hop-by-hop headers survived and that bytes flow both ways afterwards.
   *  A real WebSocket frame codec would test `ws`, not the proxy. */
  function startEchoUpstream(): Promise<{ server: http.Server; origin: string; seenHeaders: () => http.IncomingHttpHeaders; close: () => Promise<void> }> {
    let seen: http.IncomingHttpHeaders = {};
    // An upgraded socket is not a request: `server.close()` waits for it for
    // ever, so the test has to let go of them itself.
    const sockets = new Set<net.Socket>();
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end('not an upgrade'); });
    server.on('upgrade', (req, socket, head) => {
      seen = req.headers;
      sockets.add(socket as net.Socket);
      socket.on('close', () => sockets.delete(socket as net.Socket));
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      if (head?.length) socket.unshift(head);
      socket.on('data', (chunk: Buffer) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])));
    });
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve({
        server,
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        seenHeaders: () => seen,
        close: () => new Promise<void>(done => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          server.close(() => done());
        }),
      }));
    });
  }

  it('relays a protocol switch and pipes bytes both ways', { timeout: 10000 }, async () => {
    const up = await startEchoUpstream();
    const port = await findFreePort();
    const proxy = createRemoteProxy({
      listenPort: port, target: up.origin, envName: 'qa',
      env: { origin: 'https://qa.norelian.com' }, originMap: new Map(),
    });
    await new Promise(r => setTimeout(r, 50));

    try {
      const { status, echoed } = await new Promise<{ status: string; echoed: string }>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(
            `GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\n` +
            'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\n\r\n',
          );
        });
        let buf = '';
        socket.on('data', chunk => {
          buf += chunk.toString();
          if (buf.includes('\r\n\r\n') && !buf.includes('echo:')) socket.write('ping');
          if (buf.includes('echo:ping')) {
            socket.destroy();
            resolve({ status: buf.split('\r\n')[0]!, echoed: 'echo:ping' });
          }
        });
        socket.on('error', reject);
        setTimeout(() => reject(new Error(`no upgrade; got: ${JSON.stringify(buf)}`)), 5000);
      });

      assert.match(status, /101/);
      assert.equal(echoed, 'echo:ping');
      // The two headers that are hop-by-hop on every other request are the
      // ones that carry this one. Stripping them turns the handshake into an
      // ordinary GET and the upstream answers 200 to a client awaiting 101.
      assert.match(String(up.seenHeaders().upgrade), /websocket/i);
      assert.match(String(up.seenHeaders().connection), /upgrade/i);
      // And the environment's header rules still apply on the way up.
      assert.equal(up.seenHeaders().origin, 'https://qa.norelian.com');
      assert.equal(up.seenHeaders().host, new URL(up.origin).host);
    } finally {
      proxy.destroy();
      await up.close();
    }
  });

  it('closes the client instead of hanging when the upstream refuses the upgrade', { timeout: 10000 }, async () => {
    const plain = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>(resolve => plain.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
    const port = await findFreePort();
    const proxy = createRemoteProxy({
      listenPort: port, target: origin, envName: 'qa', env: {}, originMap: new Map(),
    });
    await new Promise(r => setTimeout(r, 50));

    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(
            `GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
          );
        });
        let buf = '';
        socket.on('data', c => { buf += c.toString(); });
        socket.on('close', () => resolve(buf));
        socket.on('error', reject);
        setTimeout(() => reject(new Error('socket stayed open')), 5000);
      });
      assert.match(answer, /Upgrade Refused/);
    } finally {
      proxy.destroy();
      await new Promise<void>(resolve => plain.close(() => resolve()));
    }
  });
});
