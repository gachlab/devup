import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  pidPathFor, bootErrorPathFor, isDaemonRunning, stopDaemon,
} from '../../../src/orchestrator/daemon.js';

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

/** Stage the test's home so all the daemon files (~/.devup/...) live in a temp dir.
 *  Node's os.homedir() reads HOME on Unix and USERPROFILE on Windows — we override
 *  both so the test is hermetic regardless of platform. */
function withFakeHome(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'devup-daemon-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  mkdirSync(join(home, '.devup'), { recursive: true });
  return {
    home,
    restore: () => {
      if (originalHome) process.env.HOME = originalHome; else delete process.env.HOME;
      if (originalUserProfile) process.env.USERPROFILE = originalUserProfile; else delete process.env.USERPROFILE;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Spawn a long-lived detached child that:
 *  - writes its PID to `pidPath`
 *  - exits cleanly on SIGTERM (so we can verify the grace-period path)
 *  - or ignores SIGTERM (so we can verify the SIGKILL fallback) when `ignoreTerm` is true */
function spawnFakeDaemon(pidPath: string, ignoreTerm = false): ChildProcess {
  const script = `
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : "process.on('SIGTERM', () => process.exit(0));"}
    require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

describe('daemon paths', () => {
  it('pidPathFor sanitises the project name', () => {
    const ctx = withFakeHome();
    try {
      const p = pidPathFor('My Crazy/Name!');
      assert.ok(p.endsWith('My_Crazy_Name.pid'), `unexpected pid path: ${p}`);
      assert.ok(p.includes('.devup'));
    } finally { ctx.restore(); }
  });

  it('bootErrorPathFor mirrors pid sanitisation', () => {
    const ctx = withFakeHome();
    try {
      const p = bootErrorPathFor('proj');
      assert.ok(p.endsWith('proj.boot-error'));
    } finally { ctx.restore(); }
  });
});

describe('isDaemonRunning', () => {
  it('returns pid=null when no pid file exists', () => {
    const ctx = withFakeHome();
    try {
      assert.deepEqual(isDaemonRunning('nothing'), { pid: null, stale: false });
    } finally { ctx.restore(); }
  });

  it('returns stale=true when pid file points to a dead process', () => {
    const ctx = withFakeHome();
    try {
      writeFileSync(pidPathFor('zombie'), '999999');
      const status = isDaemonRunning('zombie');
      assert.equal(status.pid, 999999);
      assert.equal(status.stale, true);
    } finally { ctx.restore(); }
  });

  it('returns stale=true when pid file is garbage', () => {
    const ctx = withFakeHome();
    try {
      writeFileSync(pidPathFor('garbled'), 'not-a-number');
      const status = isDaemonRunning('garbled');
      assert.equal(status.stale, true);
    } finally { ctx.restore(); }
  });

  it('returns the live pid when the process is alive', { skip: !isUnix }, async () => {
    const ctx = withFakeHome();
    let child: ChildProcess | null = null;
    try {
      const pidPath = pidPathFor('live');
      child = spawnFakeDaemon(pidPath, false);
      assert.ok(await waitFor(() => existsSync(pidPath)), 'pid file should be created');
      const status = isDaemonRunning('live');
      assert.equal(status.pid, Number(readFileSync(pidPath, 'utf8').trim()));
      assert.equal(status.stale, false);
    } finally {
      if (child?.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ } }
      ctx.restore();
    }
  });
});

describe('stopDaemon', { skip: !isUnix }, () => {
  it('returns 1 with helpful message when no pid file exists', async () => {
    const ctx = withFakeHome();
    const lines: string[] = [];
    try {
      const code = await stopDaemon('ghost', { out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.ok(lines.some(l => l.toLowerCase().includes('no daemon running')));
    } finally { ctx.restore(); }
  });

  it('removes a stale pid file and returns 1', async () => {
    const ctx = withFakeHome();
    const lines: string[] = [];
    try {
      const pidPath = pidPathFor('stale');
      writeFileSync(pidPath, '999999');
      const code = await stopDaemon('stale', { out: l => lines.push(l) });
      assert.equal(code, 1);
      assert.equal(existsSync(pidPath), false);
      assert.ok(lines.some(l => l.toLowerCase().includes('stale')));
    } finally { ctx.restore(); }
  });

  it('SIGTERMs a live daemon, waits, and reports clean shutdown', async () => {
    const ctx = withFakeHome();
    const lines: string[] = [];
    let child: ChildProcess | null = null;
    try {
      const pidPath = pidPathFor('clean');
      child = spawnFakeDaemon(pidPath, false);
      assert.ok(await waitFor(() => existsSync(pidPath)), 'pid file should appear');

      const code = await stopDaemon('clean', { out: l => lines.push(l), gracePeriodMs: 3000 });
      assert.equal(code, 0);
      assert.ok(lines.some(l => l.includes('stopped daemon')));
      assert.equal(existsSync(pidPath), false);
    } finally {
      if (child?.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ } }
      ctx.restore();
    }
  });

  it('falls back to SIGKILL when the daemon ignores SIGTERM', async () => {
    const ctx = withFakeHome();
    const lines: string[] = [];
    let child: ChildProcess | null = null;
    try {
      const pidPath = pidPathFor('stubborn');
      child = spawnFakeDaemon(pidPath, true);
      assert.ok(await waitFor(() => existsSync(pidPath)), 'pid file should appear');

      const code = await stopDaemon('stubborn', { out: l => lines.push(l), gracePeriodMs: 500 });
      assert.equal(code, 0);
      assert.ok(lines.some(l => l.includes('SIGKILL')));
      assert.equal(existsSync(pidPath), false);
    } finally {
      if (child?.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ } }
      ctx.restore();
    }
  });
});
