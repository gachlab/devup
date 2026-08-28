import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { applyConfigChange, watchConfig } from '../../../src/orchestrator/config-watcher.js';
import type { ProcessManager } from '../../../src/process/manager.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';
import { rewriteServicePort } from '../../../src/lazy/classifier.js';

function mkSvc(name: string, port: number, over: Partial<ServiceConfig> = {}): ServiceConfig {
  return { name, cwd: '.', cmd: 'node', args: [], type: 'api', port, phase: 0, ...over };
}
function mkState(svc: ServiceConfig): ProcessState {
  return {
    svc, proc: null, pid: null, status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false, crashLog: null, colorIdx: 0,
  };
}

interface MockMgrCalls {
  installed: Array<{ name: string; ci: number }>;
  started: Array<{ name: string; ci: number; isRestart?: boolean; svc: ServiceConfig }>;
  stopped: string[];
  removed: string[];
}
function mockManager(initial: ServiceConfig[] = []): { mgr: ProcessManager; calls: MockMgrCalls } {
  const state = new Map<string, ProcessState>();
  for (const s of initial) state.set(s.name, mkState(s));
  const calls: MockMgrCalls = { installed: [], started: [], stopped: [], removed: [] };
  const mgr = {
    state,
    install: async (svc: ServiceConfig, ci: number) => { calls.installed.push({ name: svc.name, ci }); return true; },
    start: async (svc: ServiceConfig, ci: number, isRestart?: boolean) => {
      calls.started.push({ name: svc.name, ci, isRestart, svc });
      if (!state.has(svc.name)) state.set(svc.name, mkState(svc));
    },
    stop: (name: string) => { calls.stopped.push(name); },
    // Mirrors the real manager: stop, drop from state, and announce. The
    // announcement is what tells control-plane clients the service is gone
    // rather than merely idle.
    remove: (name: string) => { calls.stopped.push(name); calls.removed.push(name); state.delete(name); },
  } as unknown as ProcessManager;
  return { mgr, calls };
}

function writeConfig(path: string, services: ServiceConfig[]): void {
  writeFileSync(path, JSON.stringify({ name: 'WatchTest', services }));
}

