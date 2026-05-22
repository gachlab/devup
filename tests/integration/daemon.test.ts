import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { pidPathFor, stopDaemon } from '../../src/orchestrator/daemon.js';
import { defaultSocketPath } from '../../src/control-plane/socket-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, '..', 'fixtures');
const runDaemonFixture = join(fixtures, 'run-daemon.ts');

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/** Make a single newline-delimited JSON RPC and return the parsed first frame. */
function rpcOnce(socketPath: string, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath);
    c.on('error', reject);
    const rl = createInterface({ input: c });
    rl.once('line', l => {
      try { resolve(JSON.parse(l)); } catch (e) { reject(e); }
      c.end();
    });
    c.write(JSON.stringify(payload) + '\n');
  });
}

describe('daemon E2E lifecycle', { skip: !isUnix }, () => {
  it('boots services, answers control plane, stops cleanly', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'devup-daemon-e2e-'));
    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    mkdirSync(join(tempHome, '.devup'), { recursive: true });

    const port = await findFreePort();
    const projectDir = join(tempHome, 'project');
    mkdirSync(projectDir);
    const configPath = join(projectDir, 'devup.config.json');
    const config = {
      name: 'E2EDaemon',
      services: [{
        name: 'dummy', cwd: '.', cmd: 'node',
        args: [join(fixtures, 'dummy-server.cjs'), String(port)],
        type: 'api', port, phase: 0,
        readyPattern: 'listening:',
      }],
    };
    writeFileSync(configPath, JSON.stringify(config));

    let child: ChildProcess | null = null;
    try {
      // Spawn the daemon body as a detached child. Pass HOME explicitly so daemon files
      // (pid, socket, logs) all live in the test's temp dir.
      const repoRoot = join(__dirname, '..', '..');
      // cwd=repoRoot so `--import tsx` can resolve the tsx package from this repo's node_modules.
      // The daemon's own baseCwd (where services spawn) is derived from configPath inside run-daemon.ts.
      child = spawn(process.execPath, ['--import', 'tsx', runDaemonFixture, configPath], {
        detached: true,
        stdio: 'ignore',
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome },
      });
      child.unref();

      const pidPath = pidPathFor('E2EDaemon');
      const sockPath = defaultSocketPath('E2EDaemon');

      // Wait up to 20s for daemon to be ready (write pid file).
      await waitFor(() => existsSync(pidPath), 20_000, 'pid file');
      await waitFor(() => existsSync(sockPath), 5_000, 'socket file');

      // Control plane should answer ping.
      const ping = await rpcOnce(sockPath, { id: 1, method: 'ping' });
      assert.equal(ping.result.ok, true);

      // Status should list the service.
      const status = await rpcOnce(sockPath, { id: 2, method: 'status' });
      assert.equal(status.result.services.length, 1);
      assert.equal(status.result.services[0].name, 'dummy');

      // stopDaemon: SIGTERM, wait 10s grace, verify exit.
      const lines: string[] = [];
      const code = await stopDaemon('E2EDaemon', { out: l => lines.push(l), gracePeriodMs: 10_000 });
      assert.equal(code, 0, `stopDaemon returned ${code}; lines: ${lines.join(' | ')}`);

      // Pid file should be gone; socket file should be gone.
      assert.equal(existsSync(pidPath), false, 'pid file should be removed');
      assert.equal(existsSync(sockPath), false, 'socket file should be removed');
    } finally {
      if (child?.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ } }
      if (originalHome) process.env.HOME = originalHome; else delete process.env.HOME;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('runDetached errors out when daemon already running', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'devup-daemon-already-'));
    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    mkdirSync(join(tempHome, '.devup'), { recursive: true });

    try {
      // Stage a pid file pointing at this test process (definitely alive).
      const pidPath = pidPathFor('AlreadyOn');
      writeFileSync(pidPath, String(process.pid));

      const { runDetached } = await import('../../src/orchestrator/daemon.js');
      const lines: string[] = [];
      const code = await runDetached({
        config: { name: 'AlreadyOn', services: [] } as any,
        services: [], cliArgs: {} as any, platform: {} as any,
        env: {}, baseCwd: tempHome, proxyProvider: null, proxyOpts: null,
        out: l => lines.push(l),
      });
      assert.equal(code, 1);
      assert.ok(lines.some(l => l.includes('already running')));
    } finally {
      if (originalHome) process.env.HOME = originalHome; else delete process.env.HOME;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
