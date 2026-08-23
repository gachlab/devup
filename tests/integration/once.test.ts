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
  onceJson: false, watchConfig: false, killPortConflicts: false,
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

describe('runOnce --json', { skip: !isUnix }, () => {
  it('prints a summary a pipeline can read, and nothing else on stdout', async () => {
    // The detail that makes or breaks it: one `[app-api] listening` line in
    // the middle and the caller cannot parse the result at all.
    const port = await findFreePort();
    const config: DevStackConfig = {
      name: 'OnceJson',
      services: [{
        name: 'dummy', cwd: '.', cmd: 'node',
        args: ['--import', 'tsx', 'dummy-server.ts', String(port)],
        type: 'api', port, phase: 0,
      }],
    };
    const stdout: string[] = [];
    const code = await runOnce({
      config, services: config.services, cliArgs: { ...baseCli, onceJson: true },
      platform: new LinuxPlatform(),
      env: { ...process.env as Record<string, string> },
      baseCwd: fixtures, logSink: null,
      out: l => stdout.push(l),
    });
    assert.equal(code, 0, stdout.join('|'));

    const report = JSON.parse(stdout.join('\n'));
    assert.equal(report.ok, true);
    assert.equal(report.services.length, 1);
    assert.equal(report.services[0].name, 'dummy');
    assert.equal(report.services[0].ready, true);
    assert.equal(typeof report.services[0].readyAfterMs, 'number');
    assert.ok(report.elapsedMs > 0);
    assert.equal(report.timeoutMs, 15_000);
  });

  it('does not say "never started" about a service it started', async () => {
    // Everything in a phase is spawned before any of it is awaited, so an
    // install failure on the *second* service leaves the first running and
    // unchecked. Calling that "never started" sends a pipeline past the logs
    // of the service that may well be the culprit.
    const port = await findFreePort();
    const config: DevStackConfig = {
      name: 'OnceJsonStarted',
      services: [
        { name: 'first', cwd: '.', cmd: 'node', args: ['--import', 'tsx', 'dummy-server.ts', String(port)], type: 'api', port, phase: 0 },
        { name: 'uninstallable', cwd: 'no-such-directory', cmd: 'node', args: ['-e', ''], type: 'api', port: 19961, phase: 0 },
      ],
    };
    const stdout: string[] = [];
    const code = await runOnce({
      config, services: config.services,
      cliArgs: { ...baseCli, onceJson: true, onceTimeout: 5 },
      platform: new LinuxPlatform(),
      env: { ...process.env as Record<string, string> },
      baseCwd: fixtures, logSink: null,
      out: l => stdout.push(l),
    });
    assert.equal(code, 1);
    const report = JSON.parse(stdout.join('\n'));
    const byName = Object.fromEntries(report.services.map((s: { name: string }) => [s.name, s]));
    assert.match(byName['uninstallable'].reason, /install failed/);
    assert.match(byName['first'].reason, /started, but the run stopped/);
    assert.ok(!/never started/.test(byName['first'].reason), byName['first'].reason);
  });

  it('reports every selected service, including ones that never got their turn', async () => {
    // A service skipped because an earlier one failed is not "ready", and
    // leaving it out of the report makes the pipeline guess.
    const config: DevStackConfig = {
      name: 'OnceJsonFail',
      services: [
        { name: 'never-listens', cwd: '.', cmd: 'node', args: ['-e', 'setTimeout(()=>{}, 60000)'], type: 'api', port: 19951, phase: 0 },
        { name: 'never-reached', cwd: '.', cmd: 'node', args: ['-e', 'setTimeout(()=>{}, 60000)'], type: 'api', port: 19952, phase: 1 },
      ],
    };
    const stdout: string[] = [];
    const code = await runOnce({
      config, services: config.services,
      cliArgs: { ...baseCli, onceJson: true, onceTimeout: 2 },
      platform: new LinuxPlatform(),
      env: { ...process.env as Record<string, string> },
      baseCwd: fixtures, logSink: null,
      out: l => stdout.push(l),
    });
    assert.equal(code, 1);

    const report = JSON.parse(stdout.join('\n'));
    assert.equal(report.ok, false);
    assert.equal(report.services.length, 2, 'both, not just the one that failed');
    const byName = Object.fromEntries(report.services.map((s: { name: string }) => [s.name, s]));
    assert.equal(byName['never-listens'].ready, false);
    assert.match(byName['never-listens'].reason, /did not become ready/);
    assert.equal(byName['never-reached'].ready, false);
    assert.match(byName['never-reached'].reason, /never started/);
  });
});
