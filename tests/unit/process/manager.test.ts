import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ProcessManager } from '../../../src/process/manager.js';
import type { Platform } from '../../../src/platform/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

// Use a real killTree so spawned processes actually die
function testPlatform(): Platform {
  const killCalls: number[] = [];
  return {
    getProcessStats: async () => new Map(),
    killTree: (pid: number) => {
      killCalls.push(pid);
      try { process.kill(pid, 'SIGTERM'); } catch {}
    },
    openBrowser: () => {},
    defaultTraefikHost: '127.0.0.1',
    get _killCalls() { return killCalls; },
  } as Platform & { _killCalls: number[] };
}

// Short-lived process that exits on its own after 30s
function makeSvc(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: 'test-svc', cwd: '.', cmd: 'node',
    args: ['-e', 'setTimeout(()=>{},30000)'],
    type: 'api', port: 19876, phase: 0,
    ...overrides,
  };
}

function makeManager(platform?: Platform) {
  const logs: string[] = [];
  const p = platform ?? testPlatform();
  const mgr = new ProcessManager({
    baseCwd: process.cwd(),
    env: { ...process.env as Record<string, string> },
    platform: p,
    events: {
      onLog: (_name, text) => logs.push(text),
      onStateChange: () => {},
    },
  });
  return { mgr, logs, platform: p };
}

describe('ProcessManager', () => {
  it('start sets state to starting', { timeout: 3000 }, async () => {
    const { mgr } = makeManager();
    await mgr.start(makeSvc(), 0);
    const st = mgr.state.get('test-svc');
    assert.ok(st);
    assert.equal(st.status, 'starting');
    assert.ok(st.pid);
    mgr.stop('test-svc');
    await new Promise(r => setTimeout(r, 100));
  });

  it('stop kills the process', { timeout: 3000 }, async () => {
    const p = testPlatform();
    const { mgr } = makeManager(p);
    await mgr.start(makeSvc(), 0);
    const pid = mgr.state.get('test-svc')!.pid!;
    mgr.stop('test-svc');
    assert.ok((p as any)._killCalls.includes(pid));
    await new Promise(r => setTimeout(r, 100));
  });

  it('stop on nonexistent service is noop', () => {
    const { mgr } = makeManager();
    mgr.stop('nonexistent');
  });

  it('checkAllHealth updates health', { timeout: 3000 }, async () => {
    const { mgr } = makeManager();
    await mgr.start(makeSvc({ port: 19877 }), 0);
    await mgr.checkAllHealth();
    const st = mgr.state.get('test-svc')!;
    assert.ok(st.health === 'wait' || st.health === 'down');
    mgr.stop('test-svc');
    await new Promise(r => setTimeout(r, 100));
  });

  it('logs port occupied warning', { timeout: 3000 }, async () => {
    const server = net.createServer();
    await new Promise<void>(r => server.listen(19878, r));
    try {
      const { mgr, logs } = makeManager();
      await mgr.start(makeSvc({ port: 19878 }), 0);
      assert.ok(logs.some(l => l.includes('already in use')));
    } finally {
      server.close();
    }
  });
});
