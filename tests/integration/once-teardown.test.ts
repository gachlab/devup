import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnce } from '../../src/orchestrator/once.js';
import { LinuxPlatform } from '../../src/platform/linux.js';
import type { DevStackConfig } from '../../src/config/types.js';
import type { CliArgs } from '../../src/config/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, '..', '..', 'src', 'index.ts');
const isUnix = process.platform === 'linux' || process.platform === 'darwin';

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Kill whatever a regression left behind. An orphan keeps its stdio pipes to
 *  this process open, so without this a failing assertion becomes a hang. */
const reap = (pid: number) => { if (pid > 0 && alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } } };
/** A node one-liner that records its pid and then idles, never listening. */
const idler = (pidFile: string) =>
  `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`;

describe('--once on a signal', { skip: !isUnix }, () => {
  it('SIGTERM while an external is not healthy yet still stops it', { timeout: 30000 }, async () => {
    // The external is spawned, then awaited for up to 30 s. The list of
    // externals used to exist only once that wait ended: a SIGTERM in between
    // found [] and the detached process outlived devup.
    const dir = mkdtempSync(join(tmpdir(), 'devup-once-sig-'));
    const pidFile = join(dir, 'ext.pid');
    const config = {
      name: 'once-sig',
      external: [{ name: 'db', cmd: idler(pidFile), port: await findFreePort(), healthCheck: { type: 'tcp' }, startTimeout: 30 }],
      services: [{ name: 'api', cwd: '.', cmd: 'node', args: ['-e', ''], type: 'api', port: await findFreePort(), phase: 0 }],
    };
    writeFileSync(join(dir, 'devup.config.json'), JSON.stringify(config));

    // tsx resolved from this repo, not from the temp dir the config lives in.
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), entry, '--once'], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));

    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 15000);
    const extPid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(alive(extPid));

    child.kill('SIGTERM');
    try {
      assert.equal(await exited, 143, output);
      await until(() => !alive(extPid), 5000).catch(() => {});
      assert.equal(alive(extPid), false, `the external outlived devup\n${output}`);
    } finally {
      reap(extPid);
    }
  });
});

describe('runOnce that throws', { skip: !isUnix }, () => {
  it('stops the externals and drops its handlers before rethrowing', { timeout: 20000 }, async () => {
    // `--remote qq` with an environment that does not exist rejects *after*
    // the externals are up; `main().catch` exited and left them running.
    const dir = mkdtempSync(join(tmpdir(), 'devup-once-throw-'));
    const pidFile = join(dir, 'ext.pid');
    const extPort = await findFreePort();
    const config: DevStackConfig = {
      name: 'once-throw',
      // Healthy before moving on, so it is alive with its pid written when the throw lands.
      external: [{
        name: 'db', port: extPort, healthCheck: { type: 'tcp' }, startTimeout: 10,
        cmd: `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); require('net').createServer(s => s.end()).listen(${extPort})"`,
      }],
      services: [{ name: 'api', cwd: '.', cmd: 'node', args: ['-e', ''], type: 'api', port: await findFreePort(), phase: 0 }],
      environments: { qa: { targets: { api: 'http://127.0.0.1:1' } } },
    };
    const cliArgs = {
      skip: [], lazy: false, lazyTimeout: 10, proxy: false, proxyTls: true, proxyEntrypoint: 'websecure',
      dryRun: false, once: true, onceTimeout: 5, logFile: false, onceJson: false, watchConfig: false,
      killPortConflicts: false, remote: 'qq',
    } as CliArgs;
    const before = process.listenerCount('SIGTERM');

    await assert.rejects(runOnce({
      config, services: config.services, cliArgs, platform: new LinuxPlatform(),
      env: { ...process.env as Record<string, string> }, baseCwd: dir, logSink: null, out: () => {},
    }), /Unknown environment/);

    assert.equal(process.listenerCount('SIGTERM'), before, 'los handlers de señal quedaron colgados');
    const extPid = Number(readFileSync(pidFile, 'utf8'));
    try {
      await until(() => !alive(extPid), 5000).catch(() => {});
      assert.equal(alive(extPid), false, 'the external outlived the throw');
    } finally {
      reap(extPid);
    }
  });
});
