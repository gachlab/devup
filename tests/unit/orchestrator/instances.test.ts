import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listRunningInstances, attributePort } from '../../../src/orchestrator/instances.js';

function withPidDir(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'devup-inst-'));
  try {
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
    fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('listRunningInstances', () => {
  it('reads the live ones and skips the dead', () => {
    withPidDir({
      'Guesthub.pid': String(process.pid),        // us: certainly alive
      'Guesthub-e2e.pid': '2147483647',           // a pid nothing can be using
      'notes.txt': 'ignored',
    }, dir => {
      const found = listRunningInstances(dir);
      assert.deepEqual(found.map(i => i.name), ['Guesthub']);
      assert.equal(found[0]!.pid, process.pid);
    });
  });

  it('survives junk without failing a boot', () => {
    // Nothing here is allowed to break a run; it only makes a message better.
    withPidDir({ 'a.pid': 'not-a-number', 'b.pid': '', 'c.pid': '   ' }, dir => {
      assert.deepEqual(listRunningInstances(dir), []);
    });
    assert.deepEqual(listRunningInstances(join(tmpdir(), 'devup-does-not-exist-at-all')), []);
  });
});

describe('attributePort', () => {
  const running = [
    { name: 'Guesthub', pid: 100 },
    { name: 'Guesthub-e2e', pid: 200 },
    { name: 'Guesthub-ci', pid: 300 },
  ];
  const socketPathFor = (n: string) => `/sock/${n}`;

  it('asks each instance whose service holds the port', async () => {
    // The holder pid belongs to a *service*, never to the daemon that spawned
    // it, so there is nothing to match against a pid file — but every daemon
    // already answers `status` with its services' pids.
    const asked: string[] = [];
    const found = await attributePort(31337, 'Guesthub', {
      running,
      socketPathFor,
      status: async path => {
        asked.push(path);
        return { services: path.endsWith('Guesthub-ci') ? [{ pid: 31337 }] : [{ pid: 999 }] };
      },
    });
    assert.equal(found?.name, 'Guesthub-ci');
    assert.ok(!asked.includes('/sock/Guesthub'), 'never asks the instance doing the asking');
  });

  it('names the right one even with several running', async () => {
    // The heuristic alone declines to guess between several, which is exactly
    // the ordinary case once a second instance exists.
    const found = await attributePort(555, 'Guesthub-ci', {
      running,
      socketPathFor,
      status: async path => ({ services: path.endsWith('e2e') ? [{ pid: 555 }] : [] }),
    });
    assert.equal(found?.name, 'Guesthub-e2e');
  });

  it('falls back to the only other instance when nothing answers', async () => {
    // A daemon too old to have a control plane, or one still booting, should
    // not turn a good hint into no hint.
    const found = await attributePort(31337, 'Guesthub', {
      running: [{ name: 'Guesthub', pid: 100 }, { name: 'Guesthub-e2e', pid: 200 }],
      socketPathFor,
      status: async () => { throw new Error('not answering'); },
    });
    assert.equal(found?.name, 'Guesthub-e2e');
  });

  it('says nothing rather than picking one of several that will not answer', async () => {
    const found = await attributePort(31337, 'Guesthub', {
      running, socketPathFor, status: async () => { throw new Error('nope'); },
    });
    assert.equal(found, null);
  });

  it('never blames the instance asking', async () => {
    const found = await attributePort(31337, 'Guesthub', {
      running: [{ name: 'Guesthub', pid: 100 }],
      socketPathFor,
      status: async () => ({ services: [{ pid: 31337 }] }),
    });
    assert.equal(found, null);
  });

  it('says nothing when no other instance is running', async () => {
    assert.equal(await attributePort(31337, 'Guesthub', { running: [] }), null);
    assert.equal(await attributePort(null, 'Guesthub', { running: [] }), null);
  });

  it('does not ask when there is no holder pid to match', async () => {
    let asked = 0;
    const found = await attributePort(null, 'Guesthub', {
      running: [{ name: 'Guesthub', pid: 1 }, { name: 'Guesthub-e2e', pid: 2 }],
      socketPathFor,
      status: async () => { asked++; return { services: [] }; },
    });
    assert.equal(asked, 0, 'nothing to compare against');
    assert.equal(found?.name, 'Guesthub-e2e', 'but the single-other fallback still applies');
  });
});
