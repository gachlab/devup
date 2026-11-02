import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager } from '../../../src/process/manager.js';
import { registerLazy } from '../../../src/process/boot.js';
import { createLazyProxy, type LazyProxy } from '../../../src/lazy/proxy.js';
import { rewriteServicePort } from '../../../src/lazy/classifier.js';
import { isRunning, waitForExit } from '../../../src/process/liveness.js';
import type { Platform } from '../../../src/platform/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}
/** A port whose lazy real port (port + 10000) is also free. */
async function lazyPort(): Promise<number> {
  for (;;) {
    const p = await findFreePort();
    if (p + 10000 > 65535) continue;
    const free = await new Promise<boolean>(r => {
      const s = net.createServer().once('error', () => r(false)).listen(p + 10000, () => s.close(() => r(true)));
    });
    if (free) return p;
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await sleep(25); }
}

const platform: Platform = {
  getProcessStats: async () => new Map(),
  killTree: (pid, signal = 'SIGTERM') => { try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } } },
  openBrowser: () => {},
  defaultTraefikHost: '127.0.0.1',
};

const managers: ProcessManager[] = [];
const proxies: LazyProxy[] = [];
after(async () => {
  proxies.forEach(p => p.destroy());
  for (const m of managers) await m.cleanup({ gracePeriodMs: 200 }).catch(() => {});
});

function mk() {
  const statuses: string[] = [];
  const mgr = new ProcessManager({
    baseCwd: process.cwd(), env: { ...process.env as Record<string, string> }, platform,
    events: { onLog: () => {}, onStateChange: (_n, st) => statuses.push(st.status) },
  });
  managers.push(mgr);
  return { mgr, statuses };
}

/** Listens on PORT_OVERRIDE (what rewriteServicePort sets), appends its pid to
 *  `pids`, and on SIGTERM keeps the port for `drainMs` before exiting — a
 *  service that drains gracefully. */
function server(pids: string, drainMs = 0, extra = ''): string {
  return `${extra}require('fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');` +
    `const s = require('net').createServer(c => { c.on('error', () => {}); c.end('ok'); }).listen(+process.env.PORT_OVERRIDE);` +
    `process.on('SIGTERM', () => setTimeout(() => process.exit(0), ${drainMs}));`;
}
const svcOf = (name: string, port: number, script: string, type: 'api' | 'web' = 'api'): ServiceConfig =>
  ({ name, cwd: '.', cmd: process.execPath, args: ['-e', script], type, port, phase: 0 });
const pidsIn = (f: string) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];

