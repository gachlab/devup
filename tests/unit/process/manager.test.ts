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
  const removed: string[] = [];
  const p = platform ?? testPlatform();
  const mgr = new ProcessManager({
    baseCwd: process.cwd(),
    env: { ...process.env as Record<string, string> },
    platform: p,
    events: {
      onLog: (_name, text) => logs.push(text),
      onStateChange: () => {},
      onServiceRemoved: (name) => removed.push(name),
    },
  });
  return { mgr, logs, removed, platform: p };
}

describe('ProcessManager.remove', () => {
  it('drops the service from the state map and announces it', { timeout: 3000 }, async () => {
    const { mgr, removed } = makeManager();
    await mgr.start(makeSvc(), 0);
    assert.ok(mgr.state.has('test-svc'));

    mgr.remove('test-svc');

    assert.equal(mgr.state.has('test-svc'), false);
    // Deleting from `state` alone leaves every control-plane client showing a
    // service that no longer exists, so the event is the point of the method.
    assert.deepEqual(removed, ['test-svc']);
    await new Promise(r => setTimeout(r, 100));
  });

  it('is a no-op for a service it does not have', () => {
    const { mgr, removed } = makeManager();
    mgr.remove('never-existed');
    assert.deepEqual(removed, []);
  });

  it('does not announce anything on a plain stop', { timeout: 3000 }, async () => {
    // stop means idle, remove means gone — clients treat them differently.
    const { mgr, removed } = makeManager();
    await mgr.start(makeSvc(), 0);
    mgr.stop('test-svc');
    assert.deepEqual(removed, []);
    assert.ok(mgr.state.has('test-svc'));
    await new Promise(r => setTimeout(r, 100));
  });
});

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

  // Shell-dependent tests skipped on Windows: cmd.exe handles quoting differently
  // than sh, and there's no portable `sleep` equivalent without per-platform tricks.
  // The non-test code path uses sh -c / cmd /c so the feature itself works on both.
  const skipOnWindows = process.platform === 'win32';

  describe('preBuild', { skip: skipOnWindows }, () => {
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

  describe('watchBuild', { skip: skipOnWindows }, () => {
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

  it('errorPattern: only matching stderr lines bump state.errors', { timeout: 3000 }, async () => {
    const { mgr } = makeManager();
    const svc = makeSvc({
      name: 'err-filter', port: 19886,
      cmd: 'node',
      args: ['-e', "process.stderr.write('warning: foo\\nerror: real\\ninfo: other\\n'); setTimeout(()=>{}, 30000)"],
      errorPattern: '^error:',
    });
    await mgr.start(svc, 0);
    await new Promise(r => setTimeout(r, 500));
    const st = mgr.state.get('err-filter')!;
    assert.equal(st.errors, 1, `expected 1 error matching /^error:/, got ${st.errors}`);
    mgr.stop('err-filter');
    await new Promise(r => setTimeout(r, 100));
  });

  it('without errorPattern every stderr line counts (backwards compat)', { timeout: 3000 }, async () => {
    const { mgr } = makeManager();
    const svc = makeSvc({
      name: 'err-default', port: 19887,
      cmd: 'node',
      args: ['-e', "process.stderr.write('warning: foo\\nerror: real\\ninfo: other\\n'); setTimeout(()=>{}, 30000)"],
    });
    await mgr.start(svc, 0);
    await new Promise(r => setTimeout(r, 500));
    const st = mgr.state.get('err-default')!;
    assert.equal(st.errors, 3, `expected 3 errors without pattern, got ${st.errors}`);
    mgr.stop('err-default');
    await new Promise(r => setTimeout(r, 100));
  });

  it('healthCheck.startPeriod suppresses probes during the grace window', { timeout: 4000 }, async () => {
    const { mgr } = makeManager();
    const svc = makeSvc({
      name: 'graceful', port: 19885,
      args: ['-e', 'setTimeout(()=>{}, 30000)'],
      healthCheck: { type: 'tcp', startPeriod: 3 }, // 3 s grace
    });
    await mgr.start(svc, 0);
    // First probe immediately — should be suppressed (status stays 'starting').
    await mgr.checkAllHealth();
    const st = mgr.state.get('graceful')!;
    assert.equal(st.status, 'starting');
    assert.equal(st.health, 'wait');
    mgr.stop('graceful');
    await new Promise(r => setTimeout(r, 100));
  });

  it('refuses to start a service whose --watch-path does not exist', { timeout: 3000 }, async () => {
    const { mgr, logs } = makeManager();
    const svc = makeSvc({
      name: 'broken-watch', port: 19884,
      args: ['--watch-path', 'this/does/not/exist', '-e', 'setTimeout(()=>{}, 30000)'],
    });
    await mgr.start(svc, 0);
    const st = mgr.state.get('broken-watch')!;
    assert.equal(st.status, 'crashed', 'service should be marked crashed before spawn');
    assert.equal(st.pid, null);
    assert.ok(logs.some(l => l.includes('missing watch paths') && l.includes('this/does/not/exist')));
  });
});
