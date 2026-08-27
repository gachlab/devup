import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSocketServer, defaultSocketPath, METHODS, STREAM_METHODS, type RpcContext } from '../../../src/control-plane/socket-server.js';
import { CONTRACT_VERSION } from '../../../src/control-plane/types.js';
import { readVersion } from '../../../src/utils/version.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

const svc: ServiceConfig = { name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0 };
function mkState(over: Partial<ProcessState>): ProcessState {
  return {
    svc, proc: null, pid: null, status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 0, crashLog: null,
    ...over,
  };
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
    // Was missing, and `tests/` is not typechecked so nothing said so — the
    // daemon answered `ctx.debug is not a function`, which the "advertises
    // every method" check below happily accepted because it only rejected
    // messages saying `unknown method`.
    debug: async () => ({ debug: false, port: null, ok: true }),
    getStats: async () => ({ services: {}, system: { totalMemMB: 0, freeMemMB: 0, cpuCores: 0 } }),
    getProxyInfo: () => null,
    getInfo: () => ({ project: 'test', profiles: {} }),
    // Same rule as `debug` above: a fake that lags the interface fails only at
    // runtime, and only if something happens to call it.
    setRemote: async (_name, envName) => ({
      ok: true,
      remote: envName === null ? null : { envName, target: `https://x.${envName}.test`, readOnly: false },
    }),
  };
  return Object.assign(base, over);
}

function rpcCall(socketPath: string, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const c: Socket = createConnection(socketPath);
    c.on('error', reject);
    const rl = createInterface({ input: c });
    rl.once('line', l => {
      try { resolve(JSON.parse(l)); } catch (e) { reject(e); }
      c.end();
    });
    c.write(JSON.stringify(payload) + '\n');
  });
}

/** Connect and collect multiple newline-delimited JSON frames. */
function rpcStream(socketPath: string, payload: object, frameCount: number, timeoutMs = 2000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const frames: any[] = [];
    const c: Socket = createConnection(socketPath);
    c.on('error', reject);
    const rl = createInterface({ input: c });
    const timer = setTimeout(() => { c.destroy(); resolve(frames); }, timeoutMs);
    rl.on('line', l => {
      try { frames.push(JSON.parse(l)); } catch (e) { reject(e); return; }
      if (frames.length >= frameCount) { clearTimeout(timer); c.destroy(); resolve(frames); }
    });
    c.write(JSON.stringify(payload) + '\n');
  });
}

