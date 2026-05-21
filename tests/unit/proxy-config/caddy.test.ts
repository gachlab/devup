import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CaddyProvider } from '../../../src/proxy-config/caddy.js';
import type { ServiceState, ProxyOpts } from '../../../src/proxy-config/types.js';

const baseOpts: ProxyOpts = {
  host: 'host.docker.internal', domain: 'dev.local',
  routes: { 'app-web': '', 'api': 'api' },
  tls: true, entrypoint: 'websecure', confPath: '/tmp/devup.Caddyfile',
};

function states(arr: Array<{ name: string; port: number; health?: 'up' | 'down'; realPort?: number }>) {
  const m = new Map<string, ServiceState>();
  for (const s of arr) m.set(s.name, { port: s.port, health: s.health ?? 'up', realPort: s.realPort });
  return m;
}

describe('CaddyProvider', () => {
  it('name is caddy', () => assert.equal(new CaddyProvider().name, 'caddy'));

  it('renders site addr and reverse_proxy', () => {
    const out = new CaddyProvider().generate(
      states([{ name: 'api', port: 3000 }]),
      baseOpts,
    );
    assert.match(out, /^api\.dev\.local \{/m);
    assert.match(out, /reverse_proxy host\.docker\.internal:3000/);
  });

  it('uses http:// prefix when tls=false', () => {
    const out = new CaddyProvider().generate(
      states([{ name: 'api', port: 3000 }]),
      { ...baseOpts, tls: false },
    );
    assert.match(out, /^http:\/\/api\.dev\.local \{/m);
  });

  it('uses root domain when sub is empty', () => {
    const out = new CaddyProvider().generate(
      states([{ name: 'app-web', port: 4000 }]),
      baseOpts,
    );
    assert.match(out, /^dev\.local \{/m);
  });

  it('skips unhealthy services', () => {
    const out = new CaddyProvider().generate(
      states([{ name: 'api', port: 3000, health: 'down' }]),
      baseOpts,
    );
    assert.ok(!out.includes('api.dev.local'));
  });

  it('uses realPort when present (lazy mode)', () => {
    const out = new CaddyProvider().generate(
      states([{ name: 'api', port: 3000, realPort: 13000 }]),
      baseOpts,
    );
    assert.match(out, /reverse_proxy host\.docker\.internal:13000/);
  });

  it('empty placeholder when no healthy services', () => {
    const out = new CaddyProvider().generate(new Map(), baseOpts);
    assert.match(out, /no healthy services/);
  });

  it('write + clear', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-cad-'));
    try {
      const file = join(dir, 'nested', 'Caddyfile');
      const p = new CaddyProvider();
      p.write('api.test { reverse_proxy 127.0.0.1:1 }\n', { ...baseOpts, confPath: file });
      assert.ok(readFileSync(file, 'utf8').includes('reverse_proxy 127.0.0.1:1'));
      p.clear({ ...baseOpts, confPath: file });
      assert.match(readFileSync(file, 'utf8'), /no healthy services/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
