import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectProxyProvider } from '../../../src/proxy-config/detect.js';

describe('detectProxyProvider', () => {
  it('returns TraefikProvider for "traefik"', () => {
    const provider = detectProxyProvider('traefik');
    assert.equal(provider.name, 'traefik');
  });

  it('throws for unknown provider', () => {
    assert.throws(() => detectProxyProvider('nginx'), /Unknown proxy provider.*nginx/);
  });

  it('error message lists available providers', () => {
    try {
      detectProxyProvider('caddy');
      assert.fail('should throw');
    } catch (e: any) {
      assert.ok(e.message.includes('traefik'));
    }
  });
});
