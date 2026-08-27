import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { startRemoteServices } from '../../src/remote/boot.js';
import { classifyRemote } from '../../src/remote/classifier.js';
import { ProcessManager } from '../../src/process/manager.js';
import { detectPlatform } from '../../src/platform/detect.js';
import type { RemoteProxy } from '../../src/remote/proxy.js';
import type { ServiceConfig, EnvironmentConfig } from '../../src/config/types.js';

const isWin = process.platform === 'win32';

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
  });
}

const svc = (name: string, port: number): ServiceConfig => ({
  name, cwd: '.', cmd: 'node', args: ['index.js'], type: 'api', port, phase: 0,
});

describe('startRemoteServices', { skip: isWin }, () => {
  // Every proxy ever created, not just the ones still in a map: two tests
  // registering the same service name overwrite each other's entry, and the
  // displaced proxy would keep its port — and the event loop — open.
  const created: RemoteProxy[] = [];
  const track = () => {
    const map = new Map<string, RemoteProxy>();
    const set = map.set.bind(map);
    map.set = (name: string, proxy: RemoteProxy) => { created.push(proxy); return set(name, proxy); };
    return map;
  };
  after(() => { for (const p of created) p.destroy(); });

  const makeManager = () => new ProcessManager({
    baseCwd: process.cwd(), env: {}, platform: detectPlatform(),
    events: { onLog: () => {}, onStateChange: () => {} },
  });

  it('registers remote services as running-with-no-process and binds their ports', { timeout: 10000 }, async () => {
    const port = await findFreePort();
    const mgr = makeManager();
    const env: EnvironmentConfig = { domain: 'qa.norelian.com' };
    const all = [svc('app-api', port)];
    const classification = classifyRemote(all, [], { envName: 'qa', env }, { 'app-api': 'app-api' });

    startRemoteServices({
      mgr, classification, proxies: track(), colorIdxStart: 0, onLog: () => {},
    });

    const st = mgr.state.get('app-api');
    assert.ok(st, 'no state entry');
    assert.equal(st!.status, 'running');
    // `wait`, not `up`: the first probe has not answered. Claiming an
    // environment is reachable before asking is how a stack reports itself
    // healthy while every request 502s.
    assert.equal(st!.health, 'wait');
    assert.equal(st!.pid, null);
    assert.equal(st!.proc, null);
    assert.equal(st!.remote?.envName, 'qa');
    assert.equal(st!.remote?.target, 'https://app-api.qa.norelian.com');
    assert.equal(st!.remote?.readOnly, false);

    // The port is held, which is the whole point — nothing else in the stack
    // has to know the service is not local.
    await assert.rejects(
      () => new Promise<void>((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(port, '0.0.0.0', () => s.close(() => resolve()));
      }),
      /EADDRINUSE/,
    );
  });

  it('releases the port when the service is removed, before announcing it', { timeout: 10000 }, async () => {
    const port = await findFreePort();
    const localProxies = track();
    const announced: string[] = [];
    const mgr = new ProcessManager({
      baseCwd: process.cwd(), env: {}, platform: detectPlatform(),
      events: {
        onLog: () => {}, onStateChange: () => {},
        onServiceRemoved: name => {
          // Asserted from inside the announcement: by the time a client is
          // told the service is gone, nothing may still be answering for it.
          const proxy = localProxies.get(name);
          proxy?.destroy();
          localProxies.delete(name);
          announced.push(name);
        },
      },
    });
    const env: EnvironmentConfig = { domain: 'qa.norelian.com' };
    const classification = classifyRemote([svc('app-api', port)], [], { envName: 'qa', env }, { 'app-api': 'app-api' });
    startRemoteServices({ mgr, classification, proxies: localProxies, colorIdxStart: 0, onLog: () => {} });

    mgr.remove('app-api');
    assert.deepEqual(announced, ['app-api']);
    assert.equal(mgr.state.has('app-api'), false);

    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(port, '0.0.0.0', () => s.close(() => resolve()));
    });
  });

  it('names the services it could not resolve, and warns that writes land upstream', { timeout: 10000 }, async () => {
    const port = await findFreePort();
    const mgr = makeManager();
    const env: EnvironmentConfig = { domain: 'qa.norelian.com' };
    const all = [svc('app-api', port), svc('rules-api', await findFreePort())];
    const classification = classifyRemote(all, [], { envName: 'qa', env }, { 'app-api': 'app-api' });

    const lines: string[] = [];
    startRemoteServices({
      mgr, classification, proxies: track(), colorIdxStart: 0,
      onLog: (_svc, msg) => lines.push(msg),
    });

    assert.ok(lines.some(l => /no remote target for: rules-api/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => /writes reach qa for: app-api/.test(l)), lines.join('\n'));
  });

  it('stays quiet about writes when the environment is read-only', { timeout: 10000 }, async () => {
    const port = await findFreePort();
    const mgr = makeManager();
    const env: EnvironmentConfig = { domain: 'qa.norelian.com', readOnly: true };
    const classification = classifyRemote([svc('app-api', port)], [], { envName: 'qa', env }, { 'app-api': 'app-api' });

    const lines: string[] = [];
    startRemoteServices({ mgr, classification, proxies: track(), colorIdxStart: 0, onLog: (_s, m) => lines.push(m) });

    assert.ok(!lines.some(l => /writes reach/.test(l)), lines.join('\n'));
    assert.equal(mgr.state.get('app-api')!.remote?.readOnly, true);
  });
});
