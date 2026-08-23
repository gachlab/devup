import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createClient, createClientForProject, resolveSocket, assertSocketExists,
  sendRpc, openStream, defaultSocketPath,
} from '../../../src/control-plane/client.js';
import { startSocketServer, type RpcContext } from '../../../src/control-plane/socket-server.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

const svc: ServiceConfig = { name: 'api', cwd: 'app/api', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0 };

function mkState(over: Partial<ProcessState> = {}): ProcessState {
  return {
    svc, proc: null, pid: null, status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 0, crashLog: null,
    ...over,
  };
}

function noopCtx(over: Partial<RpcContext> = {}): RpcContext {
  return {
    states: () => new Map(),
    restart: async () => ({ ok: true, skippedIdle: false }),
    stop: () => {},
    tailLogs: async () => ({ lines: [], oldestRetained: null, truncated: false }),
    watchLogs: () => () => {},
    watchStatus: () => () => {},
    watchRemoved: () => () => {},
    debug: async () => ({ debug: true, port: 39481, ok: true }),
    start: async () => true,
    getStats: async () => ({ services: {}, system: { totalMemMB: 0, freeMemMB: 0, cpuCores: 0 } }),
    getProxyInfo: () => null,
    getInfo: () => ({ project: 'test', profiles: {} }),
    ...over,
  };
}

