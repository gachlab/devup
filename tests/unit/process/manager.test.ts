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

  it('readyPattern marks service up on stdout match', { timeout: 4000 }, async () => {
    const stateChanges: string[] = [];
    const p = testPlatform();
    const mgr = new ProcessManager({
      baseCwd: process.cwd(),
      env: { ...process.env as Record<string, string> },
      platform: p,
      events: {
        onLog: () => {},
        onStateChange: (_n, st) => stateChanges.push(`${st.status}:${st.health}`),
      },
    });
    const svc = makeSvc({
      name: 'ready-svc', port: 19879,
      cmd: 'node',
      args: ['-e', "console.log('listening on 19879'); setTimeout(()=>{}, 30000)"],
      readyPattern: 'listening on',
    });
    await mgr.start(svc, 0);
    // Wait for stdout to flow + line buffer to deliver
    await new Promise(r => setTimeout(r, 800));
    const st = mgr.state.get('ready-svc')!;
    assert.equal(st.health, 'up', `expected up, got ${st.health}; state changes: ${stateChanges.join(',')}`);
    assert.equal(st.status, 'running');
    mgr.stop('ready-svc');
    await new Promise(r => setTimeout(r, 100));
  });

  it('readyPattern: no match → state stays starting/wait', { timeout: 4000 }, async () => {
    const { mgr } = makeManager();
    const svc = makeSvc({
      name: 'noready', port: 19880,
      cmd: 'node',
      args: ['-e', "console.log('hello world'); setTimeout(()=>{}, 30000)"],
      readyPattern: 'this-never-matches',
    });
    await mgr.start(svc, 0);
    await new Promise(r => setTimeout(r, 500));
    const st = mgr.state.get('noready')!;
    assert.equal(st.health, 'wait');
    assert.equal(st.status, 'starting');
    mgr.stop('noready');
    await new Promise(r => setTimeout(r, 100));
  });

  describe('preBuild', () => {
    it('runs preBuild successfully then starts the service', { timeout: 5000 }, async () => {
      const { mgr, logs } = makeManager();
      const svc = makeSvc({
        name: 'pb-ok', port: 19881,
        preBuild: "echo 'build ran'",
        args: ['-e', 'setTimeout(()=>{}, 30000)'],
      });
      await mgr.start(svc, 0);
      const st = mgr.state.get('pb-ok')!;
      assert.equal(st.status, 'starting');
      assert.ok(st.pid, 'service was spawned after preBuild');
      assert.ok(logs.some(l => l.includes('🔨 preBuild')));
      assert.ok(logs.some(l => l.includes('[build] build ran')));
      assert.ok(logs.some(l => l.includes('[build] ✅ done')));
      mgr.stop('pb-ok');
      await new Promise(r => setTimeout(r, 100));
    });

    it('skips spawn and marks crashed when preBuild fails', { timeout: 5000 }, async () => {
      const { mgr, logs } = makeManager();
      const svc = makeSvc({
        name: 'pb-fail', port: 19882,
        preBuild: 'exit 1',
      });
      await mgr.start(svc, 0);
      const st = mgr.state.get('pb-fail')!;
      assert.equal(st.status, 'crashed');
      assert.equal(st.pid, null, 'service must not have been spawned');
      assert.ok(logs.some(l => l.includes('[build] ❌ exited with code 1')));
    });
  });

  describe('watchBuild', () => {
    it('spawns a side-car alongside the service and kills it on stop', { timeout: 5000 }, async () => {
      const { mgr, logs } = makeManager();
      const svc = makeSvc({
        name: 'wb', port: 19883,
        args: ['-e', 'setTimeout(()=>{}, 30000)'],
        watchBuild: 'sleep 30',
      });
      await mgr.start(svc, 0);
      const st = mgr.state.get('wb')!;
      assert.ok(st.watchProc, 'watchProc should be set');
      assert.ok(st.watchProc?.pid, 'watchProc should have a pid');
      const wpid = st.watchProc!.pid!;

      assert.ok(logs.some(l => l.includes('👀 watchBuild')));

      mgr.stop('wb');
      await new Promise(r => setTimeout(r, 200));
      assert.equal(mgr.state.get('wb')!.watchProc, null);
      // Best-effort: the watch process should no longer be running
      try { process.kill(wpid, 0); assert.fail('watchProc still alive'); } catch (e: any) {
        // ESRCH or EPERM both mean the pid is gone or not ours — both acceptable
        assert.ok(e.code === 'ESRCH' || e.code === 'EPERM', `expected ESRCH/EPERM, got ${e.code}`);
      }
    });
  });
});