describe('socket-server', { skip: !isUnix }, () => {
  it('defaultSocketPath sanitizes project name', () => {
    const p = defaultSocketPath('My/Weird Name!');
    assert.ok(p.endsWith('sock-My_Weird_Name_.sock'));
  });

  it('listens on the configured path with 0600 perms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 'test.sock');
    try {
      const states = new Map([['api', mkState({})]]);
      const handle = await startSocketServer('test', noopCtx({ states: () => states }), { path });
      try {
        const st = statSync(path);
        assert.ok(st.isSocket());
        assert.equal(st.mode & 0o777, 0o600);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('responds to ping', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('p', noopCtx(), { path });
      try {
        const res = await rpcCall(path, { id: 1, method: 'ping' });
        assert.equal(res.id, 1);
        assert.equal(res.result.ok, true);
        assert.ok(typeof res.result.ts === 'number');
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status reports originalPort so clients can reach the lazy proxy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      // A lazy service as the orchestrator holds it: rewriteServicePort has
      // already moved `port` to port + LAZY_PORT_OFFSET and kept the configured
      // one. Without originalPort a client cannot tell 13002 from a service
      // genuinely configured on 13002.
      const lazySvc = { ...svc, name: 'auth', port: 13002, originalPort: 3002 } as ServiceConfig;
      const states = new Map([
        ['auth', mkState({ svc: lazySvc })],
        ['api', mkState({})],
      ]);
      const handle = await startSocketServer('s', noopCtx({ states: () => states }), { path });
      try {
        const res = await rpcCall(path, { id: 'x', method: 'status' });
        const byName = Object.fromEntries(res.result.services.map((s: any) => [s.name, s]));
        assert.equal(byName.auth.port, 13002);
        assert.equal(byName.auth.originalPort, 3002);
        // Always-on services are never rewritten, so both fields agree.
        assert.equal(byName.api.port, 3000);
        assert.equal(byName.api.originalPort, 3000);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a non-numeric `lines` rather than reading the whole file', async () => {
    // `Number("abc")` is NaN, and `Math.max(1, Math.min(10_000, NaN))` is NaN,
    // so the reader's cap was never true and the daemon serialised the entire
    // log — up to 10 MB, and now the rotated one too — over the socket.
    const dir = mkdtempSync(join(tmpdir(), 'devup-lines-'));
    const path = join(dir, 's.sock');
    try {
      let askedFor: number | undefined;
      const handle = await startSocketServer('l', noopCtx({
        tailLogs: async (_svc, o) => { askedFor = o.lines; return { lines: [], oldestRetained: null, truncated: false }; },
      }), { path });
      try {
        for (const bad of ['abc', 2.5, 0, -1, null]) {
          const res = await rpcCall(path, { method: 'logs.tail', params: { svc: 'api', lines: bad } });
          if (bad === null) {
            // null means "not given" — the default still applies.
            assert.equal(res.error, undefined);
            assert.equal(askedFor, 100);
            continue;
          }
          assert.match(res.error?.message ?? '', /"lines" must be a positive integer/, `accepted ${bad}`);
        }
        // And it still clamps a huge one instead of refusing it.
        await rpcCall(path, { method: 'logs.tail', params: { svc: 'api', lines: 50_000 } });
        assert.equal(askedFor, 10_000);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs.follow replays a window when asked for one', async () => {
    // `--since` alongside `--follow` was advertised and then dropped, which is
    // the quiet wrong window this whole change is against.
    const dir = mkdtempSync(join(tmpdir(), 'devup-fsince-'));
    const path = join(dir, 's.sock');
    try {
      let asked: { lines: number; since?: number } | null = null;
      const handle = await startSocketServer('f', noopCtx({
        tailLogs: async (_svc, o) => { asked = o; return { lines: ['replayed'], oldestRetained: null, truncated: false }; },
      }), { path });
      try {
        const frames = await rpcStream(path, { id: 1, method: 'logs.follow', params: { svc: 'api', tail: 7, since: 1755800000000 } }, 2, 1500);
        assert.deepEqual(asked, { lines: 7, since: 1755800000000 });
        assert.equal(frames[1]?.data, 'replayed');
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a non-numeric `tail` instead of skipping the replay in silence', async () => {
    // `Number("abc")` is NaN and `NaN > 0` is false, so the replay was skipped
    // without a word: the client got its ack and an empty backlog, with
    // nothing to say why.
    const dir = mkdtempSync(join(tmpdir(), 'devup-tail-'));
    const path = join(dir, 's.sock');
    try {
      let replayed = false;
      const handle = await startSocketServer('t', noopCtx({
        tailLogs: async () => { replayed = true; return { lines: ['x'], oldestRetained: null, truncated: false }; },
      }), { path });
      try {
        const frames = await rpcStream(path, { id: 1, method: 'logs.follow', params: { svc: 'api', tail: 'abc' } }, 1, 1200);
        assert.match(frames[0]?.error?.message ?? '', /"tail" must be a non-negative integer/);
        assert.equal(replayed, false);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a queued auto-restart as remaining milliseconds', async () => {
    // Relative, not absolute: a client comparing the daemon's clock against
    // its own is wrong by whatever they disagree on, and every consumer would
    // have to do that subtraction.
    const dir = mkdtempSync(join(tmpdir(), 'devup-pending-'));
    const path = join(dir, 's.sock');
    try {
      const states = new Map([
        ['queued', mkState({ svc: { ...svc, name: 'queued' }, status: 'crashed', restartPendingUntil: Date.now() + 8_000 })],
        ['done', mkState({ svc: { ...svc, name: 'done' }, status: 'crashed', restartPendingUntil: null })],
      ]);
      const handle = await startSocketServer('p', noopCtx({ states: () => states }), { path });
      try {
        const res = await rpcCall(path, { method: 'status' });
        const byName = Object.fromEntries(res.result.services.map((s: any) => [s.name, s]));
        assert.ok(byName.queued.restartPendingIn > 6_000 && byName.queued.restartPendingIn <= 8_000,
          `expected ~8000ms, got ${byName.queued.restartPendingIn}`);
        assert.equal(byName.done.restartPendingIn, null);
      } finally { await handle.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never reports a negative wait for an overdue restart', async () => {
    // The timer can be late; a negative number would read as nonsense.
    const dir = mkdtempSync(join(tmpdir(), 'devup-overdue-'));
    const path = join(dir, 's.sock');
    try {
      const states = new Map([['api', mkState({ status: 'crashed', restartPendingUntil: Date.now() - 5_000 })]]);
      const handle = await startSocketServer('o', noopCtx({ states: () => states }), { path });
      try {
        const res = await rpcCall(path, { method: 'status' });
        assert.equal(res.result.services[0].restartPendingIn, 0);
      } finally { await handle.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('logs.follow ack says the replayed window lost its beginning', async () => {
    // Without this the CLI had to ask `logs.tail` a second time purely to find
    // out, reading the same file twice per `--since ... --follow`.
    const dir = mkdtempSync(join(tmpdir(), 'devup-ackwin-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('a', noopCtx({
        tailLogs: async () => ({ lines: ['x'], oldestRetained: 1755800000000, truncated: true }),
      }), { path });
      try {
        const frames = await rpcStream(path, { id: 1, method: 'logs.follow', params: { svc: 'api', tail: 5, since: 1755000000000 } }, 1, 1500);
        assert.equal(frames[0]?.result?.oldestRetained, 1755800000000);
        assert.equal(frames[0]?.result?.truncated, true);
      } finally { await handle.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('omits the window fields when no replay was asked for', async () => {
    // `tail: 0` means "just the live stream"; there is no window to describe,
    // and inventing one would have a client believe it lost data it never
    // asked for.
    const dir = mkdtempSync(join(tmpdir(), 'devup-nowin-'));
    const path = join(dir, 's.sock');
    try {
      let read = false;
      const handle = await startSocketServer('n', noopCtx({
        tailLogs: async () => { read = true; return { lines: [], oldestRetained: null, truncated: false }; },
      }), { path });
      try {
        const frames = await rpcStream(path, { id: 1, method: 'logs.follow', params: { svc: 'api', tail: 0 } }, 1, 1500);
        assert.deepEqual(frames[0]?.result, { ok: true });
        assert.equal(read, false, 'and the log is not read at all');
      } finally { await handle.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('status returns a snapshot of every service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const states = new Map([
        ['api', mkState({ status: 'running', health: 'up', errors: 0, restarts: 1 })],
        ['web', mkState({ svc: { ...svc, name: 'web', type: 'web', port: 4000 }, status: 'starting', health: 'wait' })],
      ]);
      const handle = await startSocketServer('s', noopCtx({ states: () => states }), { path });
      try {
        const res = await rpcCall(path, { id: 'x', method: 'status' });
        assert.equal(res.result.services.length, 2);
        const byName = Object.fromEntries(res.result.services.map((s: any) => [s.name, s]));
        assert.equal(byName.api.status, 'running');
        assert.equal(byName.api.restarts, 1);
        assert.equal(byName.web.status, 'starting');
        assert.equal(byName.web.type, 'web');
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restart calls the context handler with the service name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const restarts: string[] = [];
      const handle = await startSocketServer('r', noopCtx({
        restart: async (n) => { restarts.push(n); return { ok: true, skippedIdle: false }; },
      }), { path });
      try {
        const res = await rpcCall(path, { method: 'restart', params: { svc: 'foo' } });
        // `ok` is the outcome now, as it is for `start`: a lazy service
        // restarted through its proxy can fail to come back, and answering
        // `true` regardless hands a client a tick over a dead service.
        assert.deepEqual(res.result, { ok: true, skippedIdle: false });
        assert.deepEqual(restarts, ['foo']);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns error on unknown method', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('u', noopCtx(), { path });
      try {
        const res = await rpcCall(path, { id: 9, method: 'mystery' });
        assert.equal(res.id, 9);
        assert.ok(res.error.message.includes('unknown method'));
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs.tail returns the last N lines from the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const lines = ['a', 'b', 'c', 'd', 'e'];
      const handle = await startSocketServer('t', noopCtx({
        tailLogs: async (svcName, o) => {
          assert.equal(svcName, 'api');
          return { lines: lines.slice(-o.lines), oldestRetained: null, truncated: false };
        },
      }), { path });
      try {
        const res = await rpcCall(path, { method: 'logs.tail', params: { svc: 'api', lines: 3 } });
        assert.deepEqual(res.result.lines, ['c', 'd', 'e']);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close() removes the socket file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('a', noopCtx(), { path });
      assert.ok(statSync(path).isSocket());
      await handle.close();
      assert.throws(() => statSync(path), { code: 'ENOENT' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns parse error on garbage input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('g', noopCtx(), { path });
      try {
        const res = await new Promise<any>((resolve, reject) => {
          const c = createConnection(path);
          const rl = createInterface({ input: c });
          rl.once('line', l => { try { resolve(JSON.parse(l)); } catch (e) { reject(e); } c.end(); });
          c.write('not json{\n');
        });
        assert.equal(res.error.code, -32700);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Streaming ────────────────────────────────────────────────────────────

  it('logs.follow sends ack then replays tail then streams live lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      // A no-op default rather than `| null`: TypeScript narrows a `let` that is
      // only visibly assigned `null` down to `null`, and the assignment that
      // matters happens inside the subscribe callback, which it cannot see.
      let liveCallback: (svc: string, line: string) => void = () => {};
      const handle = await startSocketServer('lf', noopCtx({
        tailLogs: async () => ({ lines: ['history-1', 'history-2'], oldestRetained: null, truncated: false }),
        watchLogs: (_svc, cb) => {
          liveCallback = cb;
          return () => { liveCallback = () => {}; };
        },
      }), { path });
      try {
        // Expect: ack + 2 tail frames + 1 live frame = 4 total
        const framesP = rpcStream(path, { id: 7, method: 'logs.follow', params: { svc: 'api', tail: 2 } }, 4);

        // Give server a moment to set up the subscription before emitting live.
        await new Promise(r => setTimeout(r, 30));
        liveCallback('api', 'live-line');

        const frames = await framesP;
        assert.equal(frames.length, 4);
        // The ack carries what the replayed window turned out to be, so a
        // follow can say whether it lost its beginning without the caller
        // asking the daemon a second time.
        assert.deepEqual(frames[0], { id: 7, result: { ok: true, oldestRetained: null, truncated: false } });
        assert.equal(frames[1].event, 'log');
        assert.equal(frames[1].data, 'history-1');
        assert.equal(frames[2].data, 'history-2');
        assert.equal(frames[3].data, 'live-line');
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status.follow announces a service that left the set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      // A no-op default rather than `| null`: TypeScript narrows a `let` that is
      // only visibly assigned `null` down to `null`, and the assignment that
      // matters happens inside the subscribe callback, which it cannot see.
      let removedCallback: (name: string) => void = () => {};
      const initial = new Map([['api', mkState({ status: 'running' })]]);
      const handle = await startSocketServer('sf', noopCtx({
        states: () => initial,
        watchRemoved: (cb) => {
          removedCallback = cb;
          return () => { removedCallback = () => {}; };
        },
      }), { path });
      try {
        // ack + snapshot + removal = 3
        const framesP = rpcStream(path, { id: 4, method: 'status.follow' }, 3);
        await new Promise(r => setTimeout(r, 30));
        removedCallback('api');

        const frames = await framesP;
        assert.equal(frames[2].event, 'removed');
        assert.deepEqual(frames[2].data, ['api']);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status.follow sends an empty snapshot rather than nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      // With no frame at all, a client cannot tell "connected, nothing
      // configured" from "still waiting for the first update".
      const handle = await startSocketServer('sf', noopCtx({ states: () => new Map() }), { path });
      try {
        const frames = await rpcStream(path, { id: 5, method: 'status.follow' }, 2);
        assert.deepEqual(frames[0], { id: 5, result: { ok: true } });
        assert.equal(frames[1].event, 'status');
        assert.deepEqual(frames[1].data, []);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status.follow sends ack then current snapshot then live updates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      // A no-op default rather than `| null`: TypeScript narrows a `let` that is
      // only visibly assigned `null` down to `null`, and the assignment that
      // matters happens inside the subscribe callback, which it cannot see.
      let stateCallback: (name: string, state: ProcessState) => void = () => {};
      const initial = new Map([['api', mkState({ status: 'running' })]]);
      const handle = await startSocketServer('sf', noopCtx({
        states: () => initial,
        watchStatus: (cb) => {
          stateCallback = cb;
          return () => { stateCallback = () => {}; };
        },
      }), { path });
      try {
        // Expect: ack + snapshot frame + 1 live update = 3 total
        const framesP = rpcStream(path, { id: 3, method: 'status.follow' }, 3);

        await new Promise(r => setTimeout(r, 30));
        stateCallback('api', mkState({ status: 'crashed' }));

        const frames = await framesP;
        assert.equal(frames.length, 3);
        assert.deepEqual(frames[0], { id: 3, result: { ok: true } });
        assert.equal(frames[1].event, 'status');
        assert.equal(frames[1].data[0].status, 'running');
        assert.equal(frames[2].event, 'status');
        assert.equal(frames[2].data[0].status, 'crashed');
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close() destroys streaming clients (does not hang on open follow subscriptions)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('streamclose', noopCtx({
        watchLogs: () => () => {},
      }), { path });

      // Open a logs.follow subscription that would otherwise hold the socket open forever.
      const c = createConnection(path);
      await new Promise<void>(r => c.on('connect', r));
      c.write(JSON.stringify({ id: 1, method: 'logs.follow', params: { svc: 'x' } }) + '\n');
      // Wait briefly so the server registers the handler.
      await new Promise(r => setTimeout(r, 50));

      // close() must complete promptly even with an active streaming client.
      const start = Date.now();
      await Promise.race([
        handle.close(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('close() hung')), 2000)),
      ]);
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2000, `close() should complete fast; took ${elapsed}ms`);
      try { c.destroy(); } catch { /* already gone */ }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status includes crashLog when service is crashed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const states = new Map([
        ['api', mkState({ status: 'crashed', crashLog: ['error: ENOENT', 'segfault'] })],
      ]);
      const handle = await startSocketServer('cl', noopCtx({ states: () => states }), { path });
      try {
        const res = await rpcCall(path, { id: 1, method: 'status' });
        assert.deepEqual(res.result.services[0].crashLog, ['error: ENOENT', 'segfault']);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status includes phase per service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const states = new Map([
        ['api', mkState({ svc: { ...svc, phase: 2 } })],
      ]);
      const handle = await startSocketServer('ph', noopCtx({ states: () => states }), { path });
      try {
        const res = await rpcCall(path, { id: 1, method: 'status' });
        assert.equal(res.result.services[0].phase, 2);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('info returns project name and profiles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const profiles = { backend: ['api', 'db'], frontend: ['web'] };
      const handle = await startSocketServer('inf', noopCtx({
        getInfo: () => ({ project: 'my-stack', profiles }),
      }), { path });
      try {
        const res = await rpcCall(path, { id: 1, method: 'info' });
        assert.equal(res.result.project, 'my-stack');
        assert.deepEqual(res.result.profiles, profiles);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stats returns per-service and system shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('stats', noopCtx({
        getStats: async () => ({
          services: { api: { cpu: 1.5, memMB: 200 }, web: { cpu: 0, memMB: 0 } },
          system: { totalMemMB: 16384, freeMemMB: 8000, cpuCores: 8 },
        }),
      }), { path });
      try {
        const res = await rpcCall(path, { id: 1, method: 'stats' });
        assert.equal(res.result.services.api.cpu, 1.5);
        assert.equal(res.result.services.api.memMB, 200);
        assert.equal(res.result.services.web.cpu, 0);
        assert.equal(res.result.system.cpuCores, 8);
        assert.ok(res.result.system.totalMemMB > 0);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status includes proxy: null when no proxy active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('prx', noopCtx({ getProxyInfo: () => null }), { path });
      try {
        const res = await rpcCall(path, { id: 1, method: 'status' });
        assert.equal(res.result.proxy, null);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status includes proxy info when proxy is active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      const proxy = { active: true, provider: 'traefik', domain: 'localhost', tls: false, routes: { 'app-web': '' } };
      const handle = await startSocketServer('prx2', noopCtx({ getProxyInfo: () => proxy }), { path });
      try {
        const res = await rpcCall(path, { id: 1, method: 'status' });
        assert.deepEqual(res.result.proxy, proxy);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs.follow unsubscribes when socket closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      let unsubCalled = false;
      const handle = await startSocketServer('lu', noopCtx({
        watchLogs: () => () => { unsubCalled = true; },
      }), { path });
      try {
        const c = createConnection(path);
        await new Promise<void>(r => c.on('connect', r));
        c.write(JSON.stringify({ id: 1, method: 'logs.follow', params: { svc: 'api' } }) + '\n');
        // Wait for ack then close.
        await new Promise<void>(r => {
          const rl = createInterface({ input: c });
          rl.once('line', () => { c.destroy(); setTimeout(r, 50); });
        });
        assert.ok(unsubCalled, 'unsub should be called on socket close');
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('info tells a client what the daemon is', { skip: !isUnix }, () => {
  it('carries the version, the contract and the method list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-info-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('i', noopCtx({
        getInfo: () => ({ project: 'Guesthub', profiles: { e2e: ['app-api'] } }),
      }), { path });
      try {
        const res = await rpcCall(path, { id: 1, method: 'info' });
        // Still everything it used to say.
        assert.equal(res.result.project, 'Guesthub');
        assert.deepEqual(res.result.profiles, { e2e: ['app-api'] });
        // And what it is.
        assert.equal(res.result.version, readVersion());
        assert.match(res.result.version, /^\d+\.\d+\.\d+/, 'a real version, not "unknown"');
        assert.equal(res.result.contract, CONTRACT_VERSION);
        assert.ok(Array.isArray(res.result.methods));
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('composes those three itself, so the two getInfo implementations cannot drift', async () => {
    // `getInfo` is written twice — once in the daemon, once in the TUI's
    // control plane — and they have drifted before. Anything identical for
    // every daemon of a given build is added here, not asked of either.
    const dir = mkdtempSync(join(tmpdir(), 'devup-info2-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('i', noopCtx({
        getInfo: () => ({ project: 'p', profiles: {} }),   // says nothing about version
      }), { path });
      try {
        const res = await rpcCall(path, { id: 1, method: 'info' });
        assert.ok(res.result.version, 'the server fills it in');
        assert.ok(res.result.methods.length > 0);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('advertises every method it can actually answer, and no others', async () => {
    // The point of building METHODS from the handler map: a method added
    // without being advertised is what makes clients probe for `unknown
    // method` in the first place. Every name here is called for real.
    const dir = mkdtempSync(join(tmpdir(), 'devup-methods-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('m', noopCtx({
        states: () => new Map([['api', mkState({})]]),
        tailLogs: async () => ({ lines: [], oldestRetained: null, truncated: false }),
      }), { path });
      try {
        const advertised = (await rpcCall(path, { id: 1, method: 'info' })).result.methods as string[];
        assert.deepEqual(advertised, METHODS);
        // `svc` covers most of them; `remote` also needs to be told which way
        // to go, and refusing a call that says neither is the point of that
        // handler rather than an accident to work around.
        const extraParams: Record<string, Record<string, unknown>> = { remote: { local: true } };
        for (const method of advertised) {
          const res = await rpcCall(path, {
            id: 2, method, params: { svc: 'api', ...(extraParams[method] ?? {}) },
          });
          // Any error at all, not just `unknown method`: a fake missing a
          // member answers `ctx.X is not a function`, which is just as much a
          // method the daemon cannot serve.
          assert.equal(
            res.error, undefined,
            `advertised "${method}" but calling it failed: ${JSON.stringify(res.error)}`,
          );
        }
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still refuses a method it does not have', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-nom-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('n', noopCtx(), { path });
      try {
        const res = await rpcCall(path, { id: 1, method: 'teleport' });
        assert.match(res.error.message, /unknown method: teleport/);
        assert.ok(!METHODS.includes('teleport'));
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses Object.prototype members too, which a plain object would answer', async () => {
    // The method name comes off the wire. With the handler table as a plain
    // object, `{"method":"toString"}` found Object.prototype.toString, called
    // it, and answered `"[object Undefined]"`; `"constructor"` echoed the
    // params back. Both looked like real results to a client, and neither is
    // in `info.methods` — so the daemon contradicted its own advertisement.
    const dir = mkdtempSync(join(tmpdir(), 'devup-proto-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('p', noopCtx(), { path });
      try {
        for (const method of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', '__proto__']) {
          const res = await rpcCall(path, { id: 1, method });
          assert.equal(res.result, undefined, `${method} answered with a result: ${JSON.stringify(res)}`);
          assert.equal(
            res.error?.message, `unknown method: ${method}`,
            `${method} was not reported as unknown: ${JSON.stringify(res)}`,
          );
          assert.ok(!METHODS.includes(method));
        }
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes the streaming methods off the same list it advertises', async () => {
    // Two hand-kept copies of these names is the drift the handler table was
    // introduced to remove: a daemon answering a method it does not advertise
    // makes a client checking `info.methods` refuse a feature that works.
    const dir = mkdtempSync(join(tmpdir(), 'devup-str-'));
    const path = join(dir, 's.sock');
    try {
      const handle = await startSocketServer('s', noopCtx({ states: () => new Map() }), { path });
      try {
        for (const method of STREAM_METHODS) {
          // A streaming method acks and then holds the socket open; a
          // dispatched one would answer `unknown method` instead.
          const frames = await rpcStream(path, { id: 1, method, params: { svc: 'api' } }, 1, 1500);
          assert.equal(frames[0]?.error, undefined, `${method} was not routed as a stream`);
          // `status.follow` acks bare; `logs.follow` adds the window fields
          // when it replayed one, so only `ok` is common to both.
          assert.equal(frames[0]?.result?.ok, true);
        }
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes the streaming methods, which are handled before dispatch', async () => {
    // They never reach the handler map, so they are the ones most likely to be
    // left out of a hand-maintained list.
    assert.ok(METHODS.includes('logs.follow'));
    assert.ok(METHODS.includes('status.follow'));
  });
});

/** A server on a throwaway socket, with its own cleanup. The existing tests
 *  each build this inline; the `remote` block below has five of them. */
async function tmpServer(ctx: RpcContext): Promise<{ path: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
  const path = join(dir, 's.sock');
  const handle = await startSocketServer('remote-test', ctx, { path });
  return {
    path,
    close: async () => {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// `{ skip: !isUnix }` like every other block here: `startSocketServer` binds a
// Unix socket by filesystem path, which Windows answers with EACCES — it wants
// a named pipe. Every describe in this file needs the guard, and this one
// shipped without it.
describe('remote', { skip: !isUnix }, () => {
  it('switches a service to an environment', async () => {
    const { path, close } = await tmpServer(noopCtx());
    try {
      const res = await rpcCall(path, { id: 1, method: 'remote', params: { svc: 'app-api', env: 'qa' } });
      assert.equal(res.result.ok, true);
      assert.equal(res.result.remote.envName, 'qa');
    } finally { await close(); }
  });

  it('brings one back with local: true', async () => {
    const { path, close } = await tmpServer(noopCtx());
    try {
      const res = await rpcCall(path, { id: 1, method: 'remote', params: { svc: 'app-api', local: true } });
      assert.equal(res.result.ok, true);
      assert.equal(res.result.remote, null);
    } finally { await close(); }
  });

  it('rejects a call that names neither', async () => {
    // Not a no-op reported as success: a caller that meant one and sent
    // neither would only find out when traffic went somewhere unexpected.
    const { path, close } = await tmpServer(noopCtx());
    try {
      const res = await rpcCall(path, { id: 1, method: 'remote', params: { svc: 'app-api' } });
      assert.match(res.error.message, /either "env" or "local"/);
    } finally { await close(); }
  });

  it('rejects a call that names both', async () => {
    const { path, close } = await tmpServer(noopCtx());
    try {
      const res = await rpcCall(path, { id: 1, method: 'remote', params: { svc: 'a', env: 'qa', local: true } });
      assert.match(res.error.message, /not both/);
    } finally { await close(); }
  });

  it('passes a failed switch back as a result, not as an RPC error', async () => {
    // Every way this fails is a fact about the stack worth showing — the
    // environment does not exist, the port is still held. An RPC error would
    // read as "devup is broken".
    const { path, close } = await tmpServer(noopCtx({
      setRemote: async () => ({ ok: false, remote: null, error: 'unknown environment: "prod"' }),
    }));
    try {
      const res = await rpcCall(path, { id: 1, method: 'remote', params: { svc: 'a', env: 'prod' } });
      assert.equal(res.error, undefined);
      assert.equal(res.result.ok, false);
      assert.match(res.result.error, /unknown environment/);
    } finally { await close(); }
  });
});
