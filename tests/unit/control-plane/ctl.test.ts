import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSocketServer, type RpcContext } from '../../../src/control-plane/socket-server.js';
import { runCtl } from '../../../src/orchestrator/subcommands.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';
import type { DevStackConfig } from '../../../src/config/types.js';

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

const svc: ServiceConfig = { name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0 };
function mkState(over: Partial<ProcessState> = {}): ProcessState {
  return {
    svc, proc: null, pid: 42, status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 0, crashLog: null,
    ...over,
  };
}
function mkConfig(name = 'test'): DevStackConfig {
  return { name, services: [svc] };
}
function noopCtx(over: Partial<RpcContext> = {}): RpcContext {
  return {
    states: () => new Map(),
    restart: async () => {},
    stop: () => {},
    tailLogs: async () => [],
    watchLogs: () => () => {},
    watchStatus: () => () => {},
    watchRemoved: () => () => {},
    start: async () => true,
    getStats: async () => ({ services: {}, system: { totalMemMB: 0, freeMemMB: 0, cpuCores: 0 } }),
    getProxyInfo: () => null,
    getInfo: () => ({ project: 'test', profiles: {} }),
    ...over,
  };
}

async function withServer(ctx: RpcContext, fn: (socketPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'devup-ctl-'));
  const path = join(dir, 's.sock');
  try {
    const handle = await startSocketServer('test', ctx, { path });
    try { await fn(path); } finally { await handle.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('runCtl', { skip: !isUnix }, () => {
  it('ping prints pong with ts', async () => {
    const lines: string[] = [];
    await withServer(noopCtx(), async path => {
      const code = await runCtl(['ping'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      assert.ok(lines[0].startsWith('pong'));
      assert.ok(lines[0].includes('ts='));
    });
  });

  it('status prints tabular snapshot', async () => {
    const lines: string[] = [];
    const states = new Map([
      ['api', mkState({ status: 'running', health: 'up', pid: 1234, errors: 0, restarts: 2 })],
      ['web', mkState({ svc: { ...svc, name: 'web', type: 'web', port: 4000 }, status: 'crashed', health: 'down', pid: null, errors: 5, restarts: 3 })],
    ]);
    await withServer(noopCtx({ states: () => states }), async path => {
      const code = await runCtl(['status'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      assert.equal(lines.length, 2);
      assert.ok(lines[0].includes('api'));
      assert.ok(lines[0].includes('running'));
      assert.ok(lines[0].includes('pid=1234'));
      assert.ok(lines[1].includes('web'));
      assert.ok(lines[1].includes('crashed'));
      assert.ok(lines[1].includes('errors=5'));
    });
  });

  it('logs prints tail lines', async () => {
    const lines: string[] = [];
    await withServer(noopCtx({
      tailLogs: async () => ['line one', 'line two', 'line three'],
    }), async path => {
      const code = await runCtl(['logs', 'api'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      assert.deepEqual(lines, ['line one', 'line two', 'line three']);
    });
  });

  it('restart sends rpc and prints confirmation', async () => {
    const restarted: string[] = [];
    const lines: string[] = [];
    await withServer(noopCtx({
      restart: async n => { restarted.push(n); },
    }), async path => {
      const code = await runCtl(['restart', 'api'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      assert.deepEqual(restarted, ['api']);
      assert.ok(lines[0].includes('restart sent'));
    });
  });

  it('ctl restart --wait returns 0 when service becomes healthy', async () => {
    const lines: string[] = [];
    let callCount = 0;
    const states = new Map([['api', mkState({ health: 'down' })]]);
    await withServer(noopCtx({
      restart: async () => {},
      states: () => {
        callCount++;
        if (callCount >= 2) states.set('api', mkState({ health: 'up' }));
        return states;
      },
    }), async path => {
      const code = await runCtl(['restart', 'api', '--wait', '--timeout', '5'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      assert.ok(lines.some(l => l.includes('healthy')));
    });
  });

  it('status --follow prints removals instead of throwing on them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-ctl-'));
    const path = join(dir, 's.sock');
    try {
      let removedCb: ((name: string) => void) | null = null;
      const handle = await startSocketServer('t', noopCtx({
        states: () => new Map([['api', mkState()]]),
        watchRemoved: (cb) => { removedCb = cb; return () => { removedCb = null; }; },
      }), { path });
      const lines: string[] = [];
      try {
        // `removed` frames carry names, not service rows. Reading `.name` off a
        // string throws inside the frame handler, which the client used to
        // swallow — the CLI then printed nothing and kept listing the service.
        const run = runCtl(['status', '--follow'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
        await new Promise(r => setTimeout(r, 80));
        removedCb?.('legacy');
        await new Promise(r => setTimeout(r, 80));
        process.emit('SIGINT');
        await run;

        assert.ok(lines.some(l => l.includes('api') && l.includes('running')), `expected the snapshot row, got ${JSON.stringify(lines)}`);
        assert.ok(lines.some(l => l.includes('legacy') && l.includes('removed')), `expected a removal line, got ${JSON.stringify(lines)}`);
      } finally {
        await handle.close();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('ctl status --json outputs JSON array', async () => {
    const lines: string[] = [];
    const states = new Map([['api', mkState({ status: 'running', health: 'up' })]]);
    await withServer(noopCtx({ states: () => states }), async path => {
      const code = await runCtl(['status', '--json'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      const parsed = JSON.parse(lines.join('\n'));
      assert.ok(Array.isArray(parsed));
      assert.equal(parsed[0].name, 'api');
    });
  });

  it('start sends rpc and prints confirmation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-ctl-'));
    const path = join(dir, 's.sock');
    try {
      let started: string | null = null;
      const handle = await startSocketServer('t', noopCtx({ start: async (n) => { started = n; return true; } }), { path });
      const lines: string[] = [];
      try {
        const code = await runCtl(['start', 'api'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
        assert.equal(code, 0);
        assert.equal(started, 'api');
        assert.ok(lines.some(l => l.includes('api') && l.includes('started')), JSON.stringify(lines));
      } finally { await handle.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('start reports failure when the service does not come up', async () => {
    // The spawner returns normally after recording a crash, so a client that
    // trusts "request accepted" prints a tick over a dead service.
    const dir = mkdtempSync(join(tmpdir(), 'devup-ctl-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('t', noopCtx({ start: async () => false }), { path });
      const lines: string[] = [];
      try {
        const code = await runCtl(['start', 'api'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
        assert.equal(code, 1);
        assert.ok(lines.some(l => l.includes('did not come up')), JSON.stringify(lines));
      } finally { await handle.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('start without a service name returns 1 with usage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-ctl-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('t', noopCtx(), { path });
      const lines: string[] = [];
      try {
        const code = await runCtl(['start'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
        assert.equal(code, 1);
        assert.ok(lines.some(l => l.includes('usage')), JSON.stringify(lines));
      } finally { await handle.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('stop sends rpc and prints confirmation', async () => {
    const stopped: string[] = [];
    const lines: string[] = [];
    await withServer(noopCtx({
      stop: n => { stopped.push(n); },
    }), async path => {
      const code = await runCtl(['stop', 'api'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      assert.deepEqual(stopped, ['api']);
      assert.ok(lines[0].includes('stop sent'));
    });
  });

  it('returns 1 with friendly error when socket does not exist', async () => {
    const lines: string[] = [];
    const code = await runCtl(['status'], {
      config: mkConfig('myproject'),
      socketPath: '/tmp/devup-nonexistent-999.sock',
      out: l => lines.push(l),
    });
    assert.equal(code, 1);
    assert.ok(lines[0].includes('myproject'));
    assert.ok(lines[0].toLowerCase().includes('not running'));
  });

  it('logs returns 1 with usage when no service given', async () => {
    const lines: string[] = [];
    await withServer(noopCtx(), async path => {
      const code = await runCtl(['logs'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.ok(lines[0].includes('usage'));
    });
  });

  it('unknown method returns 1 with hint', async () => {
    const lines: string[] = [];
    await withServer(noopCtx(), async path => {
      const code = await runCtl(['frobnicate'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.ok(lines[0].includes('frobnicate'));
    });
  });

  it('help / no args prints usage and returns 0', async () => {
    const lines: string[] = [];
    const code = await runCtl([], { config: mkConfig(), out: l => lines.push(l) });
    assert.equal(code, 0);
    assert.ok(lines.some(l => l.includes('ping')));
    assert.ok(lines.some(l => l.includes('status')));
    assert.ok(lines.some(l => l.includes('logs')));
    assert.ok(lines.some(l => l.includes('restart')));
    assert.ok(lines.some(l => l.includes('stop')));
  });
});

describe('runCtl wait', { skip: !isUnix }, () => {
  const upSvc = (name: string, port: number) => mkState({ svc: { ...svc, name, port } });
  const idleSvc = (name: string, port: number, phase = 0) => mkState({
    svc: { ...svc, name, port, phase }, status: 'idle', health: 'idle', pid: null,
  });

  it('exits 0 and says how long it took when everything is ready', async () => {
    const lines: string[] = [];
    const states = new Map([['api', upSvc('api', 3000)], ['web', upSvc('web', 4200)]]);
    await withServer(noopCtx({ states: () => states }), async path => {
      const code = await runCtl(['wait', '--timeout', '5'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join('|'));
      assert.ok(lines.some(l => l.includes('ready in')), lines.join('|'));
    });
  });

  it('exits 1 naming what never arrived, not just a count', async () => {
    const lines: string[] = [];
    const states = new Map([
      ['api', upSvc('api', 3000)],
      ['web', mkState({ svc: { ...svc, name: 'web', port: 4200 }, status: 'starting', health: 'wait' })],
    ]);
    await withServer(noopCtx({ states: () => states }), async path => {
      const code = await runCtl(['wait', '--timeout', '1'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.ok(lines.some(l => l.includes('web')), lines.join('|'));
      assert.ok(!lines.some(l => /not ready.*api\b/.test(l) && !l.includes('web')), 'healthy api must not be blamed');
    });
  });

  it('counts a lazy idle service as ready without starting it', async () => {
    // Its proxy is listening on originalPort, so the stack serves. Starting it
    // here would be a side effect nobody asked for.
    const lines: string[] = [];
    const started: string[] = [];
    const states = new Map([['auth', idleSvc('auth', 13002)]]);
    await withServer(noopCtx({ states: () => states, start: async n => { started.push(n); return true; } }), async path => {
      const code = await runCtl(['wait', '--timeout', '2'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join('|'));
      assert.deepEqual(started, []);
      assert.ok(lines.some(l => l.includes('idle')), lines.join('|'));
    });
  });

  it('--start warms the idle ones instead', async () => {
    const lines: string[] = [];
    const started: string[] = [];
    const states = new Map([['auth', idleSvc('auth', 13002)]]);
    await withServer(noopCtx({
      states: () => states,
      start: async n => {
        started.push(n);
        // The daemon brings it up; the poll after the warm-up must see that.
        states.set(n, upSvc(n, 13002));
        return true;
      },
    }), async path => {
      const code = await runCtl(['wait', '--start', '--timeout', '5'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join('|'));
      assert.deepEqual(started, ['auth']);
    });
  });

  it('waits only for the named services', async () => {
    const lines: string[] = [];
    const states = new Map([
      ['api', upSvc('api', 3000)],
      ['broken', mkState({ svc: { ...svc, name: 'broken', port: 9999 }, status: 'timeout', health: 'down' })],
    ]);
    await withServer(noopCtx({ states: () => states }), async path => {
      const code = await runCtl(['wait', 'api', '--timeout', '5'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join('|'));
    });
  });

  it('rejects a bad --timeout instead of silently using the default', async () => {
    // Falling back to 120 s is how someone spends an afternoon wondering why
    // their 5 s budget was ignored.
    const lines: string[] = [];
    await withServer(noopCtx(), async path => {
      const code = await runCtl(['wait', '--timeout', 'soon'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.ok(lines.some(l => l.includes('invalid --timeout')), lines.join('|'));
    });
  });

  it('does not read the value of --timeout as a service name', async () => {
    // `wait --timeout 5` must not wait for a service called "5".
    const lines: string[] = [];
    const states = new Map([['api', upSvc('api', 3000)]]);
    await withServer(noopCtx({ states: () => states }), async path => {
      const code = await runCtl(['wait', '--timeout', '5'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join('|'));
    });
  });

  it('resolves --profile from the config, and says what exists when it does not', async () => {
    const lines: string[] = [];
    const states = new Map([['api', upSvc('api', 3000)], ['web', mkState({ svc: { ...svc, name: 'web', port: 4200 }, status: 'starting', health: 'wait' })]]);
    const config = { ...mkConfig(), profiles: { e2e: ['api'] } };
    await withServer(noopCtx({ states: () => states }), async path => {
      const code = await runCtl(['wait', '--profile', 'e2e', '--timeout', '5'], { config, socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join('|'));

      lines.length = 0;
      const bad = await runCtl(['wait', '--profile', 'nope'], { config, socketPath: path, out: l => lines.push(l) });
      assert.equal(bad, 1);
      assert.ok(lines.some(l => l.includes('Available: e2e')), lines.join('|'));
    });
  });

  it('--json prints a machine-readable summary and nothing else', async () => {
    const lines: string[] = [];
    const states = new Map([['api', upSvc('api', 3000)]]);
    await withServer(noopCtx({ states: () => states }), async path => {
      const code = await runCtl(['wait', '--json', '--timeout', '5'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      const parsed = JSON.parse(lines.join('\n'));
      assert.equal(parsed.ok, true);
      assert.deepEqual(parsed.services.map((s: { name: string }) => s.name), ['api']);
    });
  });

  it('names an unknown service rather than waiting out the clock for it', async () => {
    const lines: string[] = [];
    const states = new Map([['api', upSvc('api', 3000)]]);
    await withServer(noopCtx({ states: () => states }), async path => {
      const started = Date.now();
      const code = await runCtl(['wait', 'ghost', '--timeout', '30'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.ok(Date.now() - started < 5000, 'should not have waited the full timeout');
      assert.ok(lines.some(l => l.includes('ghost')), lines.join('|'));
    });
  });
});
