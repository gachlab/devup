import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
      const ctx: RpcContext = {
        states: () => states,
        restart: async () => {},
        stop: () => {},
        tailLogs: async () => [],
      };
      const handle = await startSocketServer('test', ctx, { path });
      try {
        const st = statSync(path);
        assert.ok(st.isSocket());
        // perms: only the owner can read/write
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
      const ctx: RpcContext = {
        states: () => new Map(),
        restart: async () => {},
        stop: () => {},
        tailLogs: async () => [],
      };
      const handle = await startSocketServer('p', ctx, { path });
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
      const ctx: RpcContext = {
        states: () => states,
        restart: async () => {},
        stop: () => {},
        tailLogs: async () => [],
      };
      const handle = await startSocketServer('s', ctx, { path });
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
      const ctx: RpcContext = {
        states: () => new Map(),
        restart: async (n) => { restarts.push(n); },
        stop: () => {},
        tailLogs: async () => [],
      };
      const handle = await startSocketServer('r', ctx, { path });
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
      const handle = await startSocketServer('u', {
        states: () => new Map(),
        restart: async () => {},
        stop: () => {},
        tailLogs: async () => [],
      }, { path });
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
      const handle = await startSocketServer('t', {
        states: () => new Map(),
        restart: async () => {},
        stop: () => {},
        tailLogs: async (svcName, n) => {
          assert.equal(svcName, 'api');
          return lines.slice(-n);
        },
      }, { path });
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
      const handle = await startSocketServer('a', {
        states: () => new Map(),
        restart: async () => {}, stop: () => {}, tailLogs: async () => [],
      }, { path });
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
      const handle = await startSocketServer('g', {
        states: () => new Map(),
        restart: async () => {}, stop: () => {}, tailLogs: async () => [],
      }, { path });
      try {
        // Send invalid JSON
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
});
