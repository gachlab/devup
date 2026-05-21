import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectProxyProvider } from '../../../src/proxy-config/detect.js';

describe('detectProxyProvider', () => {
  it('returns TraefikProvider for "traefik"', () => assert.equal(detectProxyProvider('traefik').name, 'traefik'));
  it('returns NginxProvider for "nginx"', () => assert.equal(detectProxyProvider('nginx').name, 'nginx'));
  it('returns CaddyProvider for "caddy"', () => assert.equal(detectProxyProvider('caddy').name, 'caddy'));

  it('throws for unknown provider', () => {
    assert.throws(() => detectProxyProvider('haproxy'), /Unknown proxy provider/);
  });

  it('error message lists available providers', () => {
    try {
      detectProxyProvider('unknown');
      assert.fail('should throw');
    } catch (e: any) {
      assert.ok(e.message.includes('traefik'));
      assert.ok(e.message.includes('nginx'));
      assert.ok(e.message.includes('caddy'));
    }
  });
});
