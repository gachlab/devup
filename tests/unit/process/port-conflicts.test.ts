import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  findPortHolder, scanPortConflicts, resolvePortConflicts, killHolder,
  type PortConflict,
} from '../../../src/process/port-conflicts.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

function api(name: string, port: number): ServiceConfig {
  return { name, cwd: '.', cmd: 'node', args: [], type: 'api', port, phase: 0 };
}
function web(name: string, port: number): ServiceConfig {
  return { name, cwd: '.', cmd: 'node', args: [], type: 'web', port, phase: 0 };
}

async function findFreePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(r => s.listen(0, r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

describe('findPortHolder', { skip: !isUnix }, () => {
  it('returns null when nothing is listening on the port', async () => {
    const port = await findFreePort();
    assert.equal(await findPortHolder(port), null);
  });

  it('returns the PID + command of the listener', async () => {
    const server = net.createServer();
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const holder = await findPortHolder(port);
      assert.ok(holder, `expected a holder for port ${port}`);
      assert.equal(holder!.pid, process.pid);
      assert.ok(holder!.command.length > 0);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});

describe('scanPortConflicts', { skip: !isUnix }, () => {
  it('returns an empty list when all ports are free', async () => {
    const p1 = await findFreePort();
    const p2 = await findFreePort();
    const conflicts = await scanPortConflicts([api('a', p1), api('b', p2)]);
    assert.deepEqual(conflicts, []);
  });

  it('only checks API services (webs are skipped)', async () => {
    const server = net.createServer();
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const conflicts = await scanPortConflicts([web('w', port)]);
      assert.equal(conflicts.length, 0, 'web service should be skipped');
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });

  it('reports each API whose port is held, with PID + command', async () => {
    const server = net.createServer();
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const conflicts = await scanPortConflicts([api('busy', port)]);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0]!.service, 'busy');
      assert.equal(conflicts[0]!.port, port);
      assert.ok(conflicts[0]!.holder, 'holder should be detected');
      assert.equal(conflicts[0]!.holder!.pid, process.pid);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});

describe('killHolder', { skip: !isUnix }, () => {
  it('SIGTERMs a cooperative process and returns true', async () => {
    const child: ChildProcess = spawn(process.execPath, ['-e', `
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore' });
    try {
      // Give the child a moment to install its handler.
      await sleep(150);
      const ok = await killHolder(child.pid!, 3000);
      assert.equal(ok, true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('SIGKILLs an uncooperative process when SIGTERM is ignored', async () => {
    const child: ChildProcess = spawn(process.execPath, ['-e', `
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore' });
    try {
      await sleep(150);
      const ok = await killHolder(child.pid!, 500);
      assert.equal(ok, true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

describe('resolvePortConflicts', () => {
  it('returns true immediately when no conflicts', async () => {
    const out: string[] = [];
    const ok = await resolvePortConflicts([], {
      autoKill: false,
      out: l => out.push(l),
      isInteractive: false,
    });
    assert.equal(ok, true);
    assert.deepEqual(out, []);
  });

  it('non-interactive without autoKill fails and prints instructions', async () => {
    const conflicts: PortConflict[] = [
      { service: 'api', port: 3000, holder: { pid: 99999, command: 'foo' } },
    ];
    const out: string[] = [];
    const ok = await resolvePortConflicts(conflicts, {
      autoKill: false,
      out: l => out.push(l),
      isInteractive: false,
    });
    assert.equal(ok, false);
    assert.ok(out.some(l => l.includes('--kill-port-conflicts')));
  });

  it('interactive flow calls the prompt and aborts when user declines', async () => {
    let promptCalled = false;
    const ok = await resolvePortConflicts(
      [{ service: 'api', port: 3000, holder: { pid: 99999, command: 'foo' } }],
      {
        autoKill: false,
        out: () => {},
        isInteractive: true,
        prompt: async () => { promptCalled = true; return false; },
      },
    );
    assert.equal(promptCalled, true);
    assert.equal(ok, false);
  });

  it('flags holder=null as "unable to kill" but still proceeds with the rest', { skip: !isUnix }, async () => {
    // One real (kill-able) holder + one fake (no holder) conflict.
    const child = spawn(process.execPath, ['-e', `
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore' });
    await sleep(150);
    const out: string[] = [];
    try {
      const ok = await resolvePortConflicts([
        { service: 'real', port: 3000, holder: { pid: child.pid!, command: 'node' } },
        { service: 'orphan', port: 3001, holder: null },
      ], {
        autoKill: true,
        out: l => out.push(l),
      });
      assert.equal(ok, false, 'overall failure because the orphan could not be killed');
      assert.ok(out.some(l => l.includes('killed pid=')), 'real one should report as killed');
      assert.ok(out.some(l => l.includes('holder unknown')), 'orphan should report unable to kill');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
