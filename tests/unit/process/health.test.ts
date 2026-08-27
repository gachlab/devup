import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { checkPort, isPortBindable, waitForPort, deriveHealth, checkHttp, checkHealth } from '../../../src/process/health.js';

describe('checkPort', () => {
  it('returns true for open port', async () => {
    const server = net.createServer();
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      assert.equal(await checkPort(port), true);
    } finally {
      server.close();
    }
  });

  it('returns false for closed port', async () => {
    assert.equal(await checkPort(19999), false);
  });
});

describe('isPortBindable', () => {
  it('returns true for a free port', async () => {
    const probe = net.createServer();
    await new Promise<void>(r => probe.listen(0, r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>(r => probe.close(() => r()));
    assert.equal(await isPortBindable(port), true);
  });

  it('returns false when another server holds the port', async () => {
    const occupier = net.createServer();
    await new Promise<void>(r => occupier.listen(0, '0.0.0.0', r));
    const port = (occupier.address() as net.AddressInfo).port;
    try {
      assert.equal(await isPortBindable(port), false);
    } finally {
      await new Promise<void>(r => occupier.close(() => r()));
    }
  });

});

describe('waitForPort', () => {
  it('resolves true when port opens', async () => {
    const server = net.createServer();
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      assert.equal(await waitForPort(port, { timeout: 2000, interval: 100 }), true);
    } finally {
      server.close();
    }
  });

  it('resolves false on timeout', async () => {
    assert.equal(await waitForPort(19998, { timeout: 500, interval: 100 }), false);
  });
});

describe('checkHttp', () => {
  async function withServer(handler: http.RequestListener, fn: (port: number) => Promise<void>) {
    const server = http.createServer(handler);
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as net.AddressInfo).port;
    try { await fn(port); } finally { await new Promise<void>(r => server.close(() => r())); }
  }

  it('returns ok:true on 2xx by default', async () => {
    await withServer((_req, res) => { res.writeHead(204); res.end(); }, async port => {
      assert.equal((await checkHttp(port, { path: '/' })).ok, true);
    });
  });

  it('returns ok:false on 4xx by default with reason', async () => {
    await withServer((_req, res) => { res.writeHead(404); res.end(); }, async port => {
      const r = await checkHttp(port, { path: '/' });
      assert.equal(r.ok, false);
      assert.ok(r.reason?.includes('404'));
    });
  });

  it('respects expect = single status', async () => {
    await withServer((_req, res) => { res.writeHead(418); res.end(); }, async port => {
      assert.equal((await checkHttp(port, { path: '/', expect: 418 })).ok, true);
      assert.equal((await checkHttp(port, { path: '/', expect: 200 })).ok, false);
    });
  });

  it('respects expect = array', async () => {
    await withServer((_req, res) => { res.writeHead(301, { Location: '/x' }); res.end(); }, async port => {
      assert.equal((await checkHttp(port, { expect: [200, 301, 302] })).ok, true);
    });
  });

  it('returns ok:false on connection refused with reason', async () => {
    const r = await checkHttp(19997, { timeoutMs: 500 });
    assert.equal(r.ok, false);
    assert.ok(r.reason != null);
  });

  it('hits the configured path', async () => {
    let seen = '';
    await withServer((req, res) => { seen = req.url ?? ''; res.writeHead(200); res.end(); }, async port => {
      await checkHttp(port, { path: '/healthz' });
      assert.equal(seen, '/healthz');
    });
  });
});

describe('checkHealth dispatcher', () => {
  it('defaults to TCP when no config, returns ok:true', async () => {
    const server = net.createServer();
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const r = await checkHealth(port);
      assert.equal(r.ok, true);
    } finally {
      server.close();
    }
  });

  it('TCP check returns ok:false with reason when port closed', async () => {
    const r = await checkHealth(19996);
    assert.equal(r.ok, false);
    assert.ok(r.reason != null);
  });

  it('uses HTTP when configured', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === '/healthz' ? 200 : 500);
      res.end();
    });
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      assert.equal((await checkHealth(port, { type: 'http', path: '/healthz' })).ok, true);
      assert.equal((await checkHealth(port, { type: 'http', path: '/other' })).ok, false);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});

describe('deriveHealth', () => {
  it('idle status → idle', () => assert.equal(deriveHealth(false, 'idle'), 'idle'));
  it('up → up', () => assert.equal(deriveHealth(true, 'running'), 'up'));
  it('down + starting → wait', () => assert.equal(deriveHealth(false, 'starting'), 'wait'));
  it('down + running → down', () => assert.equal(deriveHealth(false, 'running'), 'down'));
  it('down + crashed → down', () => assert.equal(deriveHealth(false, 'crashed'), 'down'));
});

describe('isPortBindable is not checkPort', () => {
  it('says a bound port is unavailable while checkPort says it answers', async () => {
    // The distinction the two exist for, and the reason `Spawner.start` uses
    // the first: `checkPort` asks "is something serving here", `isPortBindable`
    // asks "can I take this port". On a port somebody else holds they give
    // opposite answers, and swapping them turns the spawn guard into a check
    // that passes precisely when it should not.
    //
    // This replaces a test named "bound but not yet accepting" whose entire
    // distinguishing setup was `occupier.pause?.()` — `net.Server` has no
    // `pause`, so the optional call did nothing and the test was the one above
    // it under another name. A listening socket accepts; the state it claimed
    // to cover is not reachable, but the distinction it was reaching for is.
    // `0.0.0.0`, like the services devup spawns: a holder bound only to
    // `127.0.0.1` does not stop a wildcard bind, so it would not be the
    // conflict this guard is about.
    const occupier = net.createServer();
    await new Promise<void>(r => occupier.listen(0, '0.0.0.0', r));
    const port = (occupier.address() as net.AddressInfo).port;
    try {
      assert.equal(await isPortBindable(port), false, 'the port is taken');
      assert.equal(await checkPort(port, '127.0.0.1', 1000), true, 'and it answers');
    } finally {
      await new Promise<void>(r => occupier.close(() => r()));
    }
  });
});
