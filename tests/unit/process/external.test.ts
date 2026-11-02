import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startExternals, stopExternals } from '../../../src/process/external.js';
import { LinuxPlatform } from '../../../src/platform/linux.js';
import type { ExternalService } from '../../../src/config/types.js';

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

describe('external services', { skip: !isUnix }, () => {
  it('starts an external with no healthCheck and returns allHealthy', async () => {
    const ext: ExternalService = { name: 'noop', cmd: 'sleep 5' };
    const logs: string[] = [];
    const result = await startExternals([ext], {
      baseCwd: process.cwd(),
      env: { ...process.env as Record<string, string> },
      platform: new LinuxPlatform(),
      onLog: (svc, msg) => logs.push(`${svc}:${msg}`),
    });
    assert.equal(result.allHealthy, true);
    assert.equal(result.failed.length, 0);
    assert.ok(logs.some(l => l.startsWith('noop:🚀')));
    await stopExternals(result.procs, new LinuxPlatform(), { baseCwd: process.cwd(), env: {} });
  });

  it('waits for tcp healthCheck and reports healthy', async () => {
    const port = await findFreePort();
    // Spawn a TCP server via sh so the external sees it as its own subprocess
    const ext: ExternalService = {
      name: 'tcp-svc',
      cmd: `node -e "require('net').createServer(s=>s.end()).listen(${port})"`,
      port,
      healthCheck: { type: 'tcp' },
      startTimeout: 5,
    };
    const result = await startExternals([ext], {
      baseCwd: process.cwd(),
      env: { ...process.env as Record<string, string> },
      platform: new LinuxPlatform(),
    });
    assert.equal(result.allHealthy, true, `failed: ${result.failed.join(',')}`);
    await stopExternals(result.procs, new LinuxPlatform(), { baseCwd: process.cwd(), env: {} });
    await new Promise(r => setTimeout(r, 300));
  });

  it('reports failed when healthCheck never passes', async () => {
    const port = await findFreePort();
    const ext: ExternalService = {
      name: 'never-listens',
      cmd: 'sleep 5',  // doesn't open the port
      port,
      healthCheck: { type: 'tcp' },
      startTimeout: 2,
    };
    const result = await startExternals([ext], {
      baseCwd: process.cwd(),
      env: { ...process.env as Record<string, string> },
      platform: new LinuxPlatform(),
    });
    assert.equal(result.allHealthy, false);
    assert.deepEqual(result.failed, ['never-listens']);
    await stopExternals(result.procs, new LinuxPlatform(), { baseCwd: process.cwd(), env: {} });
  });

  it('stopExternals runs stopCmd if configured', async () => {
    // Create a marker file via the stopCmd. We just check the file appears.
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'devup-ext-'));
    const marker = join(dir, 'stopped.txt');

    const ext: ExternalService = {
      name: 'with-stop',
      cmd: 'sleep 5',
      stopCmd: `touch '${marker}'`,
    };
    const result = await startExternals([ext], {
      baseCwd: dir,
      env: { ...process.env as Record<string, string> },
      platform: new LinuxPlatform(),
    });
    await stopExternals(result.procs, new LinuxPlatform(), { baseCwd: dir, env: {} });
    assert.ok(existsSync(marker), 'stopCmd should have created the marker');
    (await import('node:fs')).rmSync(dir, { recursive: true });
  });
});

describe('startExternals: into and signal', { skip: !isUnix }, () => {
  it('publishes each external to `into` when spawned, not when its wait ends', async () => {
    // A teardown during the health wait has to find it.
    const port = await findFreePort();
    const into: import('../../../src/process/external.js').ExternalProc[] = [];
    const abort = new AbortController();
    const run = startExternals([{ name: 'slow', cmd: 'sleep 5', port, healthCheck: { type: 'tcp' }, startTimeout: 10 }], {
      baseCwd: process.cwd(), env: { ...process.env as Record<string, string> },
      platform: new LinuxPlatform(), into, signal: abort.signal,
    });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(into.length, 1, 'still waiting, and already in the list');
    abort.abort();
    const result = await run;
    assert.equal(result.procs, into);
    await stopExternals(into, new LinuxPlatform(), { baseCwd: process.cwd(), env: {} });
  });

  it('an aborted signal ends the wait and spawns nothing more', async () => {
    const port = await findFreePort();
    const abort = new AbortController();
    const t0 = Date.now();
    const run = startExternals([
      { name: 'a', cmd: 'sleep 5', port, healthCheck: { type: 'tcp' }, startTimeout: 30 },
      { name: 'b', cmd: 'sleep 5' },
    ], {
      baseCwd: process.cwd(), env: { ...process.env as Record<string, string> },
      platform: new LinuxPlatform(), signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 300);
    const result = await run;
    assert.ok(Date.now() - t0 < 5000, 'kept waiting the full 30 s');
    assert.deepEqual(result.procs.map(p => p.svc.name), ['a']);
    await stopExternals(result.procs, new LinuxPlatform(), { baseCwd: process.cwd(), env: {} });
  });
});

describe('external output', { skip: !isUnix }, () => {
  it('is logged line by line, not chunk by chunk', async () => {
    const logs: string[] = [];
    const result = await startExternals([{ name: 'chatty', cmd: "printf 'one\\ntwo\\n'" }], {
      baseCwd: process.cwd(), env: { ...process.env as Record<string, string> },
      platform: new LinuxPlatform(), onLog: (_svc, msg) => logs.push(msg),
    });
    const end = Date.now() + 10000;
    while (!(logs.includes('one') && logs.includes('two')) && Date.now() < end) await new Promise(r => setTimeout(r, 50));
    assert.ok(logs.includes('one') && logs.includes('two'), logs.join(' | '));
    await stopExternals(result.procs, new LinuxPlatform(), { baseCwd: process.cwd(), env: {} });
  });
});
