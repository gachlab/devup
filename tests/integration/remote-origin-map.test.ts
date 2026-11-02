import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { switchService } from '../../src/remote/switch.js';
import { classifyRemote } from '../../src/remote/classifier.js';
import { startRemoteServices } from '../../src/remote/boot.js';
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
    const appQa = http.createServer((_q, r) => { r.writeHead(200); r.end('app'); });
    servers.push(appQa);
    const appTarget = await listen(appQa);
    const authQa = http.createServer((_q, r) => { r.writeHead(302, { location: `${appTarget}/home` }); r.end(); });
    servers.push(authQa);
    const authTarget = await listen(authQa);

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
  });
});