describe('applyConfigChange', () => {
  it('no-ops when config is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-cw-'));
    try {
      const svcs = [mkSvc('api', 3000)];
      const cfgPath = join(dir, 'devup.config.json');
      writeConfig(cfgPath, svcs);
      const { mgr, calls } = mockManager(svcs);
      const logs: string[] = [];

      await applyConfigChange({
        configPath: cfgPath, baseCwd: dir, manager: mgr, baseline: svcs,
        log: l => logs.push(l),
      });

      assert.equal(calls.installed.length, 0);
      assert.equal(calls.started.length, 0);
      assert.equal(calls.stopped.length, 0);
      assert.equal(logs.length, 0, `no log expected, got: ${logs.join(' | ')}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('starts added services and reports the diff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-cw-'));
    try {
      const before = [mkSvc('api', 3000)];
      const after = [mkSvc('api', 3000), mkSvc('web', 4200, { type: 'web' })];
      const cfgPath = join(dir, 'devup.config.json');
      writeConfig(cfgPath, after);
      const { mgr, calls } = mockManager(before);
      const logs: string[] = [];

      await applyConfigChange({ configPath: cfgPath, baseCwd: dir, manager: mgr, baseline: before, log: l => logs.push(l) });

      assert.deepEqual(calls.installed.map(c => c.name), ['web']);
      assert.deepEqual(calls.started.map(c => c.name), ['web']);
      assert.equal(calls.stopped.length, 0);
      assert.ok(logs.some(l => l.includes('reloaded') && l.includes('+1')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves an untouched lazy service alone across a reload', async () => {
    // The state carries the lazy rewrite (port + 10000, rewritten args and
    // env) and any `ctl debug` toggle; the file carries neither. Diffing state
    // against the file made every lazy service "changed" on every save — and
    // the changed path restarts them from the file config, onto the public
    // port their own proxy is holding. See #93.
    const dir = mkdtempSync(join(tmpdir(), 'devup-cw-'));
    try {
      const baseline = [mkSvc('auth', 3002), mkSvc('web', 4200)];
      const cfgPath = join(dir, 'devup.config.json');
      writeConfig(cfgPath, [mkSvc('auth', 3002), mkSvc('web', 4201)]); // only web moved
      const { mgr, calls } = mockManager(baseline);
      // As the orchestrator holds them: auth is lazy and debugged.
      const auth = mgr.state.get('auth')!;
      auth.svc = { ...auth.svc, port: 13002, debug: 9230, extraEnv: { PORT_OVERRIDE: '13002' } };

      await applyConfigChange({ configPath: cfgPath, baseCwd: dir, manager: mgr, baseline, log: () => {} });

      assert.deepEqual(calls.started.map(c => c.name), ['web'], 'an untouched lazy service was restarted');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps a runtime debug toggle across a reload', async () => {
    // `ctl debug` lives on the service, not in the file, so a reload that
    // rebuilt from the file alone would silently drop it — disconnecting an
    // attached debugger on the next unrelated save.
    const dir = mkdtempSync(join(tmpdir(), 'devup-cw-'));
    try {
      const before = [mkSvc('api', 3000)];
      const after = [mkSvc('api', 3001)]; // an unrelated edit
      const cfgPath = join(dir, 'devup.config.json');
      writeConfig(cfgPath, after);
      const { mgr, calls } = mockManager(before);
      mgr.state.get('api')!.svc = { ...mgr.state.get('api')!.svc, debug: 9230 };

      await applyConfigChange({ configPath: cfgPath, baseCwd: dir, manager: mgr, baseline: before, log: () => {} });

      const started = calls.started.find(c => c.name === 'api');
      assert.ok(started, 'api should have been restarted');
      // Asserted on what it was restarted *with*: the mock does not write back
      // into state, so reading state.svc afterwards would pass either way.
      assert.equal(started.svc.debug, 9230, 'the reload dropped the runtime toggle');
      assert.equal(started.svc.port, 3001, 'the file edit should still apply');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('stops removed services and removes them from state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-cw-'));
    try {
      const before = [mkSvc('api', 3000), mkSvc('legacy', 3100)];
      const after = [mkSvc('api', 3000)];
      const cfgPath = join(dir, 'devup.config.json');
      writeConfig(cfgPath, after);
      const { mgr, calls } = mockManager(before);
      const logs: string[] = [];

      await applyConfigChange({ configPath: cfgPath, baseCwd: dir, manager: mgr, baseline: before, log: l => logs.push(l) });

      assert.deepEqual(calls.stopped, ['legacy']);
      assert.deepEqual(calls.removed, ['legacy'], 'removal must go through remove(), not a bare state.delete');
      assert.equal(mgr.state.has('legacy'), false);
      assert.equal(mgr.state.has('api'), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('restarts changed services (stop → install → start with isRestart=true)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-cw-'));
    try {
      const before = [mkSvc('api', 3000)];
      const after = [mkSvc('api', 3001)]; // port changed
      const cfgPath = join(dir, 'devup.config.json');
      writeConfig(cfgPath, after);
      const { mgr, calls } = mockManager(before);
      const logs: string[] = [];

      await applyConfigChange({ configPath: cfgPath, baseCwd: dir, manager: mgr, baseline: before, log: l => logs.push(l) });

      assert.deepEqual(calls.stopped, ['api']);
      assert.deepEqual(calls.installed.map(c => c.name), ['api']);
      assert.deepEqual(calls.started.map(c => ({ n: c.name, r: c.isRestart })), [{ n: 'api', r: true }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves running set untouched and logs a warning when validation fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-cw-'));
    try {
      const cfgPath = join(dir, 'devup.config.json');
      // Invalid: empty services array
      writeFileSync(cfgPath, JSON.stringify({ name: 'WatchTest', services: [] }));
      const baseline = [mkSvc('api', 3000)];
      const { mgr, calls } = mockManager(baseline);
      const logs: string[] = [];

      await applyConfigChange({ configPath: cfgPath, baseCwd: dir, manager: mgr, baseline, log: l => logs.push(l) });

      assert.equal(calls.installed.length, 0);
      assert.equal(calls.started.length, 0);
      assert.equal(calls.stopped.length, 0);
      assert.ok(logs.some(l => l.includes('⚠ config reload failed')), `expected validation warning, got: ${logs.join(' | ')}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('watchConfig', () => {
  it('fires applyConfigChange on file save', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-cw-'));
    try {
      const before = [mkSvc('api', 3000)];
      const after = [mkSvc('api', 3000), mkSvc('web', 4200, { type: 'web' })];
      const cfgPath = join(dir, 'devup.config.json');
      writeConfig(cfgPath, before);
      const { mgr, calls } = mockManager(before);
      const logs: string[] = [];

      const stop = watchConfig({ configPath: cfgPath, baseCwd: dir, manager: mgr, baseline: before, log: l => logs.push(l) });
      try {
        // Give the polling watcher a moment to read the initial stat.
        await sleep(200);
        writeConfig(cfgPath, after);

        // Polling interval (500 ms) + debounce (250 ms) + reload ≈ ~1s.
        // Allow generous headroom for slow CI runners.
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline && calls.started.length === 0) {
          await sleep(100);
        }

        assert.ok(calls.started.length >= 1, `expected at least 1 reload, got ${calls.started.length}; logs: ${logs.join(' | ')}`);
        assert.equal(calls.started[0]!.name, 'web');
      } finally { stop(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('applyConfigChange with a lazy service', () => {
  it('does not spawn it on the public port its own proxy holds', async () => {
    // The failure this replaces: `start(fileSvc, ci, isRestart=true)` skips
    // the `isPortBindable` guard, so editing a lazy service's args spawned the
    // process on the configured port — the one its proxy is listening on. The
    // child died with EADDRINUSE, spent its restart budget and ended
    // `crashed`, and `state.svc` was left holding the un-rewritten config so
    // the snapshot reported a port that no longer matched the proxy's target.
    const dir = mkdtempSync(join(tmpdir(), 'devup-watch-lazy-'));
    const configPath = join(dir, 'devup.config.json');
    const base = { name: 'app-api', cwd: '.', cmd: 'node', args: ['a.js'], type: 'api', port: 3000, phase: 0 };
    writeFileSync(configPath, JSON.stringify({ name: 't', services: [{ ...base, args: ['b.js'] }] }));

    const started: Array<{ name: string; port: number; isRestart?: boolean }> = [];
    const state = new Map<string, ProcessState>();
    const manager = {
      state,
      install: async () => true,
      start: async (svc: ServiceConfig, _ci: number, isRestart?: boolean) => {
        started.push({ name: svc.name, port: svc.port, isRestart });
      },
      stop: () => {},
      cancelPendingRestart: () => {},
    } as unknown as import('../../../src/process/manager.js').ProcessManager;

    // As the orchestrator holds a lazy service: the rewrite already happened.
    const rewritten = rewriteServicePort(base as ServiceConfig);
    state.set('app-api', {
      svc: rewritten, proc: null, pid: null, status: 'idle', health: 'idle',
      errors: 0, restarts: 0, startedAt: null, intentionalStop: false,
      colorIdx: 0, crashLog: null,
    });

    let ensured = 0;
    const lazyProxies = new Map([['app-api', {
      destroy: () => {},
      ensureStarted: async () => { ensured++; return true; },
    }]]) as unknown as Map<string, import('../../../src/lazy/proxy.js').LazyProxy & { ensureStarted(): Promise<boolean> }>;

    try {
      await applyConfigChange({
        configPath, baseCwd: dir, manager, lazyProxies, lazyTimeout: 10,
        baseline: [base as ServiceConfig],
        log: () => {},
      });

      // Nothing spawned. The service was asleep, so `restartService` leaves it
      // asleep — the next request starts it with the new config, and the test
      // below is the one that proves that claim rather than assuming it.
      assert.equal(ensured, 0, 'it woke a service that was asleep');
      assert.deepEqual(started, [], 'it spawned around the proxy');
      // And the state keeps the rewritten port, so the snapshot still matches
      // what the proxy targets.
      assert.equal(state.get('app-api')!.svc.port, rewritten.realPort);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restarts a lazy service that is awake through its proxy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-watch-lazy2-'));
    const configPath = join(dir, 'devup.config.json');
    const base = { name: 'app-api', cwd: '.', cmd: 'node', args: ['a.js'], type: 'api', port: 3000, phase: 0 };
    writeFileSync(configPath, JSON.stringify({ name: 't', services: [{ ...base, args: ['b.js'] }] }));

    const started: string[] = [];
    const state = new Map<string, ProcessState>();
    const manager = {
      state,
      install: async () => true,
      start: async (svc: ServiceConfig) => { started.push(svc.name); },
      stop: () => {},
      cancelPendingRestart: () => {},
    } as unknown as import('../../../src/process/manager.js').ProcessManager;

    const rewritten = rewriteServicePort(base as ServiceConfig);
    state.set('app-api', {
      svc: rewritten, proc: null, pid: null, status: 'running', health: 'up',
      errors: 0, restarts: 0, startedAt: Date.now(), intentionalStop: false,
      colorIdx: 0, crashLog: null,
    });

    let ensured = 0;
    const lazyProxies = new Map([['app-api', {
      destroy: () => {},
      ensureStarted: async () => { ensured++; return true; },
    }]]) as unknown as Map<string, import('../../../src/lazy/proxy.js').LazyProxy & { ensureStarted(): Promise<boolean> }>;

    try {
      await applyConfigChange({
        configPath, baseCwd: dir, manager, lazyProxies, lazyTimeout: 10,
        baseline: [base as ServiceConfig],
        log: () => {},
      });
      // Through the proxy, never around it: spawning directly leaves the
      // proxy's readiness flag false, and the next request starts a *second*
      // process.
      assert.equal(ensured, 1, 'it did not go through the lazy proxy');
      assert.deepEqual(started, [], 'it spawned around the proxy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applyConfigChange when a lazy service changes port', () => {
  it('destroys the old proxy and binds a new one on the new port', async () => {
    // Three rounds of review lived in this branch and it had no test. The last
    // failure was an aliasing bug: `st` and `prev` are the same object, and
    // `rewriteServicePort` sets `originalPort` to the *new* port — so writing
    // the state before comparing made `portChanged` compare the new port with
    // itself. Always false, and the whole rebind was dead code: the proxy went
    // on listening on the old port and forwarding to the old real port, while
    // the snapshot advertised the new one.
    const dir = mkdtempSync(join(tmpdir(), 'devup-watch-port-'));
    const configPath = join(dir, 'devup.config.json');
    const base = { name: 'app-api', cwd: '.', cmd: 'node', args: ['a.js'], type: 'api', port: 3000, phase: 0 };
    writeFileSync(configPath, JSON.stringify({ name: 't', services: [{ ...base, port: 3001 }] }));

    const state = new Map<string, ProcessState>();
    const manager = {
      state,
      install: async () => true,
      start: async () => {},
      stop: () => {},
      cancelPendingRestart: () => {},
      forgetHealth: () => {},
    } as unknown as import('../../../src/process/manager.js').ProcessManager;

    const rewritten = rewriteServicePort(base as ServiceConfig);
    state.set('app-api', {
      svc: rewritten, proc: null, pid: null, status: 'idle', health: 'idle',
      errors: 0, restarts: 0, startedAt: null, intentionalStop: false,
      colorIdx: 0, crashLog: null,
    });

    let destroyed = 0;
    const proxies = new Map([['app-api', {
      destroy: () => { destroyed++; },
      ensureStarted: async () => true,
    }]]) as unknown as Map<string, import('../../../src/lazy/proxy.js').LazyProxy & { ensureStarted(): Promise<boolean> }>;

    try {
      await applyConfigChange({
        configPath, baseCwd: dir, manager, lazyProxies: proxies, lazyTimeout: 10,
        baseline: [base as ServiceConfig],
        log: () => {},
      });

      assert.equal(destroyed, 1, 'the old proxy was left listening on the old port');
      // A *new* proxy, bound to the new configured port.
      const proxy = proxies.get('app-api');
      assert.ok(proxy, 'no proxy registered for the new port');
      assert.notEqual(destroyed, 0);
      // And the state follows: the rewrite of the new port, not the old one.
      const st = state.get('app-api')!;
      assert.equal(st.svc.originalPort, 3001);
      assert.equal(st.svc.port, 13001);
    } finally {
      proxies.get('app-api')?.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not rebind when the port did not change', async () => {
    // The other half: rebinding on every edit would drop and re-create a proxy
    // — and with it any connection it was holding — for a changed argument.
    const dir = mkdtempSync(join(tmpdir(), 'devup-watch-noport-'));
    const configPath = join(dir, 'devup.config.json');
    const base = { name: 'app-api', cwd: '.', cmd: 'node', args: ['a.js'], type: 'api', port: 3000, phase: 0 };
    writeFileSync(configPath, JSON.stringify({ name: 't', services: [{ ...base, args: ['b.js'] }] }));

    const state = new Map<string, ProcessState>();
    const manager = {
      state, install: async () => true, start: async () => {},
      stop: () => {}, cancelPendingRestart: () => {}, forgetHealth: () => {},
    } as unknown as import('../../../src/process/manager.js').ProcessManager;

    state.set('app-api', {
      svc: rewriteServicePort(base as ServiceConfig), proc: null, pid: null,
      status: 'idle', health: 'idle', errors: 0, restarts: 0, startedAt: null,
      intentionalStop: false, colorIdx: 0, crashLog: null,
    });

    let destroyed = 0;
    const proxies = new Map([['app-api', {
      destroy: () => { destroyed++; },
      ensureStarted: async () => true,
    }]]) as unknown as Map<string, import('../../../src/lazy/proxy.js').LazyProxy & { ensureStarted(): Promise<boolean> }>;

    try {
      await applyConfigChange({
        configPath, baseCwd: dir, manager, lazyProxies: proxies, lazyTimeout: 10,
        baseline: [base as ServiceConfig],
        log: () => {},
      });
      assert.equal(destroyed, 0, 'it rebound a proxy whose port had not changed');
      assert.deepEqual(state.get('app-api')!.svc.args, ['b.js'], 'the edit did not reach the state');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applyConfigChange when a service is added', () => {
  it('registers it lazy in lazy mode instead of spawning it eagerly', async () => {
    // Starting it eagerly puts it on its configured port with no proxy and no
    // idle stop — permanently different from how the same service behaves
    // after a restart of devup, which is the kind of divergence nobody thinks
    // to look for.
    const dir = mkdtempSync(join(tmpdir(), 'devup-watch-added-'));
    const configPath = join(dir, 'devup.config.json');
    const existing = { name: 'app-api', cwd: '.', cmd: 'node', args: ['a.js'], type: 'api', port: 3000, phase: 0 };
    const added = { name: 'rules-api', cwd: '.', cmd: 'node', args: ['r.js'], type: 'api', port: 3007, phase: 0 };
    writeFileSync(configPath, JSON.stringify({
      name: 't', lazy: { alwaysOn: ['app-api'] }, services: [existing, added],
    }));

    const started: string[] = [];
    const state = new Map<string, ProcessState>();
    const manager = {
      state,
      install: async () => true,
      start: async (svc: ServiceConfig) => { started.push(svc.name); },
      stop: () => {}, cancelPendingRestart: () => {}, forgetHealth: () => {},
    } as unknown as import('../../../src/process/manager.js').ProcessManager;

    const proxies = new Map() as Map<string, import('../../../src/lazy/proxy.js').LazyProxy & { ensureStarted(): Promise<boolean> }>;

    try {
      await applyConfigChange({
        configPath, baseCwd: dir, manager, lazyProxies: proxies, lazyTimeout: 10,
        baseline: [existing as ServiceConfig],
        log: () => {},
      });

      assert.deepEqual(started, [], 'it spawned a service that should have been lazy');
      assert.ok(proxies.has('rules-api'), 'no lazy proxy was registered for it');
      // Registered idle, on the rewritten port, exactly as at boot.
      const st = state.get('rules-api')!;
      assert.equal(st.status, 'idle');
      assert.equal(st.svc.originalPort, 3007);
    } finally {
      proxies.get('rules-api')?.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still starts one named in lazy.alwaysOn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-watch-added2-'));
    const configPath = join(dir, 'devup.config.json');
    const existing = { name: 'app-api', cwd: '.', cmd: 'node', args: ['a.js'], type: 'api', port: 3000, phase: 0 };
    const added = { name: 'configurations-api', cwd: '.', cmd: 'node', args: ['c.js'], type: 'api', port: 2999, phase: 0 };
    writeFileSync(configPath, JSON.stringify({
      name: 't', lazy: { alwaysOn: ['app-api', 'configurations-api'] }, services: [existing, added],
    }));

    const started: string[] = [];
    const manager = {
      state: new Map<string, ProcessState>(),
      install: async () => true,
      start: async (svc: ServiceConfig) => { started.push(svc.name); },
      stop: () => {}, cancelPendingRestart: () => {}, forgetHealth: () => {},
    } as unknown as import('../../../src/process/manager.js').ProcessManager;
    const proxies = new Map() as Map<string, import('../../../src/lazy/proxy.js').LazyProxy & { ensureStarted(): Promise<boolean> }>;

    try {
      await applyConfigChange({
        configPath, baseCwd: dir, manager, lazyProxies: proxies, lazyTimeout: 10,
        baseline: [existing as ServiceConfig],
        log: () => {},
      });
      assert.deepEqual(started, ['configurations-api']);
      assert.equal(proxies.has('configurations-api'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
