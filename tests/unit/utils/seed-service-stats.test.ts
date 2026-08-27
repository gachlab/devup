import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildProxyInfo, computeServiceStats, seedServiceStats } from '../../../src/utils/stats.js';

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

describe('buildProxyInfo', () => {
  const provider = { name: 'traefik' };
  const opts = { domain: 'guesthub.remote', tls: false, routes: { 'app-web': '' } };

  it('reports the active proxy', () => {
    const info = buildProxyInfo(provider, opts, true);
    assert.equal(info?.active, true);
    assert.equal(info?.provider, 'traefik');
    assert.deepEqual(info?.routes, { 'app-web': '' });
  });

  it('is null when the caller says it is off', () => {
    // The divergence this replaces: the daemon gated on `--proxy` while the
    // TUI reported `active: true` regardless of its own `p` toggle, so turning
    // proxy-file writing off left `info` and `status` still claiming it was on.
    assert.equal(buildProxyInfo(provider, opts, false), null);
  });

  it('is null when there is no proxy configured at all', () => {
    assert.equal(buildProxyInfo(null, opts, true), null);
    assert.equal(buildProxyInfo(provider, null, true), null);
  });
});

describe('computeServiceStats', () => {
  it('fills in the sampled services and leaves the rest at zero', () => {
    const services = { 'app-api': { cpu: 0, memMB: 0 }, 'web': { cpu: 0, memMB: 0 } };
    const raw = new Map([[4242, { cpuSeconds: 2, rss: 204800 }]]);
    const prev = new Map([['app-api', { time: Date.now() - 1000, cpu: 1 }]]);
    const out = computeServiceStats(services, raw, new Map([[4242, 'app-api']]), prev,
      (total, p) => (total - p) * 100);

    assert.equal(out['app-api']!.memMB, 200);
    assert.ok(out['app-api']!.cpu > 0);
    assert.deepEqual(out['web'], { cpu: 0, memMB: 0 });
  });

  it('ignores a pid it has no name for', () => {
    // A sample can outlive the service it belonged to.
    const services = { 'app-api': { cpu: 0, memMB: 0 } };
    const out = computeServiceStats(services, new Map([[999, { cpuSeconds: 5, rss: 1024 }]]),
      new Map(), new Map(), () => 50);
    assert.deepEqual(out, { 'app-api': { cpu: 0, memMB: 0 } });
  });
});
