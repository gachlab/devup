import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraefikProvider } from '../../../src/proxy-config/traefik.js';
import type { ServiceState, ProxyOpts } from '../../../src/proxy-config/types.js';

const opts: ProxyOpts = {
  provider: 'traefik', domain: 'guesthub.remote', host: '127.0.0.1',
  confPath: '/tmp/x.yml', tls: false, entrypoint: 'web',
  routes: { 'check-in-api': 'check-in-api' },
};

describe('reverse-proxy routes for a remote service', () => {
  it('routes to devup on the configured port, not to the environment', () => {
    // The whole point: the domain keeps working, and what answers behind it is
    // devup's proxy — which then forwards. A route pointing straight at the
    // environment would skip every header rule this feature exists for.
    const states = new Map<string, ServiceState>([
      ['check-in-api', { port: 3050, health: 'up' }],
    ]);
    const out = new TraefikProvider().generate(states, opts);
    assert.match(out, /Host\(`check-in-api\.guesthub\.remote`\)/);
    assert.match(out, /url: "http:\/\/127\.0\.0\.1:3050"/);
  });

  it('drops the route while the environment is unreachable', () => {
    // Health for a remote service comes from the probe against the upstream,
    // so `down` here means the environment stopped answering — and a route to
    // a proxy that can only return 502 is worse than no route.
    const states = new Map<string, ServiceState>([
      ['check-in-api', { port: 3050, health: 'down' }],
    ]);
    const out = new TraefikProvider().generate(states, opts);
    assert.ok(!out.includes('check-in-api'), out);
  });

  it('never applies the lazy port offset to a remote service', () => {
    // A remote service is not rewritten, so `realPort` is undefined and `port`
    // is already the real one. If it ever carried an offset the generated
    // upstream would point at a port nothing is listening on.
    const states = new Map<string, ServiceState>([
      ['check-in-api', { port: 3050, health: 'up', realPort: undefined }],
    ]);
    const out = new TraefikProvider().generate(states, opts);
    assert.ok(!out.includes('13050'), out);
  });
});
