import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSocketServer, type RpcContext } from '../../../src/control-plane/socket-server.js';
import { runCtl, resolveTargets } from '../../../src/orchestrator/subcommands.js';
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
  // `Object.assign`, not `{ ...base, ...over }`: spreading a Partial makes every
  // member optional, so a base missing a method still type-checks — which is
  // exactly how a fake comes to lag the interface (CLAUDE.md rule 5). This way
  // the base is checked as a complete RpcContext.
  const base: RpcContext = {
    states: () => new Map(),
    restart: async () => ({ ok: true, skippedIdle: false }),
    stop: () => {},
    tailLogs: async () => ({ lines: [], oldestRetained: null, truncated: false }),
    watchLogs: () => () => {},
    watchStatus: () => () => {},
    watchRemoved: () => () => {},
    start: async () => ({ ok: true }),
    getStats: async () => ({ services: {}, system: { totalMemMB: 0, freeMemMB: 0, cpuCores: 0 } }),
    getProxyInfo: () => null,
    getInfo: () => ({ project: 'test', profiles: {} }),
    debug: async () => ({ debug: false, port: null, ok: true }),
    setRemote: async (_n, envName) => ({
      ok: true,
      remote: envName === null ? null : { envName, target: `https://api.${envName}.test`, readOnly: false },
    }),
  };
  return Object.assign(base, over);
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
      tailLogs: async () => ({ lines: ['line one', 'line two', 'line three'], oldestRetained: null, truncated: false }),
    }), async path => {
      const code = await runCtl(['logs', 'api'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      assert.deepEqual(lines, ['line one', 'line two', 'line three']);
    });
  });

  it('restart sends rpc and prints confirmation', async () => {
    const restarted: string[] = [];
    const lines: string[] = [];
    // The daemon has to actually have the service: `restart` resolves names
    // against the snapshot now, rather than sending an RPC that the daemon
    // would silently ignore.
    const states = new Map([['api', mkState({})]]);
    await withServer(noopCtx({
      states: () => states,
      restart: async n => { restarted.push(n); return { ok: true, skippedIdle: false }; },
    }), async path => {
      const code = await runCtl(['restart', 'api'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join('|'));
      assert.deepEqual(restarted, ['api']);
      assert.ok(lines[0].includes('restarted'), lines.join('|'));
    });
  });

  it('ctl restart --wait returns 0 when service becomes healthy', async () => {
    const lines: string[] = [];
    let callCount = 0;
    const states = new Map([['api', mkState({ health: 'down' })]]);
    await withServer(noopCtx({
      restart: async () => ({ ok: true, skippedIdle: false }),
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
      // A no-op default rather than `| null`: TypeScript narrows a `let` that is
      // only visibly assigned `null` down to `null`, and the assignment that
      // matters happens inside the subscribe callback, which it cannot see.
      let removedCb: (name: string) => void = () => {};
      const handle = await startSocketServer('t', noopCtx({
        states: () => new Map([['api', mkState()]]),
        watchRemoved: (cb) => { removedCb = cb; return () => { removedCb = () => {}; }; },
      }), { path });
      const lines: string[] = [];
      try {
        // `removed` frames carry names, not service rows. Reading `.name` off a
        // string throws inside the frame handler, which the client used to
        // swallow — the CLI then printed nothing and kept listing the service.
        const run = runCtl(['status', '--follow'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
        await new Promise(r => setTimeout(r, 80));
        removedCb('legacy');
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
      const states = new Map([['api', mkState({})]]);
      const handle = await startSocketServer('t', noopCtx({ states: () => states, start: async (n) => { started = n; return { ok: true }; } }), { path });
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
      const states = new Map([['api', mkState({})]]);
      const handle = await startSocketServer('t', noopCtx({ states: () => states, start: async () => ({ ok: false }) }), { path });
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
    await withServer(noopCtx({ states: () => states, start: async n => { started.push(n); return { ok: true }; } }), async path => {
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
        return { ok: true };
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

describe('runCtl logs --follow against an odd ack', { skip: !isUnix }, () => {
  it('survives a daemon that acks without a result', async () => {
    // `openStream` hands `msg.result` straight through, so an ack with no
    // `result` key gives `undefined` — and a throw inside the readline 'line'
    // listener takes the whole process down, which `openStream`'s own comments
    // call out as the trade it makes.
    const { createServer } = await import('node:net');
    const dir = mkdtempSync(join(tmpdir(), 'devup-oddack-'));
    const path = join(dir, 's.sock');
    const open = new Set<import('node:net').Socket>();
    const server = createServer(sock => {
      open.add(sock);
      sock.once('data', () => {
        sock.write(JSON.stringify({ id: 1 }) + '\n');                       // ack, no result
        sock.write(JSON.stringify({ id: 1, event: 'log', data: 'a line' }) + '\n');
      });
    });
    try {
      await new Promise<void>(r => server.listen(path, r));
      const lines: string[] = [];
      const run = runCtl(['logs', 'api', '--since', '5m', '--follow'],
        { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      await new Promise(r => setTimeout(r, 250));
      // Still alive, and it printed the frame rather than dying on the ack.
      assert.ok(lines.includes('a line'), lines.join('|'));
      process.emit('SIGINT');
      assert.equal(await run, 0);
    } finally {
      for (const sock of open) sock.destroy();
      await new Promise<void>(r => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runCtl logs --since', { skip: !isUnix }, () => {
  it('passes a duration through as an epoch timestamp', async () => {
    const asked: Array<{ svc: string; lines: number; since?: number }> = [];
    const before = Date.now();
    await withServer(noopCtx({
      tailLogs: async (svc, o) => { asked.push({ svc, ...o }); return { lines: ['x'], oldestRetained: null, truncated: false }; },
    }), async path => {
      const code = await runCtl(['logs', 'api', '--since', '5m'], { config: mkConfig(), socketPath: path, out: () => {} });
      assert.equal(code, 0);
      assert.equal(asked.length, 1);
      const since = asked[0]!.since!;
      // Five minutes ago, give or take how long the call took.
      assert.ok(Math.abs((before - 300_000) - since) < 5_000, `since was ${since}`);
    });
  });

  it('does not read the value of --since as the service name', async () => {
    const asked: string[] = [];
    await withServer(noopCtx({
      tailLogs: async (svc, _o) => { asked.push(svc); return { lines: [], oldestRetained: null, truncated: false }; },
    }), async path => {
      const code = await runCtl(['logs', '--since', '5m', 'api'], { config: mkConfig(), socketPath: path, out: () => {} });
      assert.equal(code, 0);
      assert.deepEqual(asked, ['api'], 'the service is "api", not "5m"');
    });
  });

  it('rejects a --since it cannot read rather than fetching everything', async () => {
    // Quietly meaning "from the beginning" attaches the wrong evidence to a
    // failing test, which is worse than attaching none.
    const lines: string[] = [];
    let called = false;
    await withServer(noopCtx({ tailLogs: async () => { called = true; return { lines: [], oldestRetained: null, truncated: false }; } }), async path => {
      const code = await runCtl(['logs', 'api', '--since', 'yesterday'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.equal(called, false, 'it must not have asked for anything');
      assert.ok(lines.some(l => l.includes('invalid --since')), lines.join('|'));
    });
  });

  it('says the log starts after the window — without claiming anything was rotated', async () => {
    // devup cannot tell "rotated away" from "the service was not running yet",
    // and on a stack booted a minute ago the second is the ordinary case. The
    // first version asserted a rotation that had not happened.
    const lines: string[] = [];
    const since = Date.parse('2026-08-23T10:00:00.000Z');
    await withServer(noopCtx({
      tailLogs: async () => ({ lines: ['a'], oldestRetained: Date.parse('2026-08-23T11:00:00.000Z'), truncated: false }),
    }), async path => {
      const code = await runCtl(['logs', 'api', '--since', String(since)], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      const said = lines.join(' ');
      assert.match(said, /starts at 2026-08-23T11:00:00\.000Z/);
      assert.match(said, /after the window you asked for/);
      assert.match(said, /not running yet/, 'both explanations, since devup cannot choose between them');
    });
  });

  it('says nothing when the log starts at or before the window', async () => {
    const lines: string[] = [];
    const since = Date.parse('2026-08-23T12:00:00.000Z');
    await withServer(noopCtx({
      tailLogs: async () => ({ lines: ['a'], oldestRetained: Date.parse('2026-08-23T11:00:00.000Z'), truncated: false }),
    }), async path => {
      await runCtl(['logs', 'api', '--since', String(since)], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.ok(!lines.some(l => l.includes('after the window')), lines.join('|'));
    });
  });

  it('says the oldest of the window was dropped, when the daemon says so', async () => {
    // Counted from what came back it could not be right: the cap keeps the
    // most recent, so a full-looking answer is exactly what a truncated window
    // looks like. The daemon knows because it did the dropping.
    const lines: string[] = [];
    await withServer(noopCtx({
      tailLogs: async (_svc, o) => ({ lines: Array.from({ length: o.lines }, (_, i) => `l${i}`), oldestRetained: 0, truncated: true }),
    }), async path => {
      await runCtl(['logs', 'api', '--since', '5m', '--lines', '3'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      const said = lines.join(' ');
      assert.match(said, /more than 3 lines matched/);
      assert.match(said, /oldest were dropped/, 'the head is what a window loses, not the tail');
    });
  });

  it('stays quiet when a full-looking answer was not actually truncated', async () => {
    // Exactly `lines` lines and nothing dropped: the old count-based check
    // cried wolf here on every plain `devup ctl logs` of a 100-line log.
    const lines: string[] = [];
    await withServer(noopCtx({
      tailLogs: async (_svc, o) => ({ lines: Array.from({ length: o.lines }, (_, i) => `l${i}`), oldestRetained: 0, truncated: false }),
    }), async path => {
      await runCtl(['logs', 'api', '--lines', '3'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.ok(!lines.some(l => l.includes('dropped')), lines.join('|'));
    });
  });

  it('rejects a fractional --lines instead of letting the daemon clamp it to 1', async () => {
    const lines: string[] = [];
    let called = false;
    await withServer(noopCtx({ tailLogs: async () => { called = true; return { lines: [], oldestRetained: null, truncated: false }; } }), async path => {
      const code = await runCtl(['logs', 'api', '--lines', '2.5'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.equal(called, false);
      assert.ok(lines.some(l => l.includes('invalid --lines')), lines.join('|'));
    });
  });

  it('still tails without a window, as it always did', async () => {
    const asked: Array<{ lines: number; since?: number }> = [];
    await withServer(noopCtx({
      tailLogs: async (_svc, o) => { asked.push(o); return { lines: ['one'], oldestRetained: null, truncated: false }; },
    }), async path => {
      const out: string[] = [];
      const code = await runCtl(['logs', 'api'], { config: mkConfig(), socketPath: path, out: l => out.push(l) });
      assert.equal(code, 0);
      assert.deepEqual(asked, [{ lines: 100, since: undefined }]);
      assert.deepEqual(out, ['one']);
    });
  });
});

describe('resolveTargets', () => {
  const config = { profiles: { e2e: ['api', 'web'] } };

  it('takes positional names', () => {
    assert.deepEqual(resolveTargets(['start', 'a', 'b'], config, { defaultAll: false, verb: 'start' }).names, ['a', 'b']);
  });

  it('de-duplicates', () => {
    assert.deepEqual(resolveTargets(['start', 'a', 'a'], config, { defaultAll: false, verb: 'start' }).names, ['a']);
  });

  it('expands a profile, and says what exists when it does not', () => {
    assert.deepEqual(resolveTargets(['start', '--profile', 'e2e'], config, { defaultAll: false, verb: 'start' }).names, ['api', 'web']);
    const bad = resolveTargets(['start', '--profile', 'nope'], config, { defaultAll: false, verb: 'start' });
    assert.equal(bad.names, null);
    assert.match(bad.error!, /Available: e2e/);
  });

  it('reads --all as "everything the daemon has"', () => {
    assert.deepEqual(resolveTargets(['start', '--all'], config, { defaultAll: false, verb: 'start' }).names, []);
  });

  it('refuses --all together with names, rather than quietly picking one', () => {
    const r = resolveTargets(['start', '--all', 'api'], config, { defaultAll: false, verb: 'start' });
    assert.equal(r.names, null);
    assert.match(r.error!, /--all cannot be combined/);
  });

  it('will not restart everything just because a name was forgotten', () => {
    // `wait` with no arguments sensibly means everything; `start`/`restart`
    // must not, and the usage line is the whole answer.
    const r = resolveTargets(['restart'], config, { defaultAll: false, verb: 'restart' });
    assert.equal(r.names, null);
    assert.match(r.error!, /devup ctl restart <service\.\.\.> \| --profile <name> \| --all/);
    // ...while wait does.
    assert.deepEqual(resolveTargets(['wait'], config, { defaultAll: true, verb: 'wait' }).names, []);
  });

  it('does not read the value of a spaced flag as a service name', () => {
    assert.deepEqual(resolveTargets(['wait', '--timeout', '5'], config, { defaultAll: true, verb: 'wait' }).names, []);
  });
});

describe('runCtl start/restart in batch', { skip: !isUnix }, () => {
  const svcAt = (name: string, phase: number) =>
    mkState({ svc: { ...svc, name, phase, port: 3000 + phase }, status: 'idle', health: 'idle', pid: null });

  it('starts several at once, in ascending config phase', async () => {
    // The phase order is the only statement anyone has made about what needs
    // what — a phase-4 web started before its phase-0 API just spends its
    // restart budget finding out.
    const order: string[] = [];
    const states = new Map([
      ['web', svcAt('web', 4)], ['auth', svcAt('auth', 0)], ['app', svcAt('app', 1)],
    ]);
    const lines: string[] = [];
    await withServer(noopCtx({
      states: () => states,
      start: async n => { order.push(n); return { ok: true }; },
    }), async path => {
      const code = await runCtl(['start', '--all'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join('|'));
      assert.deepEqual(order, ['auth', 'app', 'web']);
    });
  });

  it('exits 1 naming the ones that did not come up, and 0 for the ones that did', async () => {
    const states = new Map([['api', svcAt('api', 0)], ['web', svcAt('web', 0)]]);
    const lines: string[] = [];
    await withServer(noopCtx({
      states: () => states,
      start: async n => ({ ok: n !== 'web' }),
    }), async path => {
      const code = await runCtl(['start', 'api', 'web'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      const said = lines.join(' ');
      assert.match(said, /✓ api started/);
      assert.match(said, /✗ web did not come up/);
      assert.match(said, /1 of 2 failed: web/);
    });
  });

  it('keeps going when one service throws, and still reports the others', async () => {
    // A returned `false` and a thrown RPC are different paths. Without a catch
    // per service, `Promise.all` rejects and the whole batch unwinds — the
    // successes go unreported and the failure loses its name.
    const states = new Map([['api', svcAt('api', 0)], ['web', svcAt('web', 0)]]);
    const lines: string[] = [];
    await withServer(noopCtx({
      states: () => states,
      start: async n => { if (n === 'web') throw new Error('the spawner exploded'); return { ok: true }; },
    }), async path => {
      const code = await runCtl(['start', '--all'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      const said = lines.join(' ');
      assert.match(said, /✓ api started/, 'the one that worked must still be reported');
      assert.match(said, /✗ web/);
      assert.match(said, /the spawner exploded/, 'and the reason it did not');
    });
  });

  it('does not read --instance\'s value as a service name', async () => {
    // Every `ctl start/restart/wait` against a named instance was broken by
    // this: `--instance e2e api` resolved to ['api','e2e'], and the batch
    // failed on the unknown name before starting anything.
    const started: string[] = [];
    const states = new Map([['api', svcAt('api', 0)]]);
    const lines: string[] = [];
    await withServer(noopCtx({ states: () => states, start: async n => { started.push(n); return { ok: true }; } }), async path => {
      const code = await runCtl(['start', '--instance', 'e2e', 'api'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join('|'));
      assert.deepEqual(started, ['api']);
    });
  });

  it('does not read a global flag\'s value as a service name', async () => {
    // `runCtl` gets the whole argv, and index.ts really does honour --config
    // and --log-dir for ctl — so the path was being read as a service and the
    // batch died on it having started nothing.
    const started: string[] = [];
    const states = new Map([['api', svcAt('api', 0)]]);
    const lines: string[] = [];
    await withServer(noopCtx({ states: () => states, start: async n => { started.push(n); return { ok: true }; } }), async path => {
      const code = await runCtl(['start', '--config', './devup.config.ts', 'api'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join('|'));
      assert.deepEqual(started, ['api']);
    });
  });

  it('says a lazy service was left idle rather than claiming it restarted', async () => {
    const states = new Map([['api', svcAt('api', 0)]]);
    const lines: string[] = [];
    await withServer(noopCtx({
      states: () => states,
      restart: async () => ({ ok: true, skippedIdle: true }),
    }), async path => {
      const code = await runCtl(['restart', '--all'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join('|'));
      assert.ok(lines.some(l => l.includes('left idle')), lines.join('|'));
      assert.ok(!lines.some(l => l.includes('restarted')), lines.join('|'));
    });
  });

  it('reports a restart that did not bring the service back', async () => {
    const states = new Map([['api', svcAt('api', 0)]]);
    const lines: string[] = [];
    await withServer(noopCtx({
      states: () => states,
      restart: async () => ({ ok: false, skippedIdle: false }),
    }), async path => {
      const code = await runCtl(['restart', 'api'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.ok(lines.some(l => l.includes('did not come up')), lines.join('|'));
    });
  });

  it('restarts a whole stack with --all', async () => {
    const restarted: string[] = [];
    const states = new Map([['api', svcAt('api', 0)], ['web', svcAt('web', 1)]]);
    const lines: string[] = [];
    await withServer(noopCtx({
      states: () => states,
      restart: async n => { restarted.push(n); return { ok: true, skippedIdle: false }; },
    }), async path => {
      const code = await runCtl(['restart', '--all'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join('|'));
      assert.deepEqual(restarted, ['api', 'web']);
      assert.ok(lines.some(l => l.includes('✓ api restarted')), lines.join('|'));
    });
  });

  it('refuses a name the daemon does not have, rather than half-doing the batch', async () => {
    const started: string[] = [];
    const states = new Map([['api', svcAt('api', 0)]]);
    const lines: string[] = [];
    await withServer(noopCtx({
      states: () => states,
      start: async n => { started.push(n); return { ok: true }; },
    }), async path => {
      const code = await runCtl(['start', 'api', 'ghost'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.deepEqual(started, [], 'nothing should have been started');
      assert.ok(lines.some(l => l.includes('ghost')), lines.join('|'));
    });
  });

  it('still works for a single service, as it always did', async () => {
    const states = new Map([['api', svcAt('api', 0)]]);
    const lines: string[] = [];
    await withServer(noopCtx({ states: () => states, start: async () => ({ ok: true }) }), async path => {
      const code = await runCtl(['start', 'api'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      assert.deepEqual(lines, ['✓ api started']);
    });
  });
});

describe('runCtl remote', { skip: !isUnix }, () => {
  it('sends a service to an environment and warns about writes', async () => {
    const asked: Array<[string, string | null]> = [];
    const lines: string[] = [];
    await withServer(noopCtx({
      setRemote: async (name, envName) => {
        asked.push([name, envName]);
        return { ok: true, remote: { envName: envName!, target: 'https://api.qa.test', readOnly: false } };
      },
    }), async path => {
      const code = await runCtl(['remote', 'api', 'qa'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      assert.deepEqual(asked, [['api', 'qa']]);
      assert.ok(lines.some(l => l.includes('https://api.qa.test')), JSON.stringify(lines));
      // Said every time it happens. The default is writable, and this is the
      // moment somebody just pointed a service at a shared environment.
      assert.ok(lines.some(l => /writes reach qa/.test(l)), JSON.stringify(lines));
    });
  });

  it('stays quiet about writes for a read-only environment', async () => {
    const lines: string[] = [];
    await withServer(noopCtx({
      setRemote: async () => ({ ok: true, remote: { envName: 'qa', target: 'https://api.qa.test', readOnly: true } }),
    }), async path => {
      await runCtl(['remote', 'api', 'qa'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.ok(!lines.some(l => /writes reach/.test(l)), JSON.stringify(lines));
    });
  });

  it('brings a service back local with --local', async () => {
    const asked: Array<string | null> = [];
    const lines: string[] = [];
    await withServer(noopCtx({
      setRemote: async (_n, envName) => { asked.push(envName); return { ok: true, remote: null }; },
    }), async path => {
      const code = await runCtl(['remote', 'api', '--local'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0);
      assert.deepEqual(asked, [null]);
      assert.ok(lines.some(l => /running locally/.test(l)), JSON.stringify(lines));
    });
  });

  it('exits 1 and prints the reason when the switch fails', async () => {
    const lines: string[] = [];
    await withServer(noopCtx({
      setRemote: async () => ({ ok: false, remote: null, error: 'unknown environment: "prod"' }),
    }), async path => {
      const code = await runCtl(['remote', 'api', 'prod'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.ok(lines.some(l => /unknown environment/.test(l)), JSON.stringify(lines));
    });
  });

  it('refuses an environment and --local together', async () => {
    // Two opposite intentions in one command. Picking either silently is how
    // traffic ends up somewhere nobody asked for.
    const calls: number[] = [];
    const lines: string[] = [];
    await withServer(noopCtx({
      setRemote: async () => { calls.push(1); return { ok: true, remote: null }; },
    }), async path => {
      const code = await runCtl(['remote', 'api', 'qa', '--local'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.equal(calls.length, 0, 'it asked the daemon anyway');
      assert.ok(lines.some(l => /not both/.test(l)), JSON.stringify(lines));
    });
  });

  it('prints usage when the service or the destination is missing', async () => {
    const lines: string[] = [];
    await withServer(noopCtx(), async path => {
      const code = await runCtl(['remote', 'api'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.ok(lines.some(l => l.includes('usage')), JSON.stringify(lines));
    });
  });
});

describe('runCtl restart with a remote service in the batch', { skip: !isUnix }, () => {
  // Local to this block, like the one in the batch suite above.
  const svcAt = (name: string, phase: number) =>
    mkState({ svc: { ...svc, name, phase, port: 3000 + phase }, status: 'running', health: 'up', pid: 1 });

  it('reports it as skipped, not as a failure', async () => {
    // `restart --all` between suites on a stack that is half proxied is an
    // ordinary thing to do. "did not come up" would be wrong twice over: the
    // service is up, and the run would exit 1 on a healthy stack.
    const states = new Map([['api', svcAt('api', 0)], ['auth', svcAt('auth', 0)]]);
    const lines: string[] = [];
    await withServer(noopCtx({
      states: () => states,
      restart: async n => n === 'auth'
        ? { ok: true, skippedIdle: false, skippedRemote: 'qa' }
        : { ok: true, skippedIdle: false },
    }), async path => {
      const code = await runCtl(['restart', 'api', 'auth'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      const said = lines.join(' ');
      assert.equal(code, 0, said);
      assert.match(said, /✓ api restarted/);
      assert.match(said, /· auth served from qa — nothing to restart here/);
      assert.ok(!/did not come up/.test(said), said);
    });
  });

  it('says the same for start', async () => {
    const states = new Map([['auth', svcAt('auth', 0)]]);
    const lines: string[] = [];
    await withServer(noopCtx({
      states: () => states,
      start: async () => ({ ok: true, skippedRemote: 'qa' }),
    }), async path => {
      const code = await runCtl(['start', 'auth'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
      assert.equal(code, 0, lines.join(' '));
      assert.match(lines.join(' '), /· auth served from qa — nothing to start here/);
      // "started" would claim a spawn that never happened.
      assert.ok(!/✓ auth started/.test(lines.join(' ')), lines.join(' '));
    });
  });
});

describe('runCtl status prints the port you can connect to', { skip: !isUnix }, () => {
  it('shows the configured port for a lazy service, not the internal one', async () => {
    // The whole point of `originalPort`: devup runs a lazy service on
    // `port + 10000` and keeps the on-demand proxy on the configured one, so
    // `port` is the number a user cannot reach. `ctl status` printed it,
    // because the hand-written row type never declared the field.
    const states = new Map([['auth', mkState({
      svc: { ...svc, name: 'auth', port: 13002 },
      status: 'idle', health: 'idle', pid: null,
    })]]);
    // As the orchestrator holds a lazy service: the rewrite already happened.
    (states.get('auth')!.svc as { originalPort?: number }).originalPort = 3002;

    const lines: string[] = [];
    await withServer(noopCtx({ states: () => states }), async path => {
      await runCtl(['status'], { config: mkConfig(), socketPath: path, out: l => lines.push(l) });
    });
    const said = lines.join(' ');
    assert.match(said, /:3002/);
    assert.ok(!/:13002/.test(said), `printed the internal port: ${said}`);
  });
});
