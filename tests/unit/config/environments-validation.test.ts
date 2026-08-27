import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, collectWarnings } from '../../../src/config/validator.js';
import type { DevStackConfig } from '../../../src/config/types.js';

const base = (): DevStackConfig => ({
  name: 'test',
  services: [
    { name: 'app-api', cwd: '.', cmd: 'node', args: ['i.js'], type: 'api', port: 3000, phase: 0 },
    { name: 'rules-api', cwd: '.', cmd: 'node', args: ['i.js'], type: 'api', port: 3007, phase: 0 },
  ],
  proxy: { provider: 'traefik', routes: { 'app-api': 'app-api' } },
});

const errorsFor = (config: DevStackConfig) =>
  validateConfig(config, process.cwd()).filter(e => e.field.startsWith('environments'));

describe('environments validation', () => {
  it('accepts an environment with a domain', () => {
    const config = { ...base(), environments: { qa: { domain: 'qa.norelian.com' } } };
    assert.deepEqual(errorsFor(config), []);
  });

  it('rejects an environment that names neither a domain nor targets', () => {
    const config = { ...base(), environments: { qa: {} } };
    assert.match(errorsFor(config)[0]!.message, /needs `domain`.*or `targets`/);
  });

  it('rejects a target for a service that does not exist', () => {
    const config = { ...base(), environments: { qa: { targets: { nope: 'https://x.test' } } } };
    assert.match(errorsFor(config)[0]!.message, /Unknown service: nope/);
  });

  it('rejects a target that is not an absolute http URL', () => {
    const config = { ...base(), environments: { qa: { targets: { 'app-api': 'app-api.qa.test' } } } };
    assert.match(errorsFor(config)[0]!.message, /absolute http\(s\) URL/);
  });

  it('rejects an origin without a scheme', () => {
    // `Origin: qa.norelian.com` is not an origin, and an upstream comparing it
    // against an allowlist quietly fails to match.
    const config = { ...base(), environments: { qa: { domain: 'q.test', origin: 'qa.norelian.com' } } };
    assert.match(errorsFor(config)[0]!.message, /scheme included/);
  });

  it('rejects a healthCheck path that is not rooted', () => {
    const config = { ...base(), environments: { qa: { domain: 'q.test', healthCheck: { path: 'health' } } } };
    assert.match(errorsFor(config)[0]!.message, /must start with "\/"/);
  });
});

describe('environments warnings', () => {
  it('names the services the environment cannot reach', () => {
    // rules-api has no proxy.routes entry and no explicit target, so under
    // `--remote qa` it is neither started nor proxied.
    const config = { ...base(), environments: { qa: { domain: 'qa.norelian.com' } } };
    const warning = collectWarnings(config).find(w => w.field === 'environments.qa');
    assert.ok(warning, 'expected a warning');
    assert.match(warning!.message, /rules-api/);
  });

  it('stays quiet when every service is reachable', () => {
    const config: DevStackConfig = {
      ...base(),
      proxy: { provider: 'traefik', routes: { 'app-api': 'app-api', 'rules-api': 'rules-api' } },
      environments: { qa: { domain: 'qa.norelian.com' } },
    };
    assert.equal(collectWarnings(config).find(w => w.field === 'environments.qa'), undefined);
  });

  it('counts an explicit target as reachable', () => {
    const config: DevStackConfig = {
      ...base(),
      environments: { qa: { domain: 'qa.norelian.com', targets: { 'rules-api': 'https://rules.qa.test' } } },
    };
    assert.equal(collectWarnings(config).find(w => w.field === 'environments.qa'), undefined);
  });
});
