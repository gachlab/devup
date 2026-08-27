import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOriginMap, resolveRemoteTarget } from '../../../src/remote/target.js';
import type { EnvironmentConfig } from '../../../src/config/types.js';

const routes = {
  'app-web': '',
  'check-in-api': 'check-in-api',
  'app-api': 'app-api',
};

describe('resolveRemoteTarget', () => {
  it('builds the host from proxy.routes and the environment domain', () => {
    const env: EnvironmentConfig = { domain: 'qa.norelian.com' };
    assert.equal(
      resolveRemoteTarget('check-in-api', env, routes),
      'https://check-in-api.qa.norelian.com',
    );
  });

  it('uses the bare domain for a route of ""', () => {
    // The root frontend. An empty route is a real answer, not a missing one —
    // reading it as falsy would leave the whole app unreachable.
    const env: EnvironmentConfig = { domain: 'qa.norelian.com' };
    assert.equal(resolveRemoteTarget('app-web', env, routes), 'https://qa.norelian.com');
  });

  it('honours tls: false', () => {
    const env: EnvironmentConfig = { domain: 'dev.local', tls: false };
    assert.equal(resolveRemoteTarget('app-api', env, routes), 'http://app-api.dev.local');
  });

  it('targets win over the domain', () => {
    const env: EnvironmentConfig = {
      domain: 'qa.norelian.com',
      targets: { 'app-api': 'https://api-legacy.qa.norelian.com' },
    };
    assert.equal(resolveRemoteTarget('app-api', env, routes), 'https://api-legacy.qa.norelian.com');
  });

  it('resolves a target with no proxy.routes at all', () => {
    const env: EnvironmentConfig = { targets: { backend: 'https://api.qa.inprovider.cl' } };
    assert.equal(resolveRemoteTarget('backend', env, undefined), 'https://api.qa.inprovider.cl');
  });

  it('strips a trailing slash so origins compare equal', () => {
    const env: EnvironmentConfig = { targets: { backend: 'https://api.qa.inprovider.cl/' } };
    assert.equal(resolveRemoteTarget('backend', env, undefined), 'https://api.qa.inprovider.cl');
  });

  it('returns null for a service with no route and no target', () => {
    const env: EnvironmentConfig = { domain: 'qa.norelian.com' };
    assert.equal(resolveRemoteTarget('events-api', env, routes), null);
  });

  it('returns null when the environment names no domain and no target', () => {
    assert.equal(resolveRemoteTarget('app-api', {}, routes), null);
  });
});

describe('buildOriginMap', () => {
  it('maps every remote origin back to its local port', () => {
    const map = buildOriginMap(new Map([
      ['app-api', { target: 'https://app-api.qa.norelian.com', port: 3000 }],
      ['authorization-api', { target: 'https://authorization-api.qa.norelian.com', port: 3002 }],
    ]));
    assert.equal(map.get('https://app-api.qa.norelian.com'), 'http://localhost:3000');
    assert.equal(map.get('https://authorization-api.qa.norelian.com'), 'http://localhost:3002');
  });
});
