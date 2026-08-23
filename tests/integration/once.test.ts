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
    assert.ok(lines.some(l => l.includes('did not become ready')), lines.join('|'));
  });
});

describe('runOnce waits for webs, not just APIs', { skip: !isUnix }, () => {
  it("holds until a web's readyPattern matches, not just until its port opens", async () => {
    // `ng serve` opens its port long before the bundle exists. Waiting on the
    // port hands back control while the front end is still compiling, which is
    // exactly what `--once` is supposed to spare its caller.
    const port = await findFreePort();
    const config: DevStackConfig = {
      name: 'OnceWeb',
      services: [{
        name: 'slow-web', cwd: '.', cmd: 'node',
        args: ['--import', 'tsx', 'slow-web.ts', String(port), '900'],
        type: 'web', port, phase: 0,
        readyPattern: 'Application bundle generation complete',
      }],
    };
    const lines: string[] = [];
    const code = await runOnce({
      config, services: config.services, cliArgs: { ...baseCli, onceTimeout: 20 },
      platform: new LinuxPlatform(),
      env: { ...process.env as Record<string, string> },
      baseCwd: fixtures, logSink: null,
      out: l => lines.push(l),
    });
    assert.equal(code, 0, `expected 0, got ${code}; lines: ${lines.join('|')}`);

    // Asserted on the order of the log, not on elapsed time. A wall-clock
    // threshold would be met by tsx's own startup cost alone, so it would pass
    // just as happily with the port as the signal — which is the bug.
    const listening = lines.findIndex(l => l.includes('compiling'));
    const compiled = lines.findIndex(l => l.includes('Application bundle generation complete'));
    const ready = lines.findIndex(l => l.includes('slow-web ready'));
    assert.ok(listening >= 0, `never saw the port open: ${lines.join('|')}`);
    assert.ok(compiled >= 0, `never saw the pattern: ${lines.join('|')}`);
    assert.ok(ready >= 0, `never reported ready: ${lines.join('|')}`);
    assert.ok(
      listening < compiled && compiled < ready,
      `readiness must follow the pattern, not the port — got listening@${listening} compiled@${compiled} ready@${ready}`,
    );
  });

  it('fails, and says why, when a web never announces itself', async () => {
    const port = await findFreePort();
    const config: DevStackConfig = {
      name: 'OnceWebFail',
      services: [{
        name: 'never-ready', cwd: '.', cmd: 'node',
        args: ['--import', 'tsx', 'slow-web.ts', String(port), '60000'],
        type: 'web', port, phase: 0,
        readyPattern: 'Application bundle generation complete',
      }],
    };
    const lines: string[] = [];
    const code = await runOnce({
      config, services: config.services, cliArgs: { ...baseCli, onceTimeout: 2 },
      platform: new LinuxPlatform(),
      env: { ...process.env as Record<string, string> },
      baseCwd: fixtures, logSink: null,
      out: l => lines.push(l),
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('never-ready did not become ready')), lines.join('|'));
  });

  it('falls back to the port for a web that declares no pattern, and says so on failure', async () => {
    // Nothing better exists for it. Worth naming in the failure, because the
    // fix is a readyPattern in the config, not a longer timeout.
    const config: DevStackConfig = {
      name: 'OnceWebNoPattern',
      services: [{
        name: 'mute-web', cwd: '.', cmd: 'node',
        args: ['-e', 'setTimeout(()=>process.exit(0), 60000)'],
        type: 'web', port: 19931, phase: 0,
      }],
    };
    const lines: string[] = [];
    const code = await runOnce({
      config, services: config.services, cliArgs: { ...baseCli, onceTimeout: 2 },
      platform: new LinuxPlatform(),
      env: { ...process.env as Record<string, string> },
      baseCwd: fixtures, logSink: null,
      out: l => lines.push(l),
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('no readyPattern for mute-web')), lines.join('|'));
  });
});
