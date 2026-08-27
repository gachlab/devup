import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allHeldPorts, resolveRemote } from '../../../src/remote/classifier.js';
import type { DevStackConfig, ServiceConfig } from '../../../src/config/types.js';

const svc = (name: string, port: number): ServiceConfig => ({
  name, cwd: '.', cmd: 'node', args: ['i.js'], type: 'api', port, phase: 0,
});

const all = [svc('app-api', 3000), svc('check-in-api', 3050), svc('rules-api', 3007)];
const config: DevStackConfig = {
  name: 'test',
  services: all,
  proxy: { provider: 'traefik', routes: { 'app-api': 'app-api', 'check-in-api': 'check-in-api', 'rules-api': 'rules-api' } },
  environments: { qa: { domain: 'qa.test' } },
};

describe('resolveRemote', () => {
  it('is null without the flag, so a plain local boot is unchanged', () => {
    assert.equal(resolveRemote(config, all, undefined), null);
  });

  it('resolves the blanket form against the local selection', () => {
    const r = resolveRemote(config, [svc('check-in-api', 3050)], 'qa')!;
    assert.deepEqual(r.remote.map(x => x.svc.name), ['app-api', 'rules-api']);
  });

  it('throws on an unknown environment rather than degrading to a local boot', () => {
    assert.throws(() => resolveRemote(config, all, 'prod'), /Unknown environment/);
  });
});

describe('allHeldPorts', () => {
  it('is just the local selection when nothing is remote', () => {
    const local = [svc('app-api', 3000)];
    assert.deepEqual(allHeldPorts(local, null).map(s => s.port), [3000]);
  });

  it('includes the ports devup binds for remote services', () => {
    // The whole point: under the blanket form those services are absent from
    // the local selection, so the pre-boot scan never looked at their ports —
    // while the explicit `--remote qa:a,b` form did, because there they *are*
    // in the list. Two forms of one flag, opposite behaviour before a single
    // process started.
    const local = [svc('check-in-api', 3050)];
    const r = resolveRemote(config, local, 'qa')!;
    assert.deepEqual(allHeldPorts(local, r).map(s => s.port).sort((a, b) => a - b), [3000, 3007, 3050]);
  });

  it('does not list a port twice under the explicit form', () => {
    // `--remote qa:a,b` leaves those services in the filtered list *and* puts
    // them in the remote set. Listing both gave two entries per port, and
    // `scanPortConflicts` does not dedupe: `--kill-port-conflicts` killed the
    // holder on the first, then reported the second as "survived SIGKILL" and
    // aborted a boot whose port was by then free.
    const r = resolveRemote(config, all, 'qa:app-api,rules-api')!;
    const ports = allHeldPorts(all, r).map(s => s.port);
    assert.deepEqual([...ports].sort((a, b) => a - b), [3000, 3007, 3050]);
    assert.equal(new Set(ports).size, ports.length, `duplicados: ${ports}`);
  });

  it('agrees between the blanket and the explicit form', () => {
    // The regression this guards: the two forms disagreeing about what gets
    // scanned. Same services remote, same ports held, either way you say it.
    const blanket = resolveRemote(config, [svc('check-in-api', 3050)], 'qa')!;
    const explicit = resolveRemote(config, all, 'qa:app-api,rules-api')!;
    const ports = (r: typeof blanket) => allHeldPorts(all, r).map(s => s.port).sort((a, b) => a - b);
    assert.deepEqual(ports(blanket), ports(explicit));
  });
});
