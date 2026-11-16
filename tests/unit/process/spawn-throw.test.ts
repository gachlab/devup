import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ProcessManager } from '../../../src/process/manager.js';
import { Restarter } from '../../../src/process/restarter.js';
import { BACKOFF_BASE_MS } from '../../../src/process/internals.js';
import { runDetached, type DetachedOpts } from '../../../src/orchestrator/daemon.js';
import type { Platform } from '../../../src/platform/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';
import type { ProcessState, ProcessManagerEvents } from '../../../src/process/types.js';

// #156, the review of #157: Node throws any spawn errno outside
// EACCES/EAGAIN/EMFILE/ENFILE/ENOENT synchronously out of `spawn()`, before a
// single listener exists. Every spawn devup owns has to survive that.

const realSpawn = childProcess.spawn;

function ebadf(): Error {
  return Object.assign(new Error('spawn EBADF'), { code: 'EBADF', errno: -9, syscall: 'spawn' });
}

/** Replace `child_process.spawn` for the src modules' named imports too. */
function stubSpawn(impl: (...args: Parameters<typeof realSpawn>) => ReturnType<typeof realSpawn>): void {
  mock.method(childProcess, 'spawn', impl);
  syncBuiltinESMExports();
}

afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });

function fakePlatform(): Platform {
  return {
    getProcessStats: async () => new Map(),
    killTree: (pid: number) => { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } },
    openBrowser: () => {},
    defaultTraefikHost: '127.0.0.1',
  };
}

function mkManager() {
  const logs: string[] = [];
  const mgr = new ProcessManager({
    baseCwd: process.cwd(),
    env: { ...process.env as Record<string, string> },
    platform: fakePlatform(),
    events: { onLog: (_n, text) => logs.push(text), onStateChange: () => {}, onServiceRemoved: () => {} },
  });
  return { mgr, logs };
}

function mkSvc(over: Partial<ServiceConfig>): ServiceConfig {
  const base: ServiceConfig = {
    name: 'ebadf-svc', cwd: '.', cmd: 'node', args: ['-e', 'setTimeout(()=>{},30000)'],
    type: 'api', port: 19871, phase: 0,
  };
  return Object.assign(base, over);
}

describe('Spawner when spawn() throws', () => {
  it('the service ends up crashed with the reason, and start resolves', async () => {
    stubSpawn(() => { throw ebadf(); });
    const { mgr, logs } = mkManager();
    await mgr.start(mkSvc({}), 0);
    const st = mgr.state.get('ebadf-svc');
    assert.equal(st?.status, 'crashed');
    assert.deepEqual(st?.crashLog, ['spawn EBADF']);
    assert.ok(logs.some(l => l.includes('failed to start: spawn EBADF')), logs.join('\n'));
  });

  it('a preBuild whose spawn throws is a failed build, not a rejected start', async () => {
    let calls = 0;
    stubSpawn(() => { calls++; throw ebadf(); });
    const { mgr, logs } = mkManager();
    await mgr.start(mkSvc({ preBuild: 'true' }), 0);
    assert.equal(calls, 1, 'the service itself must not be spawned after a failed build');
    assert.ok(logs.some(l => l.includes('[build] ❌ spawn EBADF')), logs.join('\n'));
  });

  it('a watchBuild whose spawn throws is logged and the service keeps running', async () => {
    stubSpawn((cmd, args, opts) => {
      if ((args as string[]).some(a => a.includes('WATCH-MARK'))) throw ebadf();
      return realSpawn(cmd, args as string[], opts!);
    });
    const { mgr, logs } = mkManager();
    try {
      await mgr.start(mkSvc({ watchBuild: 'echo WATCH-MARK' }), 0);
      const st = mgr.state.get('ebadf-svc');
      assert.equal(st?.status, 'starting');
      assert.equal(st?.watchProc, null);
      assert.ok(logs.some(l => l.includes('[watch] ❌ spawn EBADF')), logs.join('\n'));
    } finally {
      await mgr.cleanup();
    }
  });
});

describe('Restarter when the restart itself fails', () => {
  it('a rejected spawner.start never becomes an unhandledRejection', { timeout: BACKOFF_BASE_MS + 3000 }, async () => {
    const svc = mkSvc({});
    const state: ProcessState = {
      svc, proc: null, pid: null, status: 'crashed', health: 'down',
      errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 0, crashLog: null,
    };
    const logs: string[] = [];
    const events: ProcessManagerEvents = { onLog: (_n, t) => logs.push(t), onStateChange: () => {} };
    let attempted = false;
    const restarter = new Restarter({
      state: new Map([[svc.name, state]]), events,
      spawner: { start: async () => { attempted = true; throw ebadf(); } } as never,
      lifecycle: { stop: () => {} } as never,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => { unhandled.push(r); };
    process.on('unhandledRejection', onUnhandled);
    try {
      restarter.scheduleAutoRestart(svc, state, 0);
      await new Promise(r => setTimeout(r, BACKOFF_BASE_MS + 200));
      assert.ok(attempted, 'the restart never ran');
      assert.deepEqual(unhandled, []);
      assert.ok(logs.some(l => l.includes('auto-restart failed: spawn EBADF')), logs.join('\n'));
    } finally {
      process.off('unhandledRejection', onUnhandled);
      restarter.cancelAll();
    }
  });
});

describe('devup up -d when the daemon child cannot be spawned', () => {
  const opts = (out: string[]): DetachedOpts => ({
    config: { name: 'ebadf-detach-test' } as DetachedOpts['config'],
    services: [], cliArgs: {} as DetachedOpts['cliArgs'], platform: fakePlatform(),
    env: {}, baseCwd: process.cwd(), proxyProvider: null, proxyOpts: null,
    instanceName: `ebadf-detach-test-${process.pid}`,
    out: l => out.push(l), childArgs: [],
  });
  const skip = process.platform === 'win32' ? 'daemon mode is POSIX-only' : false;

  it('a synchronous throw exits 1 with the reason', { skip }, async () => {
    stubSpawn(() => { throw ebadf(); });
    const out: string[] = [];
    assert.equal(await runDetached(opts(out)), 1);
    assert.ok(out.some(l => l.includes('could not start the daemon: spawn EBADF')), out.join('\n'));
  });

  it('a deferred error event exits 1 instead of crashing the parent', { skip, timeout: 5000 }, async () => {
    const fake = Object.assign(new EventEmitter(), { unref: () => {}, pid: undefined });
    stubSpawn(() => {
      setImmediate(() => fake.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })));
      return fake as never;
    });
    const out: string[] = [];
    assert.equal(await runDetached(opts(out)), 1);
    assert.ok(out.some(l => l.includes('could not start the daemon: spawn node ENOENT')), out.join('\n'));
  });
});
