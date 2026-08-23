import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listInstanceSockets, attributePort, type AttributeProbe } from '../../../src/orchestrator/instances.js';

describe('listInstanceSockets', () => {
  it('finds the socket files and ignores everything else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sockls-'));
    try {
      for (const f of ['sock-Proj.sock', 'sock-Proj-e2e.sock', 'Proj.pid', 'notes.txt', 'sock-x.txt']) {
        writeFileSync(join(dir, f), '');
      }
      const found = listInstanceSockets(dir).map(p => p.split('/').pop());
      assert.deepEqual(found.sort(), ['sock-Proj-e2e.sock', 'sock-Proj.sock']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('survives a missing directory without failing a boot', () => {
    assert.deepEqual(listInstanceSockets(join(tmpdir(), 'devup-nope-at-all')), []);
  });
});

describe('attributePort', () => {
  const SELF = '/d/sock-Proj.sock';
  const E2E = '/d/sock-Proj-e2e.sock';
  const CI = '/d/sock-Proj-ci.sock';

  function probe(over: Partial<AttributeProbe> = {}): AttributeProbe {
    return {
      info: async path => ({ project: 'Proj', instance: path === E2E ? 'e2e' : 'ci', pid: path === E2E ? 200 : 300 }),
      status: async () => ({ services: [] }),
      ...over,
    };
  }

  it('matches the daemon itself, because a lazy proxy holds the port in-process', () => {
    // Lazy is the default, and the on-demand proxy listens on the *configured*
    // port from inside the daemon — so no service pid will ever match.
    return attributePort(200, SELF, probe(), [SELF, E2E, CI]).then(found => {
      assert.equal(found?.identity.instance, 'e2e');
      assert.equal(found?.stopCommand, 'devup down --instance e2e');
    });
  });

  it('matches one of its services for an always-on port', async () => {
    const found = await attributePort(555, SELF, probe({
      status: async path => ({ services: path === CI ? [{ pid: 555 }] : [] }),
    }), [SELF, E2E, CI]);
    assert.equal(found?.identity.instance, 'ci');
  });

  it('builds the stop command from what the daemon says, not from a file name', () => {
    // Cutting a suffix off a qualified name misreads any project whose own
    // name has a dash, and the pid-file name is sanitised besides.
    return attributePort(200, SELF, probe({
      info: async () => ({ project: 'my-app', pid: 200 }),
    }), [SELF, E2E]).then(found => {
      assert.equal(found?.stopCommand, 'devup down', 'the default instance takes no flag');
    });
  });

  it('never asks the instance doing the asking', async () => {
    const asked: string[] = [];
    await attributePort(999, SELF, probe({ info: async p => { asked.push(p); return { project: 'Proj', pid: 1 }; } }), [SELF, E2E]);
    assert.ok(!asked.includes(SELF));
  });

  it('says nothing when every daemon answered and none claimed it', async () => {
    // A stray `node server.js` on a devup port is not another instance, and
    // saying it is sends someone to stop a daemon that is innocent.
    const found = await attributePort(31337, SELF, probe(), [SELF, E2E]);
    assert.equal(found, null);
  });

  it('falls back to the only other instance when it could not be asked', async () => {
    // Too old for a control plane, or still booting: a good hint beats none.
    const found = await attributePort(31337, SELF, probe({
      info: async () => { throw new Error('not answering'); },
    }), [SELF, E2E]);
    assert.equal(found, null, 'and with nothing known about it, nothing to say');
  });

  it('uses the fallback only when something was unreachable', async () => {
    // One reachable that denies it, one that cannot be asked: the reachable
    // one is the only thing we know, and something *was* unreachable.
    const found = await attributePort(31337, SELF, probe({
      info: async path => { if (path === CI) throw new Error('down'); return { project: 'Proj', instance: 'e2e', pid: 200 }; },
    }), [SELF, E2E, CI]);
    assert.equal(found, null, 'two others and no claim: guessing between them would be worse');
  });

  it('says nothing when no other instance is running', async () => {
    assert.equal(await attributePort(1, SELF, probe(), [SELF]), null);
    assert.equal(await attributePort(null, SELF, probe(), []), null);
  });

  it('does not ask for status when there is no holder pid', async () => {
    let statuses = 0;
    await attributePort(null, SELF, probe({ status: async () => { statuses++; return { services: [] }; } }), [SELF, E2E]);
    assert.equal(statuses, 0);
  });
});
