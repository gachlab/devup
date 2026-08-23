import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { pidPathFor, stopDaemon, isDaemonRunning } from '../../src/orchestrator/daemon.js';
import { defaultSocketPath } from '../../src/control-plane/socket-server.js';
import { createClient } from '../../src/control-plane/client.js';
import { runExec } from '../../src/orchestrator/exec.js';
import { LinuxPlatform } from '../../src/platform/linux.js';
import type { DevStackConfig } from '../../src/config/types.js';
import type { CliArgs } from '../../src/config/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, '..', 'fixtures');
const runDaemonFixture = join(fixtures, 'run-daemon.ts');
const repoRoot = join(__dirname, '..', '..');

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

const baseCli: CliArgs = {
  skip: [], lazy: false, lazyTimeout: 10,
  proxy: false, proxyTls: true, proxyEntrypoint: 'websecure',
  dryRun: false, once: false, onceTimeout: 30, logFile: true,
  watchConfig: false, killPortConflicts: false,
};

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/** Boot a real daemon in an isolated HOME and hand its pieces to `fn`. */
async function withDaemon(
  projectName: string,
  fn: (ctx: { config: DevStackConfig; projectDir: string; socketPath: string; port: number; out: string[] }) => Promise<void>,
): Promise<void> {
  const tempHome = mkdtempSync(join(tmpdir(), 'devup-exec-'));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  mkdirSync(join(tempHome, '.devup'), { recursive: true });

  const port = await findFreePort();
  const projectDir = join(tempHome, 'project');
  mkdirSync(projectDir);
  const configPath = join(projectDir, 'devup.config.json');
  const config: DevStackConfig = {
    name: projectName,
    services: [{
      name: 'dummy', cwd: '.', cmd: 'node',
      args: [join(fixtures, 'dummy-server.cjs'), String(port)],
      type: 'api', port, phase: 0, readyPattern: 'listening:',
    }],
  };
  writeFileSync(configPath, JSON.stringify(config));

  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', runDaemonFixture, configPath], {
      detached: true, stdio: 'ignore', cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
    });
    child.unref();
    await waitFor(() => existsSync(pidPathFor(projectName)), 20_000, 'pid file');
    await waitFor(() => existsSync(defaultSocketPath(projectName)), 5_000, 'socket file');
    await fn({ config, projectDir, socketPath: defaultSocketPath(projectName), port, out: [] });
  } finally {
    await stopDaemon(projectName, { out: () => {}, gracePeriodMs: 8_000 }).catch(() => {});
    if (child?.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ } }
    if (originalHome) process.env.HOME = originalHome; else delete process.env.HOME;
    rmSync(tempHome, { recursive: true, force: true });
  }
}

function execOpts(config: DevStackConfig, projectDir: string, argv: string[], out: string[], over: Record<string, unknown> = {}) {
  return {
    argv, childArgs: [],
    config, services: config.services, cliArgs: baseCli,
    platform: new LinuxPlatform(),
    env: process.env as Record<string, string>,
    baseCwd: projectDir,
    proxyProvider: null, proxyOpts: null,
    ensurePortsFree: async () => true,
    out: (l: string) => out.push(l),
    ...over,
  };
}

