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

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
  });
}

function bindable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
  });
}

/** Wait until the proxy is actually accepting. `server.listen` is async, and a
 *  request fired in the same tick as the switch gets ECONNRESET — a race in
 *  the test, not in the proxy. */
async function waitListening(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>(resolve => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (ok) return;
    if (Date.now() >= deadline) throw new Error(`:${port} never started listening`);
    await new Promise(r => setTimeout(r, 50));
  }
}

function get(port: number, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
}

describe('switchService', { skip: isWin }, () => {
  const created: RemoteProxy[] = [];
  // Anything spawned by a switch back to local outlives its test otherwise.
  const managers: ProcessManager[] = [];
  const servers: http.Server[] = [];
  after(async () => {
    for (const p of created) p.destroy();
    for (const m of managers) await m.cleanup().catch(() => {});
    // `close()` alone waits for keep-alive sockets the proxy parked here, and
    // the suite would never finish.
    for (const s of servers) {
      s.closeAllConnections?.();
      await new Promise<void>(r => s.close(() => r()));
    }
  });

  const track = () => {
    const map = new Map<string, RemoteProxy>();
    const set = map.set.bind(map);
    map.set = (n: string, p: RemoteProxy) => { created.push(p); return set(n, p); };
    return map;
  };

  async function upstream(body: string): Promise<string> {
    const server = http.createServer((_q, r) => { r.writeHead(200); r.end(body); });
    servers.push(server);
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  // `detectPlatform()` is async; passing the promise makes `platform.killTree`
  // undefined and the failure only shows up when something is stopped —
  // tests/ is not typechecked, so nothing catches it earlier.
  const mkManager = async (lines: string[]) => track_(new ProcessManager({
    // A real PATH: bringing a service local actually spawns it, and an empty
    // environment fails with `spawn node ENOENT` before the thing under test
    // ever runs.
    baseCwd: process.cwd(), env: { PATH: process.env['PATH'] ?? '' }, platform: await detectPlatform(),
    events: { onLog: (_s, t) => lines.push(t), onStateChange: () => {} },
  }));
  const track_ = (m: ProcessManager) => { managers.push(m); return m; };

  async function setup(port: number, target: string) {
    const svc: ServiceConfig = {
      name: 'app-api', cwd: '.', cmd: 'node', args: ['-e', 'setTimeout(()=>{},1e9)'],
      type: 'api', port, phase: 0,
    };
    const config: DevStackConfig = {
      name: 'test', services: [svc],
      environments: { qa: { targets: { 'app-api': target } } },
    };
    const lines: string[] = [];
    const mgr = await mkManager(lines);
    const proxies = track();
    const classification = classifyRemote([svc], [], { envName: 'qa', env: config.environments!['qa']! }, undefined);
    startRemoteServices({ mgr, classification, proxies, colorIdxStart: 0, onLog: () => {} });
    await waitListening(port);
    return { svc, config, mgr, proxies, lines };
  }

  it('moves a service from one environment to another', { timeout: 15000 }, async () => {
    const port = await findFreePort();
    const qaTarget = await upstream('from qa');
    const stgTarget = await upstream('from staging');
    const { config, mgr, proxies } = await setup(port, qaTarget);
    config.environments!['staging'] = { targets: { 'app-api': stgTarget } };

    assert.equal((await get(port)).body, 'from qa');

    const res = await switchService(
      { mgr, config, remoteProxies: proxies, onLog: () => {} }, 'app-api', 'staging');
    assert.equal(res.ok, true, res.error);
    assert.equal(res.remote?.envName, 'staging');
    await waitListening(port);
    // Asserted through the port, not through the state map: what changed has
    // to be what answers.
    assert.equal((await get(port)).body, 'from staging');
  });

  it('is a no-op when the service is already on that environment', { timeout: 15000 }, async () => {
    const port = await findFreePort();
    const { config, mgr, proxies } = await setup(port, await upstream('qa'));

    const res = await switchService(
      { mgr, config, remoteProxies: proxies, onLog: () => {} }, 'app-api', 'qa');
    assert.equal(res.ok, true);
    assert.equal((await get(port)).body, 'qa');
  });

  it('hands the port from the proxy to a real local process, and back', { timeout: 30000 }, async () => {
    const port = await findFreePort();
    const { config, mgr, proxies } = await setup(port, await upstream('from qa'));
    // A service that really listens, so the handover is observable from the
    // outside rather than inferred from the state map.
    config.services[0]!.args = [
      '-e',
      `require('http').createServer((q, r) => r.end('local')).listen(${port})`,
    ];
    assert.equal((await get(port)).body, 'from qa');

    const toLocal = await switchService(
      { mgr, config, remoteProxies: proxies, onLog: () => {} }, 'app-api', null);
    assert.equal(toLocal.ok, true, toLocal.error);
    assert.equal(toLocal.remote, null);
    assert.equal(mgr.state.get('app-api')?.remote, undefined, 'still marked remote');
    assert.equal(proxies.has('app-api'), false, 'proxy still registered');
    // The same port, answering from the process now. Nothing about this is
    // visible in the state map alone — which is the point of asking the port.
    assert.equal((await get(port)).body, 'local');
    assert.ok(mgr.state.get('app-api')?.pid, 'no pid after coming local');

    const back = await switchService(
      { mgr, config, remoteProxies: proxies, onLog: () => {} }, 'app-api', 'qa');
    assert.equal(back.ok, true, back.error);
    await waitListening(port);
    // And back again, which is the half that has to wait for the process to
    // let go of the port before binding.
    assert.equal((await get(port)).body, 'from qa');
    assert.equal(mgr.state.get('app-api')?.pid, null);
    await mgr.cleanup();
  });

  it('refuses an unknown environment and names the ones that exist', { timeout: 15000 }, async () => {
    const port = await findFreePort();
    const { config, mgr, proxies } = await setup(port, await upstream('qa'));

    const res = await switchService(
      { mgr, config, remoteProxies: proxies, onLog: () => {} }, 'app-api', 'prod');
    assert.equal(res.ok, false);
    assert.match(res.error!, /unknown environment: "prod".*qa/s);
    // And it left the service exactly as it was, rather than half-switched.
    assert.equal((await get(port)).body, 'qa');
  });

  it('refuses a service the environment cannot reach, without tearing it down', { timeout: 15000 }, async () => {
    const port = await findFreePort();
    const { config, mgr, proxies } = await setup(port, await upstream('qa'));
    config.environments!['staging'] = { domain: 'stg.test' }; // no route, no target

    const res = await switchService(
      { mgr, config, remoteProxies: proxies, onLog: () => {} }, 'app-api', 'staging');
    assert.equal(res.ok, false);
    assert.match(res.error!, /no target for app-api in "staging"/);
    // Checked before anything is released: a failed switch must not leave the
    // service worse off than it found it.
    assert.equal((await get(port)).body, 'qa');
  });

  it('refuses a service that is not in the stack', { timeout: 15000 }, async () => {
    const port = await findFreePort();
    const { config, mgr, proxies } = await setup(port, await upstream('qa'));

    const res = await switchService(
      { mgr, config, remoteProxies: proxies, onLog: () => {} }, 'nope', 'qa');
    assert.equal(res.ok, false);
    assert.match(res.error!, /unknown service: nope/);
  });

  it('warns about writes on the way in', { timeout: 15000 }, async () => {
    const port = await findFreePort();
    const stg = await upstream('staging');
    const { config, mgr, proxies } = await setup(port, await upstream('qa'));
    config.environments!['staging'] = { targets: { 'app-api': stg } };

    const lines: string[] = [];
    await switchService(
      { mgr, config, remoteProxies: proxies, onLog: (_s, m) => lines.push(m) }, 'app-api', 'staging');
    assert.ok(lines.some(l => /writes now reach staging/.test(l)), lines.join('\n'));
  });

  it('stays quiet about writes for a read-only environment', { timeout: 15000 }, async () => {
    const port = await findFreePort();
    const stg = await upstream('staging');
    const { config, mgr, proxies } = await setup(port, await upstream('qa'));
    config.environments!['staging'] = { targets: { 'app-api': stg }, readOnly: true };

    const lines: string[] = [];
    const res = await switchService(
      { mgr, config, remoteProxies: proxies, onLog: (_s, m) => lines.push(m) }, 'app-api', 'staging');
    assert.equal(res.remote?.readOnly, true);
    assert.ok(!lines.some(l => /writes now reach/.test(l)), lines.join('\n'));
  });
});
