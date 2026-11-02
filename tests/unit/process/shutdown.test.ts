import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessManager } from '../../../src/process/manager.js';
import type { Platform } from '../../../src/platform/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';
import { isRunning, waitForExit } from '../../../src/process/liveness.js';

function testPlatform(): Platform {
  return {
    getProcessStats: async () => new Map(),
    killTree: (pid: number, signal: NodeJS.Signals = 'SIGTERM') => {
      try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
    },
    openBrowser: () => {},
    defaultTraefikHost: '127.0.0.1',
  };
}

// `web` so the spawner skips the port guard: these tests are about spawning,
// not ports, and must not collide with each other.
function svc(name: string, script: string): ServiceConfig {
  return { name, cwd: '.', cmd: process.execPath, args: ['-e', script], type: 'web', port: 1, phase: 0 };
}

const managers: ProcessManager[] = [];
function mk() {
  const logs: string[] = [];
  const mgr = new ProcessManager({
    baseCwd: process.cwd(),
    env: { ...process.env as Record<string, string> },
    platform: testPlatform(),
    events: { onLog: (_n, t) => logs.push(t), onStateChange: () => {} },
  });
  managers.push(mgr);
  return { mgr, logs };
}
after(async () => { for (const m of managers) await m.cleanup({ gracePeriodMs: 200 }).catch(() => {}); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

describe('a spawn that fails', () => {
  it('a missing cmd ends up crashed with the error, without killing the process or retrying', { timeout: 10000 }, async () => {
    // Without an 'error' listener this was an uncaught exception: this test
    // would never reach the next line.
    const { mgr, logs } = mk();
    await mgr.start({ ...svc('ghost', ''), cmd: 'devup-definitely-not-a-command' }, 0);
    await until(() => mgr.state.get('ghost')?.status === 'crashed');
    const st = mgr.state.get('ghost')!;
    assert.match(st.crashLog?.[0] ?? '', /ENOENT/);
    assert.equal(st.restartPendingUntil ?? null, null, 'a missing binary does not appear in 2 s');
    assert.ok(logs.some(l => l.includes('failed to start')), logs.join('\n'));
  });
});

describe('stop and shutdown against a queued restart', () => {
  it('stop() cancels the auto-restart of a crashed service', { timeout: 10000 }, async () => {
    const { mgr } = mk();
    await mgr.start(svc('flaky', 'process.exit(1)'), 0);
    await until(() => mgr.state.get('flaky')?.restartPendingUntil != null);
    const crashed = mgr.state.get('flaky')!;

    mgr.stop('flaky');
    // The first backoff is 2 s.
    await sleep(2600);
    assert.equal(mgr.state.get('flaky'), crashed, 'it came back after `stop`');
    assert.equal(crashed.restartPendingUntil, null);
  });

  it('cleanup() cancels queued restarts: nothing starts during the grace period', { timeout: 10000 }, async () => {
    const { mgr } = mk();
    await mgr.start(svc('flaky2', 'process.exit(1)'), 0);
    await until(() => mgr.state.get('flaky2')?.restartPendingUntil != null);
    const crashed = mgr.state.get('flaky2')!;

    await mgr.cleanup({ gracePeriodMs: 100 });
    // Cancelled, not just blocked when it fires: a client showing the
    // countdown has to hear about it now.
    assert.equal(crashed.restartPendingUntil, null);
    await sleep(2600);
    assert.equal(mgr.state.get('flaky2'), crashed, 'a new child would have outlived devup');
  });

  it('nothing spawns after cleanup(), even a start that arrives late', { timeout: 10000 }, async () => {
    const { mgr, logs } = mk();
    await mgr.cleanup({ gracePeriodMs: 100 });
    await mgr.start(svc('late', 'setInterval(() => {}, 1000)'), 0);
    assert.equal(mgr.state.get('late'), undefined);
    // Said, not silent: whoever awaited this start will wait for a port that
    // never opens, and the log is the only thing that explains why.
    assert.ok(logs.some(l => l.includes('start skipped — shutting down')), logs.join('\n'));
  });
});

describe('state after an intentional stop', () => {
  it('becomes stopped/down when the process exits', { timeout: 10000 }, async () => {
    const { mgr } = mk();
    await mgr.start(svc('calm', 'setInterval(() => {}, 1000)'), 0);
    const st = mgr.state.get('calm')!;
    assert.ok(isRunning(st));
    mgr.stop('calm');
    assert.equal(await waitForExit(st, 5000), true);
    await until(() => st.status === 'stopped');
    assert.equal(st.health, 'down');
  });

  it('does not overwrite the new state of a restart', { timeout: 15000 }, async () => {
    const { mgr } = mk();
    await mgr.start(svc('again', 'setInterval(() => {}, 1000)'), 0);
    const old = mgr.state.get('again')!;
    await mgr.restart('again');
    const fresh = mgr.state.get('again')!;
    assert.notEqual(fresh, old);
    await waitForExit(old, 5000);
    await sleep(100);
    assert.notEqual(fresh.status, 'stopped');
  });
});
