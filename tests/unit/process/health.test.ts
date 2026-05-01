import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { checkPort, waitForPort, deriveHealth } from '../../../src/process/health.js';

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

describe('deriveHealth', () => {
  it('idle status → idle', () => assert.equal(deriveHealth(false, 'idle'), 'idle'));
  it('up → up', () => assert.equal(deriveHealth(true, 'running'), 'up'));
  it('down + starting → wait', () => assert.equal(deriveHealth(false, 'starting'), 'wait'));
  it('down + running → down', () => assert.equal(deriveHealth(false, 'running'), 'down'));
  it('down + crashed → down', () => assert.equal(deriveHealth(false, 'crashed'), 'down'));
});
