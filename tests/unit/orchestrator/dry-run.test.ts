import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderDryRun } from '../../../src/orchestrator/dry-run.js';
import { TraefikProvider } from '../../../src/proxy-config/traefik.js';
import type { DevStackConfig, ServiceConfig } from '../../../src/config/types.js';
import type { CliArgs } from '../../../src/config/cli.js';

const baseCli: CliArgs = {
  skip: [], lazy: true, lazyTimeout: 10, proxy: false, proxyTls: true, proxyEntrypoint: 'websecure',
  dryRun: true, once: false, onceTimeout: 90, logFile: false,
};

function svc(over: Partial<ServiceConfig>): ServiceConfig {
  return { name: 'x', cwd: '.', cmd: 'node', args: ['index.js'], type: 'api', port: 3000, phase: 0, ...over };
}

describe('renderDryRun', () => {
  it('lists services grouped by phase', () => {
    const config: DevStackConfig = {
      name: 'Demo',
      services: [
        svc({ name: 'a', port: 3000, phase: 0 }),
        svc({ name: 'b', port: 3001, phase: 1 }),
        svc({ name: 'c', port: 3002, phase: 0 }),
      ],
    };
    const out = renderDryRun({ config, services: config.services, cliArgs: { ...baseCli, lazy: false }, env: {}, baseCwd: '.', proxyProvider: null, proxyOpts: null });
    assert.match(out, /Phase 0:[\s\S]*- a/);
    assert.match(out, /Phase 0:[\s\S]*- c/);
    assert.match(out, /Phase 1:[\s\S]*- b/);
  });

  it('shows lazy section when lazy enabled', () => {
    const config: DevStackConfig = {
      name: 'D',
      services: [
        svc({ name: 'core', port: 3000, phase: 0 }),
        svc({ name: 'on-demand', port: 4000, phase: 1 }),
      ],
      lazy: { alwaysOn: ['core'] },
    };
    const out = renderDryRun({ config, services: config.services, cliArgs: baseCli, env: {}, baseCwd: '.', proxyProvider: null, proxyOpts: null });
    assert.match(out, /Lazy \(on-demand\)/);
    assert.match(out, /on-demand/);
    assert.match(out, /proxy\s+:4000\s+→\s+:14000/);
  });

  it('renders proxy yaml when proxy provider given', () => {
    const config: DevStackConfig = {
      name: 'D',
      services: [svc({ name: 'api', port: 3000, phase: 0 })],
    };
    const out = renderDryRun({
      config, services: config.services,
      cliArgs: { ...baseCli, lazy: false, proxy: true },
      env: {}, baseCwd: '.',
      proxyProvider: new TraefikProvider(),
      proxyOpts: {
        host: '127.0.0.1', domain: 'localhost',
        routes: { api: 'api' }, tls: false, entrypoint: 'web',
        confPath: '/tmp/conf.yaml',
      },
    });
    assert.match(out, /Proxy:\s+traefik/);
    assert.match(out, /generated config/);
    assert.match(out, /api:\s*\n\s*rule:/);
  });

  it('shows http health-check tag', () => {
    const config: DevStackConfig = {
      name: 'D',
      services: [svc({ name: 'api', port: 3000, phase: 0, healthCheck: { type: 'http', path: '/healthz' } })],
    };
    const out = renderDryRun({ config, services: config.services, cliArgs: { ...baseCli, lazy: false }, env: {}, baseCwd: '.', proxyProvider: null, proxyOpts: null });
    assert.match(out, /health=http \/healthz/);
  });

  it('renders externals section when configured', () => {
    const config: DevStackConfig = {
      name: 'D',
      services: [svc({ name: 'api', port: 3000, phase: 0 })],
      external: [
        { name: 'mongo', cmd: 'docker compose up -d mongo', port: 27017, healthCheck: { type: 'tcp' } },
        { name: 'redis', cmd: 'docker compose up -d redis' },
      ],
    };
    const out = renderDryRun({ config, services: config.services, cliArgs: { ...baseCli, lazy: false }, env: {}, baseCwd: '.', proxyProvider: null, proxyOpts: null });
    assert.match(out, /Externals \(2\):/);
    assert.match(out, /mongo.*docker compose.*health=tcp :27017/);
    assert.match(out, /redis.*docker compose/);
  });
});
