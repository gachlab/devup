import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { TraefikProvider } from '../../../src/proxy-config/traefik.js';
import type { ProxyOpts, ServiceState } from '../../../src/proxy-config/types.js';

const baseOpts: ProxyOpts = {
  host: '172.17.0.1', domain: 'dev.local',
  routes: { 'app-web': '', 'app-api': 'app-api', 'staff-web': 'staff' },
  tls: true, entrypoint: 'websecure',
  confPath: '/tmp/test-traefik.yaml',
};

function svc(health: 'up' | 'down', port = 3000): ServiceState {
  return { port, health };
}

describe('TraefikProvider', () => {
  const provider = new TraefikProvider();

  it('has name traefik', () => assert.equal(provider.name, 'traefik'));

  it('generates empty config when no services up', () => {
    const services = new Map<string, ServiceState>([['app-web', svc('down', 4201)]]);
    const yaml = provider.generate(services, baseOpts);
    assert.ok(yaml.includes('routers: {}'));
  });

  it('only includes health=up services', () => {
    const services = new Map<string, ServiceState>([
      ['app-web', svc('up', 4201)],
      ['app-api', svc('down', 3000)],
    ]);
    const yaml = provider.generate(services, baseOpts);
    assert.ok(yaml.includes('app-web'));
    assert.ok(!yaml.includes('app-api'));
  });

  it('generates correct Host rules', () => {
    const services = new Map<string, ServiceState>([
      ['app-web', svc('up', 4201)],
      ['app-api', svc('up', 3000)],
    ]);
    const yaml = provider.generate(services, baseOpts);
    assert.ok(yaml.includes('Host(`dev.local`)'));
    assert.ok(yaml.includes('Host(`app-api.dev.local`)'));
  });

  it('uses configurable host in URLs', () => {
    const services = new Map<string, ServiceState>([['app-api', svc('up', 3000)]]);
    const yaml = provider.generate(services, { ...baseOpts, host: '127.0.0.1' });
    assert.ok(yaml.includes('http://127.0.0.1:3000'));
  });

  it('uses realPort when available', () => {
    const services = new Map<string, ServiceState>([['app-api', { port: 3000, health: 'up', realPort: 13000 }]]);
    const yaml = provider.generate(services, baseOpts);
    assert.ok(yaml.includes(':13000'));
  });

  it('includes TLS when enabled', () => {
    const services = new Map<string, ServiceState>([['app-web', svc('up', 4201)]]);
    const yaml = provider.generate(services, { ...baseOpts, tls: true });
    assert.ok(yaml.includes('certResolver: le'));
  });

  it('excludes TLS when disabled', () => {
    const services = new Map<string, ServiceState>([['app-web', svc('up', 4201)]]);
    const yaml = provider.generate(services, { ...baseOpts, tls: false });
    assert.ok(!yaml.includes('tls'));
  });

  it('uses configurable entrypoint', () => {
    const services = new Map<string, ServiceState>([['app-web', svc('up', 4201)]]);
    const yaml = provider.generate(services, { ...baseOpts, entrypoint: 'web' });
    assert.ok(yaml.includes('- web'));
  });

  it('skips services not in routes', () => {
    const services = new Map<string, ServiceState>([['unknown-svc', svc('up', 9999)]]);
    const yaml = provider.generate(services, baseOpts);
    assert.ok(yaml.includes('routers: {}'));
  });

  it('write creates file', () => {
    const path = '/tmp/ds-test-traefik-write.yaml';
    try {
      provider.write('test content', { ...baseOpts, confPath: path });
      assert.ok(existsSync(path));
    } finally {
      try { unlinkSync(path); } catch {}
    }
  });

  it('clear writes empty config', () => {
    const path = '/tmp/ds-test-traefik-clear.yaml';
    try {
      provider.clear({ ...baseOpts, confPath: path });
      const content = readFileSync(path, 'utf8');
      assert.ok(content.includes('routers: {}'));
    } finally {
      try { unlinkSync(path); } catch {}
    }
  });
});
