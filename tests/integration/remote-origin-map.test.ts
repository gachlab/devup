import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { switchService } from '../../src/remote/switch.js';
import { classifyRemote } from '../../src/remote/classifier.js';
import { startRemoteServices } from '../../src/remote/boot.js';
import { createRemoteProxy } from '../../src/remote/proxy.js';
import { ProcessManager } from '../../src/process/manager.js';
import { detectPlatform } from '../../src/platform/detect.js';
import type { RemoteProxy } from '../../src/remote/proxy.js';
import type { DevStackConfig, ServiceConfig } from '../../src/config/types.js';

const isWin = process.platform === 'win32';
const findFreePort = () => new Promise<number>(resolve => {
  const s = net.createServer();
  s.listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
});
const svc = (name: string, port: number): ServiceConfig => ({ name, cwd: '.', cmd: 'node', args: [], type: 'api', port, phase: 0 });
const listen = (srv: http.Server) => new Promise<string>(r => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`)));
function head(port: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/login' }, res => { res.resume(); resolve(res); }).on('error', reject);
  });
}

describe('remote origin map across a switch', { skip: isWin }, () => {
  const proxies = new Map<string, RemoteProxy>();
  const servers: http.Server[] = [];
  const managers: ProcessManager[] = [];
  after(async () => {
    for (const p of proxies.values()) p.destroy();
    for (const s of servers) s.close();
    for (const m of managers) await m.cleanup({ gracePeriodMs: 100 }).catch(() => {});
  });

  it("localizes a redirect to a service switched to the environment after boot", { timeout: 20000 }, async () => {
    // QA's auth answers a login with a 302 to QA's app. Switching `app` to qa
    // after boot used to leave auth's proxy with the map it was built with,
    // so the redirect walked the browser out of the local stack.
    let authTargetRef = '';
    // QA's app sends /go back to QA's auth: the proxy the switch creates must
    // share the run's map to localize that one.
    const appQa = http.createServer((q, r) => {
      if (q.url === '/go') { r.writeHead(302, { location: `${authTargetRef}/login` }); r.end(); return; }
      r.writeHead(200); r.end('app');
    });
    servers.push(appQa);
    const appTarget = await listen(appQa);
    const authQa = http.createServer((_q, r) => { r.writeHead(302, { location: `${appTarget}/home` }); r.end(); });
    servers.push(authQa);
    const authTarget = await listen(authQa);
    authTargetRef = authTarget;

    const authPort = await findFreePort();
    const appPort = await findFreePort();
    const auth = svc('auth', authPort);
    const app = svc('app', appPort);
    const config: DevStackConfig = {
      name: 'om', services: [auth, app],
      environments: { qa: { targets: { auth: authTarget, app: appTarget } } },
    };

    const mgr = new ProcessManager({
      baseCwd: process.cwd(), env: {}, platform: await detectPlatform(),
      events: { onLog: () => {}, onStateChange: () => {} },
    });
    managers.push(mgr);
    mgr.state.set('app', {
      svc: app, proc: null, pid: null, status: 'stopped', health: 'down',
      errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 1, crashLog: null,
    });
    const classification = classifyRemote(config.services, [app], { envName: 'qa', env: config.environments!.qa! }, undefined);
    startRemoteServices({ mgr, classification, proxies, colorIdxStart: 0, onLog: () => {} });

    const res = await switchService({ mgr, config, remoteProxies: proxies, onLog: () => {} }, 'app', 'qa');
    assert.equal(res.ok, true, res.error);

    const reply = await head(authPort);
    assert.equal(reply.statusCode, 302);
    assert.equal(reply.headers.location, `http://localhost:${appPort}/home`);
    const back = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: appPort, path: '/go' }, res => { res.resume(); resolve(res); }).on('error', reject);
    });
    assert.equal(back.headers.location, `http://localhost:${authPort}/login`);
  });

  it('localizes a redirect to a service that runs locally, not only to remote ones', { timeout: 20000 }, async () => {
    // `--remote qa:auth`: app runs here on its public port — or was switched
    // back to local to work on it. Its QA origin must still map to localhost,
    // or the login redirect lands on QA's app.
    const appQa = http.createServer((_q, r) => { r.writeHead(200); r.end('qa app'); });
    servers.push(appQa);
    const appTarget = await listen(appQa);
    const authQa = http.createServer((_q, r) => { r.writeHead(302, { location: `${appTarget}/home` }); r.end(); });
    servers.push(authQa);
    const authTarget = await listen(authQa);
    const authPort = await findFreePort();
    const appPort = await findFreePort();
    const auth = svc('auth', authPort);
    const app = svc('app', appPort);
    const env = { targets: { auth: authTarget, app: appTarget } };

    const mgr = new ProcessManager({
      baseCwd: process.cwd(), env: {}, platform: await detectPlatform(),
      events: { onLog: () => {}, onStateChange: () => {} },
    });
    managers.push(mgr);
    const registry = new Map<string, RemoteProxy>();
    const classification = classifyRemote([auth, app], [auth, app], { envName: 'qa', env, only: ['auth'] }, undefined);
    assert.deepEqual(classification.local.map(s => s.name), ['app']);
    startRemoteServices({ mgr, classification, proxies: registry, colorIdxStart: 0, onLog: () => {} });
    for (const p of registry.values()) proxies.set(`local-case-${p.target}`, p);

    const reply = await head(authPort);
    assert.equal(reply.headers.location, `http://localhost:${appPort}/home`);
  });

  it('relays a WebSocket 101 with each Set-Cookie on its own line, localized', { timeout: 20000 }, async () => {
    const upstream = http.createServer();
    upstream.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Set-Cookie: a=1; Domain=qa.test; Secure; Expires=Wed, 21 Oct 2026 07:28:00 GMT\r\n' +
        'Set-Cookie: b=2; Secure\r\n\r\n');
    });
    servers.push(upstream);
    const target = await listen(upstream);
    const port = await findFreePort();
    const proxy = createRemoteProxy({ listenPort: port, target, envName: 'qa', env: {}, originMap: new Map() });
    proxies.set('ws-case', proxy);
    await new Promise(r => setTimeout(r, 100));

    const head101 = await new Promise<string>((resolve, reject) => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      let buf = '';
      c.on('data', d => { buf += d; if (buf.includes('\r\n\r\n')) { c.destroy(); resolve(buf); } });
      c.on('error', reject);
    });
    const cookies = head101.split('\r\n').filter(l => /^set-cookie:/i.test(l));
    assert.equal(cookies.length, 2, head101);
    assert.ok(cookies.every(c => !/Domain=|Secure/.test(c)), cookies.join('\n'));
  });
});
