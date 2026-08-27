import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootEnvName, resolveToggle } from '../../../src/remote/toggle.js';
import type { DevStackConfig } from '../../../src/config/types.js';

const config = (environments?: DevStackConfig['environments']): DevStackConfig => ({
  name: 'test', services: [], environments,
});

describe('resolveToggle', () => {
  it('brings a remote service back local', () => {
    const out = resolveToggle(config({ qa: { domain: 'q.test' } }), true, 'qa');
    assert.deepEqual(out, { envName: null });
  });

  it('prefers the environment this run was started against', () => {
    const cfg = config({ qa: { domain: 'q.test' }, staging: { domain: 's.test' } });
    assert.deepEqual(resolveToggle(cfg, false, 'staging'), { envName: 'staging' });
  });

  it('uses the only environment there is', () => {
    assert.deepEqual(resolveToggle(config({ qa: { domain: 'q.test' } }), false, undefined), { envName: 'qa' });
  });

  it('refuses to guess between environments', () => {
    // A key press carries no environment name. Picking one would point a
    // service at a shared system nobody named — the exact thing this feature
    // has to be loud about.
    const cfg = config({ qa: { domain: 'q.test' }, staging: { domain: 's.test' } });
    const out = resolveToggle(cfg, false, undefined);
    assert.ok('error' in out);
    assert.match(out.error, /several environments \(qa, staging\)/);
    assert.match(out.error, /devup ctl remote/);
  });

  it('ignores a boot environment that is no longer in the config', () => {
    // `--watch-config` can remove one under a running stack.
    const cfg = config({ qa: { domain: 'q.test' }, staging: { domain: 's.test' } });
    assert.ok('error' in resolveToggle(cfg, false, 'gone'));
  });

  it('says so when the config defines no environments', () => {
    const out = resolveToggle(config(undefined), false, undefined);
    assert.ok('error' in out);
    assert.match(out.error, /no environments defined/);
  });
});

describe('bootEnvName', () => {
  it('takes the environment out of the explicit form', () => {
    assert.equal(bootEnvName('qa:app-api,rules-api'), 'qa');
  });

  it('passes the blanket form through', () => {
    assert.equal(bootEnvName('qa'), 'qa');
  });

  it('is undefined when the flag was not given', () => {
    assert.equal(bootEnvName(undefined), undefined);
    assert.equal(bootEnvName(''), undefined);
  });
});
