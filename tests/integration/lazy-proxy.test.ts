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
const isWin = process.platform === 'win32';

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

describe('lazy-proxy integration', { skip: isWin }, () => {
  it('starts real server on-demand and pipes data', { timeout: 30000 }, async () => {
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
        await waitForPort(targetPort, { timeout: 15000, interval: 300 });
      },
      onIdleStop: () => {
        if (serverProc) { serverProc.kill('SIGTERM'); serverProc = null; }
      },
      isAlive: () => serverProc !== null && !serverProc.killed,
      onLog: () => {},
    });

    try {
      const data = await new Promise<string>((resolve, reject) => {
        const client = net.createConnection(listenPort, '127.0.0.1');
        let buf = '';
        client.on('data', d => { buf += d.toString(); });
        client.on('end', () => resolve(buf));
        client.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ECONNRESET') resolve(buf);
          else reject(err);
        });
        setTimeout(() => resolve(buf), 20000);
      });

      assert.ok(data.includes('ok'), `expected 'ok' but got '${data}'`);
    } finally {
      proxy.destroy();
      if (serverProc) (serverProc as ReturnType<typeof spawn>).kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
    }
  });
});
