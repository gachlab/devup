import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NginxProvider } from '../../../src/proxy-config/nginx.js';
import type { ServiceState, ProxyOpts } from '../../../src/proxy-config/types.js';

const baseOpts: ProxyOpts = {
  host: '172.17.0.1', domain: 'dev.local',
  routes: { 'app-web': '', 'api': 'api', 'auth': 'auth' },
  tls: true, entrypoint: 'websecure', confPath: '/tmp/devup-nginx.conf',
};

function states(arr: Array<{ name: string; port: number; health?: 'up' | 'down'; realPort?: number }>) {
  const m = new Map<string, ServiceState>();
  for (const s of arr) m.set(s.name, { port: s.port, health: s.health ?? 'up', realPort: s.realPort });
  return m;
}

describe('NginxProvider', () => {
  it('name is nginx', () => assert.equal(new NginxProvider().name, 'nginx'));

  it('skips services with health !== up', () => {
    const out = new NginxProvider().generate(
      states([{ name: 'app-web', port: 4000, health: 'down' }]),
      baseOpts,
    );
    assert.ok(!out.includes('app-web'));
  });

  it('skips services not in routes map', () => {
    const out = new NginxProvider().generate(
      states([{ name: 'ghost', port: 5000 }]),
      baseOpts,
    );
    assert.ok(!out.includes('ghost'));
  });

  it('renders TLS server block when tls=true', () => {
    const out = new NginxProvider().generate(
      states([{ name: 'api', port: 3000 }]),
      baseOpts,
    );
    assert.match(out, /listen 443 ssl;/);
    assert.match(out, /server_name api\.dev\.local;/);
    assert.match(out, /ssl_certificate\s+\/etc\/nginx\/certs\/api\.dev\.local\.crt;/);
    assert.match(out, /proxy_pass http:\/\/172\.17\.0\.1:3000;/);
  });

  it('uses root domain when sub is empty string', () => {
    const out = new NginxProvider().generate(
      states([{ name: 'app-web', port: 4000 }]),
      baseOpts,
    );
    assert.match(out, /server_name dev\.local;/);
  });

  it('renders plain http when tls=false', () => {
    const out = new NginxProvider().generate(
      states([{ name: 'api', port: 3000 }]),
      { ...baseOpts, tls: false },
    );
    assert.match(out, /listen 80;/);
    assert.ok(!out.includes('ssl_certificate'));
  });

  it('uses realPort when present (lazy mode)', () => {
    const out = new NginxProvider().generate(
      states([{ name: 'api', port: 3000, realPort: 13000 }]),
      baseOpts,
    );
    assert.match(out, /proxy_pass http:\/\/172\.17\.0\.1:13000;/);
  });

  it('emits placeholder when no healthy services', () => {
    const out = new NginxProvider().generate(new Map(), baseOpts);
    assert.match(out, /no healthy services/);
  });

  it('writes file and creates parent dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-nx-'));
    try {
      const file = join(dir, 'nested', 'nginx.conf');
      const p = new NginxProvider();
      p.write('server {}\n', { ...baseOpts, confPath: file });
      assert.equal(readFileSync(file, 'utf8'), 'server {}\n');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('clear() writes the empty placeholder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-nx-'));
    try {
      const file = join(dir, 'nginx.conf');
      const p = new NginxProvider();
      p.clear({ ...baseOpts, confPath: file });
      assert.match(readFileSync(file, 'utf8'), /no healthy services/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
