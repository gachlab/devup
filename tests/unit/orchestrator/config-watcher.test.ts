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
