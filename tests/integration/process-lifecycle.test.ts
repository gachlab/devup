import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessManager } from '../../src/process/manager.js';
import { checkPort, waitForPort } from '../../src/process/health.js';
import { LinuxPlatform } from '../../src/platform/linux.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, '..', 'fixtures');

// Only run on Linux (uses LinuxPlatform directly)
const isLinux = process.platform === 'linux';

describe('process-lifecycle integration', { skip: !isLinux }, () => {
  it('starts a real server and detects health', async () => {
    const logs: string[] = [];
    const mgr = new ProcessManager({
      baseCwd: fixtures,
      env: { ...process.env as Record<string, string>, PATH: process.env['PATH'] ?? '' },
      platform: new LinuxPlatform(),
      events: {
        onLog: (_n, text) => logs.push(text),
        onStateChange: () => {},
      },
    });

    const port = 19850 + Math.floor(Math.random() * 100);
    const svc = {
      name: 'dummy', cwd: '.', cmd: 'node',
      args: ['--import', 'tsx', 'dummy-server.ts', String(port)],
      type: 'api' as const, port, phase: 0,
    };

    await mgr.start(svc, 0);
    const st = mgr.state.get('dummy')!;
    assert.equal(st.status, 'starting');

    // Wait for server to be ready
    const ok = await waitForPort(port, { timeout: 5000, interval: 200 });
    assert.equal(ok, true, 'server should be listening');

    // Health check
    await mgr.checkAllHealth();
    assert.equal(mgr.state.get('dummy')!.health, 'up');
    assert.equal(mgr.state.get('dummy')!.status, 'running');

    // Stop
    mgr.stop('dummy');
    await new Promise(r => setTimeout(r, 500));

    // Port should be free
    const stillUp = await checkPort(port);
    assert.equal(stillUp, false, 'port should be free after stop');
  });

  it('detects crash and increments restarts', async () => {
    const logs: string[] = [];
    const mgr = new ProcessManager({
      baseCwd: fixtures,
      env: { ...process.env as Record<string, string>, PATH: process.env['PATH'] ?? '' },
      platform: new LinuxPlatform(),
      events: {
        onLog: (_n, text) => logs.push(text),
        onStateChange: () => {},
      },
    });

    const svc = {
      name: 'crasher', cwd: '.', cmd: 'node',
      args: ['--import', 'tsx', 'dummy-crash.ts'],
      type: 'api' as const, port: 19849, phase: 0,
    };

    await mgr.start(svc, 0);
    // Wait for crash + first restart attempt
    await new Promise(r => setTimeout(r, 3000));

    const st = mgr.state.get('crasher')!;
    assert.ok(st.restarts >= 1, `expected restarts >= 1, got ${st.restarts}`);
    assert.ok(logs.some(l => l.includes('auto-restart')));

    // Cleanup
    mgr.stop('crasher');
    await new Promise(r => setTimeout(r, 200));
  });
});
