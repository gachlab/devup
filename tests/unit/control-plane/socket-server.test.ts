import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSocketServer, defaultSocketPath, type RpcContext } from '../../../src/control-plane/socket-server.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

const svc: ServiceConfig = { name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0 };
function mkState(over: Partial<ProcessState>): ProcessState {
  return {
    svc, proc: null, pid: null, status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 0,
    ...over,
  };
}
function noopCtx(over: Partial<RpcContext> = {}): RpcContext {
  return {
    states: () => new Map(),
    restart: async () => {},
    stop: () => {},
    tailLogs: async () => [],
    watchLogs: () => () => {},
    watchStatus: () => () => {},
    getStats: async () => ({ services: {}, system: { totalMemMB: 0, freeMemMB: 0, cpuCores: 0 } }),
    getProxyInfo: () => null,
    ...over,
  };
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
        restart: async (n) => { restarts.push(n); },
      }), { path });
      try {
        const res = await rpcCall(path, { method: 'restart', params: { svc: 'foo' } });
        assert.deepEqual(res.result, { ok: true });
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
        tailLogs: async (svcName, n) => {
          assert.equal(svcName, 'api');
          return lines.slice(-n);
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
      let liveCallback: ((svc: string, line: string) => void) | null = null;
      const handle = await startSocketServer('lf', noopCtx({
        tailLogs: async () => ['history-1', 'history-2'],
        watchLogs: (_svc, cb) => {
          liveCallback = cb;
          return () => { liveCallback = null; };
        },
      }), { path });
      try {
        // Expect: ack + 2 tail frames + 1 live frame = 4 total
        const framesP = rpcStream(path, { id: 7, method: 'logs.follow', params: { svc: 'api', tail: 2 } }, 4);

        // Give server a moment to set up the subscription before emitting live.
        await new Promise(r => setTimeout(r, 30));
        liveCallback?.('api', 'live-line');

        const frames = await framesP;
        assert.equal(frames.length, 4);
        assert.deepEqual(frames[0], { id: 7, result: { ok: true } });
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

  it('status.follow sends ack then current snapshot then live updates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sock-'));
    const path = join(dir, 's.sock');
    try {
      let stateCallback: ((name: string, state: ProcessState) => void) | null = null;
      const initial = new Map([['api', mkState({ status: 'running' })]]);
      const handle = await startSocketServer('sf', noopCtx({
        states: () => initial,
        watchStatus: (cb) => {
          stateCallback = cb;
          return () => { stateCallback = null; };
        },
      }), { path });
      try {
        // Expect: ack + snapshot frame + 1 live update = 3 total
        const framesP = rpcStream(path, { id: 3, method: 'status.follow' }, 3);

        await new Promise(r => setTimeout(r, 30));
        stateCallback?.('api', mkState({ status: 'crashed' }));

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
