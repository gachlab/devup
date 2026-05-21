import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { checkPort, waitForPort, deriveHealth, checkHttp, checkHealth } from '../../../src/process/health.js';

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
    // Port 1 is almost certainly not listening
    assert.equal(await checkPort(19999), false);
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

  it('returns true on 2xx by default', async () => {
    await withServer((_req, res) => { res.writeHead(204); res.end(); }, async port => {
      assert.equal(await checkHttp(port, { path: '/' }), true);
    });
  });

  it('returns false on 4xx by default', async () => {
    await withServer((_req, res) => { res.writeHead(404); res.end(); }, async port => {
      assert.equal(await checkHttp(port, { path: '/' }), false);
    });
  });

  it('respects expect = single status', async () => {
    await withServer((_req, res) => { res.writeHead(418); res.end(); }, async port => {
      assert.equal(await checkHttp(port, { path: '/', expect: 418 }), true);
      assert.equal(await checkHttp(port, { path: '/', expect: 200 }), false);
    });
  });

  it('respects expect = array', async () => {
    await withServer((_req, res) => { res.writeHead(301, { Location: '/x' }); res.end(); }, async port => {
      assert.equal(await checkHttp(port, { expect: [200, 301, 302] }), true);
    });
  });

  it('returns false on connection refused', async () => {
    assert.equal(await checkHttp(19997, { timeoutMs: 500 }), false);
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
  it('defaults to TCP when no config', async () => {
    const server = net.createServer();
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      assert.equal(await checkHealth(port), true);
    } finally {
      server.close();
    }
  });

  it('uses HTTP when configured', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === '/healthz' ? 200 : 500);
      res.end();
    });
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      assert.equal(await checkHealth(port, { type: 'http', path: '/healthz' }), true);
      assert.equal(await checkHealth(port, { type: 'http', path: '/other' }), false);
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
