import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedServiceStats } from '../../../src/utils/stats.js';

type S = { pid: number | null; remote?: unknown };
const states = (entries: Array<[string, S]>) => new Map<string, S>(entries);

describe('seedServiceStats', () => {
  it('seeds a running service at zero and offers its pid for sampling', () => {
    const { services, pids, pidToName } = seedServiceStats(states([
      ['app-api', { pid: 4242 }],
    ]));
    assert.deepEqual(services, { 'app-api': { cpu: 0, memMB: 0 } });
    assert.deepEqual(pids, [4242]);
    assert.equal(pidToName.get(4242), 'app-api');
  });

  it('keeps a stopped service, since a pid it could not sample is still a process it has', () => {
    // Distinct from a remote one: this service has a process that just is not
    // running right now, and zero is the right thing to show for it.
    const { services, pids } = seedServiceStats(states([['app-api', { pid: null }]]));
    assert.deepEqual(services, { 'app-api': { cpu: 0, memMB: 0 } });
    assert.deepEqual(pids, []);
  });

  it('omits a remote service entirely rather than reporting it at zero', () => {
    // 0% CPU and 0 MB is a measurement nobody took, and a client cannot tell
    // it apart from a service that is genuinely idle. docs/control-plane.md
    // promises absence for `remote`.
    const { services, pids } = seedServiceStats(states([
      ['app-api', { pid: 4242 }],
      ['rules-api', { pid: null, remote: { envName: 'qa', target: 'https://x.test', readOnly: false } }],
    ]));
    assert.deepEqual(Object.keys(services), ['app-api']);
    assert.deepEqual(pids, [4242]);
  });

  it('never offers a remote service pid, even if one lingered in its state', () => {
    // Defence against the reverse of the hazard: `pid` is never cleared on the
    // paths that stop a service, so a state that became remote after running
    // could still carry a dead one — sampling it would attribute another
    // process's numbers to this name.
    const { services, pids } = seedServiceStats(states([
      ['rules-api', { pid: 9999, remote: { envName: 'qa' } }],
    ]));
    assert.deepEqual(services, {});
    assert.deepEqual(pids, []);
  });
});