describe('lazy wake and idle', { skip: !isUnix }, () => {
  it('waking while the idle-stop still drains waits for it, instead of recording a crash', { timeout: 20000 }, async () => {
    // onIdleStop used to null `proc`, so the next wake could not see the
    // draining process: an API read "port in use" and was marked crashed.
    const dir = mkdtempSync(join(tmpdir(), 'devup-lazy-'));
    const pids = join(dir, 'pids');
    const port = await lazyPort();
    const { mgr, statuses } = mk();
    const lazy = new Map<string, LazyProxy>();
    registerLazy(mgr, svcOf('drainer', port, server(pids, 1000)), 0, 0.02, lazy);
    const proxy = lazy.get('drainer')!; proxies.push(proxy);

    assert.equal(await proxy.ensureStarted(), true);
    const first = mgr.state.get('drainer')!;
    await until(() => first.status === 'idle', 5000);
    assert.ok(isRunning(first), 'still draining when the wake arrives');

    assert.equal(await proxy.ensureStarted(), true);
    const st = mgr.state.get('drainer')!;
    assert.equal(st.status, 'running');
    assert.equal(st.crashes ?? 0, 0, 'recorded a crash while the old process drained');
    assert.equal(pidsIn(pids).length, 2);
    // And announced: a status.follow client sees the wake, not `starting` for good.
    assert.equal(statuses.at(-1), 'running');
  });

  it('a wake does not spawn a second copy of a service that is already running', { timeout: 20000 }, async () => {
    // A web has no port guard: a cold `ng serve` that outlived the 45 s wait
    // was started again by the next request.
    const dir = mkdtempSync(join(tmpdir(), 'devup-lazy-'));
    const pids = join(dir, 'pids');
    const port = await lazyPort();
    const { mgr } = mk();
    const lazy = new Map<string, LazyProxy>();
    const svc = svcOf('webby', port, server(pids), 'web');
    registerLazy(mgr, svc, 0, 10, lazy);
    const proxy = lazy.get('webby')!; proxies.push(proxy);

    await mgr.start(rewriteServicePort(svc), 0);
    await until(() => pidsIn(pids).length === 1, 5000);
    assert.equal(await proxy.ensureStarted(), true);
    await sleep(300);
    assert.equal(pidsIn(pids).length, 1, 'spawned a second process');
  });

  it('a wake replaces a queued auto-restart instead of racing it', { timeout: 20000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-lazy-'));
    const pids = join(dir, 'pids');
    const marker = join(dir, 'crashed-once');
    const port = await lazyPort();
    const { mgr } = mk();
    const lazy = new Map<string, LazyProxy>();
    // Crashes on its first run, serves on every later one.
    const crashFirst = `if (!require('fs').existsSync(${JSON.stringify(marker)})) { require('fs').writeFileSync(${JSON.stringify(marker)}, ''); require('fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n'); process.exit(1); }`;
    const svc = svcOf('crashy', port, server(pids, 0, crashFirst));
    registerLazy(mgr, svc, 0, 10, lazy);
    const proxy = lazy.get('crashy')!; proxies.push(proxy);

    await mgr.start(rewriteServicePort(svc), 0);
    await until(() => mgr.state.get('crashy')?.restartPendingUntil != null, 5000);
    assert.equal(await proxy.ensureStarted(), true);
    // The first backoff is 2 s: past it, a racing restart would have run.
    await sleep(2600);
    assert.equal(pidsIn(pids).length, 2, 'the queued restart spawned a second process');
    assert.equal(mgr.state.get('crashy')!.restartPendingUntil ?? null, null);
  });
});

describe('lazy proxy internals', () => {
  it('the idle check does not stop a service while a start is in flight', { timeout: 5000 }, async () => {
    const listenPort = await findFreePort();
    let idleStops = 0;
    let slow = false;
    let alive = true;
    const proxy = createLazyProxy({
      listenPort, targetPort: 1, timeoutMin: 0.002,
      onDemandStart: async () => { if (slow) await sleep(500); return true; },
      onIdleStop: () => { idleStops++; },
      isAlive: () => alive,
    });
    proxies.push(proxy);
    await proxy.ensureStarted(); // arms the 120 ms idle timer
    // Stopped from outside and woken again with a start slower than the timeout.
    alive = false; slow = true;
    await proxy.ensureStarted();
    assert.equal(idleStops, 0, 'idle-stopped mid-start');
  });

  it('destroy() closes the target side of a relayed connection too', { timeout: 5000 }, async () => {
    const targetPort = await findFreePort();
    let targetClosed = false;
    const target = net.createServer(c => { c.on('close', () => { targetClosed = true; }); }).listen(targetPort);
    try {
      const listenPort = await findFreePort();
      const proxy = createLazyProxy({
        listenPort, targetPort, timeoutMin: 0,
        onDemandStart: async () => true, onIdleStop: () => {}, isAlive: () => true,
      });
      await proxy.ensureStarted();
      const client = net.connect(listenPort, '127.0.0.1');
      client.on('error', () => {});
      await sleep(150);
      proxy.destroy();
      await until(() => targetClosed, 2000);
      client.destroy();
    } finally {
      target.close();
    }
  });
});

describe('startup timers', { skip: !isUnix }, () => {
  it('a draining process does not clear the startup timeout of the one that replaced it', { timeout: 15000 }, async () => {
    const { mgr } = mk();
    // Never listens; lingers 600 ms on SIGTERM.
    const svc: ServiceConfig = {
      ...svcOf('slowpoke', 1, `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 600)); setInterval(() => {}, 1000);`, 'web'),
      healthCheck: { type: 'tcp', startupTimeoutMs: 1500 },
    };
    await mgr.start(svc, 0);
    const old = mgr.state.get('slowpoke')!;
    mgr.stop('slowpoke');
    await mgr.start(svc, 0);
    const fresh = mgr.state.get('slowpoke')!;
    assert.notEqual(fresh, old);
    await waitForExit(old, 3000);
    await until(() => fresh.status === 'timeout', 4000);
  });
});
