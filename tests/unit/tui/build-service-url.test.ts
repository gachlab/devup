import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceUrl } from '../../../src/tui/App.js';
import type { ProxyOpts } from '../../../src/proxy-config/types.js';

const baseProxy: ProxyOpts = {
  host: '127.0.0.1', domain: 'dev.local',
  routes: { 'api': 'api', 'app-web': '', 'admin-web': 'admin' },
  tls: true, entrypoint: 'websecure', confPath: '/tmp/conf.yaml',
};

describe('buildServiceUrl', () => {
  it('falls back to http://localhost when proxy is not active', () => {
    assert.equal(buildServiceUrl('api', 3000, false, baseProxy), 'http://localhost:3000');
  });

  it('falls back when proxyOpts is null', () => {
    assert.equal(buildServiceUrl('api', 3000, true, null), 'http://localhost:3000');
  });

  it('falls back when the service has no proxy route', () => {
    assert.equal(buildServiceUrl('orphan', 3001, true, baseProxy), 'http://localhost:3001');
  });

  it('uses https subdomain when proxy active and TLS on', () => {
    assert.equal(buildServiceUrl('api', 3000, true, baseProxy), 'https://api.dev.local');
  });

  it('uses root domain when route is empty', () => {
    assert.equal(buildServiceUrl('app-web', 4200, true, baseProxy), 'https://dev.local');
  });

  it('uses http:// when TLS disabled', () => {
    const noTls = { ...baseProxy, tls: false };
    assert.equal(buildServiceUrl('admin-web', 4204, true, noTls), 'http://admin.dev.local');
  });
});