describe('devup exec against a real daemon', { skip: !isUnix }, () => {
  it('reuses a running daemon and leaves it up', async () => {
    await withDaemon('ExecReuse', async ({ config, projectDir }) => {
      const out: string[] = [];
      let ran = false;
      const code = await runExec(execOpts(config, projectDir, ['--wait-timeout', '20', '--', 'true'], out, {
        spawnCommand: async () => { ran = true; return { code: 0, signal: null }; },
      }));
      assert.equal(code, 0, out.join('|'));
      assert.equal(ran, true, 'the command should have run');
      assert.ok(out.some(l => l.includes('reusing')), out.join('|'));
      // The whole point: a daemon we did not start is not ours to stop.
      assert.equal(isDaemonRunning('ExecReuse').pid !== null, true, 'the daemon must still be up');
      assert.ok(!out.some(l => l.includes('stopping the daemon we started')), out.join('|'));
    });
  });

  it('returns the command\'s exit code, not its own', async () => {
    await withDaemon('ExecCode', async ({ config, projectDir }) => {
      const out: string[] = [];
      const code = await runExec(execOpts(config, projectDir, ['--wait-timeout', '20', '--', 'false'], out, {
        spawnCommand: async () => ({ code: 42, signal: null }),
      }));
      assert.equal(code, 42, out.join('|'));
    });
  });

  it('really runs the command, with the stack up', async () => {
    // No spawnCommand seam here: the command is a real process, and it proves
    // the service is reachable while it runs.
    await withDaemon('ExecReal', async ({ config, projectDir, port }) => {
      const out: string[] = [];
      const code = await runExec(execOpts(config, projectDir, [
        '--wait-timeout', '20', '--',
        process.execPath, '-e',
        `const net=require('net');const s=net.createConnection(${port},'127.0.0.1');` +
        `s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(3));`,
      ], out));
      assert.equal(code, 0, out.join('|'));
    });
  });

  it('reports 127 for a command that cannot be run', async () => {
    await withDaemon('ExecMissing', async ({ config, projectDir }) => {
      const out: string[] = [];
      const code = await runExec(execOpts(config, projectDir, [
        '--wait-timeout', '20', '--', join(projectDir, 'no-such-binary'),
      ], out));
      assert.equal(code, 127, out.join('|'));
    });
  });

  it('--fail-on-crash fails a green command when a service died under it', async () => {
    // The case nobody else can see: the suite passes while an API is crashing
    // on every request. Here the "suite" kills the service and exits 0.
    await withDaemon('ExecCrash', async ({ config, projectDir, socketPath }) => {
      const out: string[] = [];
      const client = createClient(socketPath);
      const code = await runExec(execOpts(config, projectDir, ['--wait-timeout', '20', '--fail-on-crash', '--', 'true'], out, {
        spawnCommand: async () => {
          const { services } = await client.status();
          const pid = services.find(s => s.name === 'dummy')?.pid;
          assert.ok(pid, 'the service should have a pid to kill');
          process.kill(pid!, 'SIGKILL');
          // Let the daemon notice and schedule its auto-restart.
          await sleep(2500);
          return { code: 0, signal: null };   // a green suite
        },
      }));
      assert.equal(code, 1, `expected the crash to fail the run; out: ${out.join('|')}`);
      assert.ok(out.some(l => l.includes('crashed while the command ran')), out.join('|'));
      assert.ok(out.some(l => l.includes('dummy')), out.join('|'));
    });
  });

  it('without --fail-on-crash the same run stays green', async () => {
    // Opt-in: the flag exists because plenty of stacks restart services on
    // purpose while a suite runs.
    await withDaemon('ExecCrashOff', async ({ config, projectDir, socketPath }) => {
      const out: string[] = [];
      const client = createClient(socketPath);
      const code = await runExec(execOpts(config, projectDir, ['--wait-timeout', '20', '--', 'true'], out, {
        spawnCommand: async () => {
          const { services } = await client.status();
          process.kill(services.find(s => s.name === 'dummy')!.pid!, 'SIGKILL');
          await sleep(2500);
          return { code: 0, signal: null };
        },
      }));
      assert.equal(code, 0, out.join('|'));
    });
  });

  it('is interruptible while it waits, so a daemon it booted cannot be orphaned', async () => {
    // The window: Ctrl-C or a CI job-level SIGTERM arriving during the
    // readiness wait — up to two minutes of it. With no handler installed yet,
    // Node's default kills devup, the teardown never runs, and a daemon *we*
    // started keeps every port, so the next `devup up -d` refuses.
    await withDaemon('ExecSignals', async ({ config, projectDir }) => {
      const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
      let during = { int: 0, term: 0 };
      const out: string[] = [];
      const code = await runExec(execOpts(config, projectDir, ['--wait-timeout', '20', '--', 'true'], out, {
        out: (l: string) => {
          out.push(l);
          // Emitted immediately before the wait begins — the moment the window
          // used to be open.
          if (l.includes('waiting for')) {
            during = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
          }
        },
        spawnCommand: async () => ({ code: 0, signal: null }),
      }));
      assert.equal(code, 0, out.join('|'));
      assert.ok(during.int > before.int, 'SIGINT must already be handled while waiting');
      assert.ok(during.term > before.term, 'SIGTERM must already be handled while waiting');
      // And released again, or a long-lived host would accumulate them.
      assert.equal(process.listenerCount('SIGINT'), before.int);
      assert.equal(process.listenerCount('SIGTERM'), before.term);
    });
  });

  it('refuses when the running daemon has a different set of services', async () => {
    // Testing against a stack that is missing services is exactly the failure
    // `up -d`'s refusal exists to prevent. Narrowing to the intersection
    // silently would hand back a green suite that never exercised half of it.
    await withDaemon('ExecNotReady', async ({ config, projectDir }) => {
      const out: string[] = [];
      const withGhost: DevStackConfig = {
        ...config,
        services: [...config.services, {
          name: 'ghost', cwd: '.', cmd: 'node', args: [], type: 'api', port: 19941, phase: 0,
        }],
      };
      const code = await runExec(execOpts(withGhost, projectDir, ['--wait-timeout', '2', '--', 'true'], out, {
        spawnCommand: async () => { throw new Error('the command must not run'); },
      }));
      assert.equal(code, 1);
      assert.ok(out.some(l => l.includes('ghost')), out.join('|'));
      assert.ok(out.some(l => l.includes('different set of services')), out.join('|'));
      assert.ok(out.some(l => l.includes('devup down')), 'the message has to say what to do');
    });
  });

  it('gives up, and names it, when a service never becomes ready', async () => {
    await withDaemon('ExecStuck', async ({ config, projectDir, socketPath }) => {
      const out: string[] = [];
      // Stop the service through the control plane so the daemon still has it
      // in its set but it is not up: `stop` suppresses the auto-restart.
      //
      // Then wait for the daemon to *notice*. A stop does not update health —
      // the spawner's close handler returns early on an intentional stop — so
      // the snapshot reads `running/up` until the health poller (3 s) fails
      // `failureThreshold` (2) probes in a row. Calling exec before that would
      // have it report ready, correctly, about a service that is already gone.
      const client = createClient(socketPath);
      await client.stop('dummy');
      await waitFor(
        async () => (await client.status()).services.every(s => s.health !== 'up'),
        20_000,
        'the daemon to notice the service is down',
      );
      const code = await runExec(execOpts(config, projectDir, ['--wait-timeout', '2', '--', 'true'], out, {
        spawnCommand: async () => { throw new Error('the command must not run'); },
      }));
      assert.equal(code, 1, out.join('|'));
      assert.ok(out.some(l => l.includes('not ready')), out.join('|'));
      assert.ok(out.some(l => l.includes('dummy')), out.join('|'));
    });
  });
});
