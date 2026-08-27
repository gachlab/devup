import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { runOnce } from '../../src/orchestrator/once.js';
import { detectPlatform } from '../../src/platform/detect.js';
import { parseCliArgs } from '../../src/config/cli.js';
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

describe('--once with --remote', { skip: isWin }, () => {
  const servers: http.Server[] = [];
  after(async () => {
    for (const s of servers) {
      s.closeAllConnections?.();
      await new Promise<void>(r => s.close(() => r()));
    }
  });

  async function upstream(): Promise<string> {
    const server = http.createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
    servers.push(server);
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const svc = (name: string, port: number): ServiceConfig => ({
    name, cwd: '.', cmd: 'node',
    args: ['-e', `require('http').createServer((q,r)=>r.end('x')).listen(${port})`],
    type: 'api', port, phase: 0,
  });

  async function run(config: DevStackConfig, remote: string, out: string[]) {
    return runOnce({
      config,
      services: config.services,
      cliArgs: { ...parseCliArgs([]), remote, onceTimeout: 20, onceJson: false },
      platform: await detectPlatform(),
      env: { PATH: process.env['PATH'] ?? '' },
      baseCwd: process.cwd(),
      logSink: null,
      out: l => out.push(l),
    });
  }

  it('reports a proxied service as ready and frees its port on the way out', { timeout: 40000 }, async () => {
    const remotePort = await findFreePort();
    const localPort = await findFreePort();
    const target = await upstream();
    const config: DevStackConfig = {
      name: 'test',
      services: [svc('remote-api', remotePort), svc('local-api', localPort)],
      environments: { qa: { targets: { 'remote-api': target } } },
    };

    const out: string[] = [];
    const code = await run(config, 'qa:remote-api', out);

    assert.equal(code, 0, out.join('\n'));
    assert.ok(out.some(l => /remote-api served from qa/.test(l)), out.join('\n'));
    // The whole point of supporting it here: a run that says the stack is up
    // must not be one where the proxied services were silently absent.
    assert.ok(out.some(l => /1 served from qa/.test(l)), out.join('\n'));
    // Served, and therefore not also considered for a local spawn. The
    // spawner's own port guard would skip it anyway — but it says so as
    // `port N already in use`, which reads as a conflict with something
    // else on the machine when the thing holding the port is devup's own
    // proxy. A run should not report a conflict it created itself.
    assert.ok(!out.some(l => /remote-api.*already in use/.test(l)), out.join('\n'));
    assert.ok(out.some(l => /^\[local-api\].*started/.test(l)), out.join('\n'));
    // And nothing outlives the run — a proxy still holding a port is also a
    // `--once` that never exits.
    assert.equal(await bindable(remotePort), true, `:${remotePort} is still held`);
    assert.equal(await bindable(localPort), true, `:${localPort} is still held`);
  });

  it('fails the run when the environment does not answer', { timeout: 40000 }, async () => {
    const remotePort = await findFreePort();
    const deadPort = await findFreePort();
    const config: DevStackConfig = {
      name: 'test',
      services: [svc('remote-api', remotePort)],
      environments: { qa: { targets: { 'remote-api': `http://127.0.0.1:${deadPort}` } } },
    };

    const out: string[] = [];
    const code = await run(config, 'qa:remote-api', out);

    // Reporting a stack healthy because a proxy bound, while the environment
    // behind it is unreachable, is how a CI failure gets blamed on the tests.
    assert.equal(code, 1, out.join('\n'));
    assert.ok(out.some(l => /did not answer/.test(l)), out.join('\n'));
    assert.equal(await bindable(remotePort), true, `:${remotePort} is still held`);
  });
});
