import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnce } from '../../src/orchestrator/once.js';
import { LinuxPlatform } from '../../src/platform/linux.js';
import type { DevStackConfig } from '../../src/config/types.js';
import type { CliArgs } from '../../src/config/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, '..', 'fixtures');

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

const baseCli: CliArgs = {
  skip: [], lazy: false, lazyTimeout: 10,
  proxy: false, proxyTls: true, proxyEntrypoint: 'websecure',
  dryRun: false, once: true, onceTimeout: 15, logFile: false,
};

describe('runOnce integration', { skip: !isUnix }, () => {
  it('returns 0 when all APIs come up', async () => {
    const port = await findFreePort();
    const config: DevStackConfig = {
      name: 'OnceTest',
      services: [{
        name: 'dummy', cwd: '.', cmd: 'node',
        args: ['--import', 'tsx', 'dummy-server.ts', String(port)],
        type: 'api', port, phase: 0,
      }],
    };
    const lines: string[] = [];
    const code = await runOnce({
      config, services: config.services, cliArgs: baseCli,
      platform: new LinuxPlatform(),
      env: { ...process.env as Record<string, string> },
      baseCwd: fixtures, logSink: null,
      out: l => lines.push(l),
    });
    assert.equal(code, 0, `expected 0, got ${code}; lines: ${lines.join('|')}`);
    assert.ok(lines.some(l => l.includes('dummy ready')), 'should log readiness');
  });

  it('returns 1 when API never opens its port', async () => {
    // Spawn a process that doesn't listen — sleeps for a while
    const config: DevStackConfig = {
      name: 'OnceFail',
      services: [{
        name: 'no-listen', cwd: '.', cmd: 'node',
        args: ['-e', 'setTimeout(()=>process.exit(0), 60000)'],
        type: 'api', port: 19921, phase: 0,
      }],
    };
    const lines: string[] = [];
    const code = await runOnce({
      config, services: config.services,
      cliArgs: { ...baseCli, onceTimeout: 2 },
      platform: new LinuxPlatform(),
      env: { ...process.env as Record<string, string> },
      baseCwd: fixtures, logSink: null,
      out: l => lines.push(l),
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('did not become healthy')));
  });
});
