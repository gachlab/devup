import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLazyProxy } from '../../src/lazy/proxy.js';
import { waitForPort } from '../../src/process/health.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, '..', 'fixtures');

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

describe('lazy-proxy integration', () => {
  it('starts real server on-demand and pipes data', async () => {
    const listenPort = await findFreePort();
    const targetPort = await findFreePort();
    let serverProc: ReturnType<typeof spawn> | null = null;

    const proxy = createLazyProxy({
      listenPort, targetPort, timeoutMin: 0,
      onDemandStart: async () => {
        serverProc = spawn('node', ['--import', 'tsx', 'dummy-server.ts', String(targetPort)], {
          cwd: fixtures,
          env: { ...process.env as Record<string, string> },
          stdio: 'ignore',
        });
        await waitForPort(targetPort, { timeout: 5000, interval: 200 });
      },
      onIdleStop: () => {
        if (serverProc) { serverProc.kill('SIGTERM'); serverProc = null; }
      },
      isAlive: () => serverProc !== null && !serverProc.killed,
      onLog: () => {},
    });

    try {
      // Connect through proxy — should trigger on-demand start
      const data = await new Promise<string>((resolve, reject) => {
        const client = net.createConnection(listenPort, '127.0.0.1');
        let buf = '';
        client.on('data', d => { buf += d.toString(); });
        client.on('end', () => resolve(buf));
        client.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 15000);
      });

      assert.equal(data.trim(), 'ok');
      assert.ok(serverProc, 'server should have been started');
    } finally {
      proxy.destroy();
      if (serverProc) (serverProc as ReturnType<typeof spawn>).kill('SIGTERM');
      await new Promise(r => setTimeout(r, 300));
    }
  });
});