/** Run `fn` against a live control plane in a throwaway directory. */
async function withServer(
  ctx: Partial<RpcContext>,
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'devup-client-'));
  const path = join(dir, 's.sock');
  try {
    const handle = await startSocketServer('test', noopCtx(ctx), { path });
    try { await fn(path); } finally { await handle.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A socket that speaks no protocol at all, for the failure paths. */
async function withRawServer(
  onConnect: (socket: import('node:net').Socket) => void,
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'devup-raw-'));
  const path = join(dir, 's.sock');
  // Every accepted socket is tracked: server.close() waits for open
  // connections, and these tests deliberately leave some hanging.
  const open = new Set<import('node:net').Socket>();
  const server: Server = createServer(sock => {
    open.add(sock);
    sock.once('close', () => open.delete(sock));
    onConnect(sock);
  });
  try {
    await new Promise<void>(r => server.listen(path, r));
    await fn(path);
  } finally {
    for (const sock of open) sock.destroy();
    await new Promise<void>(r => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reject rather than hang if `p` never settles.
 *
 *  The tests below are about promises that must not be left pending. Leaning
 *  on the runner's own timeout instead would leave the socket server listening
 *  and the whole run hanging, which is a useless failure to read. */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${what} never settled within ${ms}ms`)), ms);
      t.unref();
    }),
  ]);
}

describe('control-plane client', { skip: !isUnix }, () => {
  it('resolveSocket prefers the override over the default location', () => {
    assert.equal(resolveSocket('Proj', '/tmp/other.sock'), '/tmp/other.sock');
    assert.equal(resolveSocket('Proj'), defaultSocketPath('Proj'));
  });

  it('assertSocketExists names the project so the message is actionable', () => {
    assert.throws(
      () => assertSocketExists(join(tmpdir(), 'devup-does-not-exist.sock'), 'Guesthub'),
      /Guesthub/,
    );
  });

  it('status() returns both ports typed, without the caller casting', async () => {
    // The point of the export: a consumer reads originalPort off a typed
    // object instead of re-declaring the snapshot shape by hand.
    const lazySvc = { ...svc, name: 'auth', port: 13002, originalPort: 3002 } as ServiceConfig;
    const states = new Map([
      ['auth', mkState({ svc: lazySvc, status: 'idle', health: 'idle' })],
      ['api', mkState({ pid: 4242 })],
    ]);
    await withServer({ states: () => states }, async path => {
      const res = await createClient(path).status();
      const auth = res.services.find(s => s.name === 'auth')!;
      assert.equal(auth.port, 13002);
      assert.equal(auth.originalPort, 3002);
      assert.equal(auth.health, 'idle');
      assert.equal(res.proxy, null);
    });
  });

  it('start() surfaces the daemon\'s outcome, not an acknowledgement', async () => {
    await withServer({ start: async () => false }, async path => {
      const res = await createClient(path).start('api');
      assert.equal(res.ok, false);
    });
  });

  it('logsTail() passes the service and line count through untouched', async () => {
    const asked: Array<[string, number]> = [];
    await withServer({ tailLogs: async (name, o) => { asked.push([name, o.lines]); return { lines: ['a'], oldestRetained: null, truncated: false }; } }, async path => {
      const c = createClient(path);
      // Omitting `lines` must leave the daemon's own default (100) in charge —
      // a second copy of it in the client is one more thing to drift.
      await c.logsTail('api');
      await c.logsTail('web', { lines: 7 });
      assert.deepEqual(asked, [['api', 100], ['web', 7]]);
    });
  });

  it('debug() carries enable, port and brk through to the daemon', async () => {
    const seen: Array<{ enable: boolean; port: number | undefined; brk: boolean }> = [];
    await withServer({
      debug: async (_n, enable, port, brk) => { seen.push({ enable, port, brk: brk === true }); return { debug: enable, port: port ?? null, ok: true }; },
    }, async path => {
      const c = createClient(path);
      // Omitted options leave the daemon's defaults in charge (enable true,
      // OS-chosen port, no brk); explicit ones must survive the trip.
      await c.debug('api');
      await c.debug('api', { enable: false });
      await c.debug('api', { port: 9230, brk: true });
      assert.deepEqual(seen, [
        { enable: true, port: undefined, brk: false },
        { enable: false, port: undefined, brk: false },
        { enable: true, port: 9230, brk: true },
      ]);
    });
  });

  it('reports a connection failure once, not once per listener', { timeout: 5000 }, async () => {
    // Readline re-forwards its input's 'error', so one ENOENT reaches both
    // handlers. A consumer that reconnects from onError would open two
    // connections per failure and double them on every retry.
    const dir = mkdtempSync(join(tmpdir(), 'devup-gone-'));
    try {
      let calls = 0;
      openStream(join(dir, 'nothing.sock'), 'status.follow', {}, () => {}, () => { calls++; });
      await new Promise(r => setTimeout(r, 300));
      assert.equal(calls, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tells a stream consumer when the daemon goes away', { timeout: 5000 }, async () => {
    // `devup down` destroys every client socket, and over a Unix socket that
    // is a clean EOF — no 'error' fires. Without onClose a long-lived consumer
    // goes stale across a daemon restart with nothing at all to react to.
    const closed = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('onClose never fired')), 3000);
      void withServer({}, async path => {
        createClient(path).followStatus(() => {}, {
          onClose: () => { clearTimeout(timer); resolve(true); },
          onError: err => { clearTimeout(timer); reject(err); },
        });
        // Let the stream establish, then take the daemon down under it.
        await new Promise(r => setTimeout(r, 200));
      });
    });
    assert.equal(closed, true);
  });

  it('reports a rejected stream request once, not as an error and a close', { timeout: 5000 }, async () => {
    // The daemon refuses the request (svc must be a non-empty string) and the
    // client destroys the socket — which is a close it caused itself. Reported
    // as both, a consumer following the documented shape (report on error,
    // reconnect on close) opens a reconnection for a request that was simply
    // refused.
    await withServer({}, async path => {
      let errors = 0, closes = 0;
      openStream(path, 'logs.follow', { svc: 123 }, () => {}, () => { errors++; }, () => { closes++; });
      await new Promise(r => setTimeout(r, 400));
      assert.equal(errors, 1);
      assert.equal(closes, 0);
    });
  });

  it('surfaces an error frame that arrives after the ack', { timeout: 5000 }, async () => {
    // The daemon acks `logs.follow` *before* it reads the log file, so a
    // failure in that read answers with an error frame and never registers the
    // watcher: the stream is dead. A client that only looks for `event` drops
    // the frame and waits for ever on a socket that will never speak again —
    // the exact silence onError and onClose exist to end.
    const failing = { tailLogs: async () => { throw new Error('disk on fire'); } };
    await withServer(failing, async path => {
      const seen = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('nothing was reported at all')), 3000);
        openStream(path, 'logs.follow', { svc: 'api', tail: 5 }, () => {},
          err => { clearTimeout(timer); resolve(err.message); });
      });
      assert.match(seen, /disk on fire/);
    });
  });

  it('does not report a close for a stream the caller aborted', { timeout: 5000 }, async () => {
    // Otherwise a caller replacing its subscription tears down the
    // replacement: it reads its own abort as the daemon vanishing.
    await withServer({}, async path => {
      let closes = 0;
      const abort = createClient(path).followStatus(() => {}, { onClose: () => { closes++; } });
      await new Promise(r => setTimeout(r, 150));
      abort();
      await new Promise(r => setTimeout(r, 200));
      assert.equal(closes, 0);
    });
  });

  it('a per-call timeout overrides the client-wide one, undefined included', { timeout: 8000 }, async () => {
    // The escape hatch for `restart` and `debug` under a client-wide timeout:
    // they restart a service and the daemon carries on regardless of whether
    // anyone is still listening.
    await withRawServer(sock => {
      sock.once('data', () => setTimeout(() => sock.write(JSON.stringify({ id: 1, result: { ok: true } }) + '\n'), 400));
    }, async path => {
      const c = createClient(path, { timeoutMs: 120 });
      await assert.rejects(withDeadline(c.status(), 2000, 'status()'), /within 120ms/);
      const res = await withDeadline(c.restart('api', { timeoutMs: undefined }), 3000, 'restart()');
      assert.equal(res.ok, true);
    });
  });

  it('followStatus() delivers the full snapshot before any change', async () => {
    // The daemon sends every service right after the ack — a client does not
    // have to wait for a state change to have something to render.
    const states = new Map([['api', mkState({ pid: 1 })], ['web', mkState({ svc: { ...svc, name: 'web', type: 'web', port: 4200 } })]]);
    await withServer({ states: () => states }, async path => {
      const names = await new Promise<string[]>((resolve, reject) => {
        const timer = setTimeout(() => { abort(); reject(new Error('no snapshot frame arrived')); }, 3000);
        const abort = createClient(path).followStatus(frame => {
          if (frame.event !== 'status') return;
          clearTimeout(timer);
          abort();
          resolve((frame.data as Array<{ name: string }>).map(s => s.name));
        }, { onError: err => { clearTimeout(timer); reject(err); } });
      });
      assert.deepEqual(names.sort(), ['api', 'web']);
    });
  });

  it('rejects when the daemon closes without answering', { timeout: 5000 }, async () => {
    // A daemon killed mid-request sends no line at all. Without a `close`
    // handler the promise never settles and the caller waits for ever — the
    // failure a test harness can least afford.
    // Destroy only once the request is in: destroying on connect races the
    // write and surfaces as EPIPE instead, which is a different path.
    await withRawServer(sock => sock.once('data', () => sock.destroy()), async path => {
      await assert.rejects(
        withDeadline(sendRpc(path, 'status'), 2000, 'sendRpc'),
        /closed before the daemon answered/,
      );
    });
  });

  it('rejects on timeoutMs when the daemon accepts but never answers', { timeout: 5000 }, async () => {
    await withRawServer(() => { /* accept and say nothing, for ever */ }, async path => {
      await assert.rejects(
        withDeadline(sendRpc(path, 'status', {}, { timeoutMs: 120 }), 2000, 'sendRpc'),
        /did not answer "status" within 120ms/,
      );
    });
  });

  it('waits indefinitely when no timeout is set', { timeout: 5000 }, async () => {
    // The default has to stay "no timeout": `debug` and `restart` restart a
    // service and a slow pre-build is not a dead daemon.
    await withRawServer(sock => { setTimeout(() => sock.write(JSON.stringify({ id: 1, result: { ok: true } }) + '\n'), 400); }, async path => {
      const res = await sendRpc(path, 'ping') as { ok: boolean };
      assert.equal(res.ok, true);
    });
  });

  it('a client-wide timeout applies to every one-shot call', { timeout: 5000 }, async () => {
    await withRawServer(() => {}, async path => {
      await assert.rejects(
        withDeadline(createClient(path, { timeoutMs: 120 }).status(), 2000, 'status()'),
        /within 120ms/,
      );
    });
  });

  it('createClientForProject resolves the default socket for a project name', () => {
    assert.equal(createClientForProject('Guesthub').socketPath, defaultSocketPath('Guesthub'));
    assert.equal(createClientForProject('Guesthub', { socketPath: '/tmp/x.sock' }).socketPath, '/tmp/x.sock');
  });

  it('surfaces an RPC error as a rejection carrying the daemon message', async () => {
    await withServer({}, async path => {
      await assert.rejects(createClient(path).call('nope'), /unknown method: nope/);
    });
  });
});
