import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUpstreamHeaders, localizeLocation, localizeSetCookie,
  resolveHeaderValues, transformResponseHeaders, type RemoteContext,
} from '../../../src/remote/headers.js';
import type { EnvironmentConfig } from '../../../src/config/types.js';

const ctx = (env: EnvironmentConfig, originMap = new Map<string, string>()): RemoteContext => ({
  target: new URL('https://check-in-api.qa.norelian.com'),
  localOrigin: 'http://localhost:3050',
  env,
  originMap,
  setHeaders: resolveHeaderValues(env.headers?.set, { TOKEN: 'abc' }, 'qa'),
});

describe('buildUpstreamHeaders', () => {
  it('rewrites Host to the target so the ingress can route', () => {
    const out = buildUpstreamHeaders({ host: 'localhost:3050' }, ctx({}));
    assert.equal(out.host, 'check-in-api.qa.norelian.com');
  });

  it('keeps the local Host when asked to pass it through', () => {
    const out = buildUpstreamHeaders({ host: 'localhost:3050' }, ctx({ host: 'passthrough' }));
    assert.equal(out.host, 'localhost:3050');
  });

  it('sets Origin even when the request arrived without one', () => {
    // Server-to-server calls carry no Origin, and upstreams that index on it
    // (a tenant lookup, an allowlist `.includes`) either miss or throw.
    const out = buildUpstreamHeaders({ host: 'localhost:3050' }, ctx({ origin: 'https://demoa.app.inprovider.cl' }));
    assert.equal(out.origin, 'https://demoa.app.inprovider.cl');
  });

  it('leaves Origin alone when the environment does not configure one', () => {
    const out = buildUpstreamHeaders({ host: 'localhost:3050', origin: 'http://localhost:4201' }, ctx({}));
    assert.equal(out.origin, 'http://localhost:4201');
  });

  it('rewrites Referer while keeping its path', () => {
    const out = buildUpstreamHeaders(
      { host: 'localhost:3050', referer: 'http://localhost:3050/login?next=/home' },
      ctx({ origin: 'https://qa.norelian.com' }),
    );
    assert.equal(out.referer, 'https://qa.norelian.com/login?next=/home');
  });

  it('does not invent a Referer that was not sent', () => {
    const out = buildUpstreamHeaders({ host: 'localhost:3050' }, ctx({ origin: 'https://qa.norelian.com' }));
    assert.equal(out.referer, undefined);
  });

  it('drops inbound forwarded headers by default', () => {
    // A local reverse proxy names a local host in these, and an upstream that
    // resolves a tenant from them finds nothing — or the wrong one.
    const out = buildUpstreamHeaders(
      { host: 'localhost:3050', 'x-forwarded-host': 'check-in-api.guesthub.remote', 'x-forwarded-for': '::1' },
      ctx({}),
    );
    assert.equal(out['x-forwarded-host'], undefined);
    assert.equal(out['x-forwarded-for'], undefined);
  });

  it('sends forwarded headers when the environment opts in', () => {
    const out = buildUpstreamHeaders({ host: 'localhost:3050' }, ctx({ forwarded: true }));
    assert.equal(out['x-forwarded-host'], 'localhost:3050');
    assert.equal(out['x-forwarded-proto'], 'http');
  });

  it('strips hop-by-hop headers', () => {
    const out = buildUpstreamHeaders(
      { host: 'localhost:3050', connection: 'keep-alive', 'transfer-encoding': 'chunked' },
      ctx({}),
    );
    assert.equal(out.connection, undefined);
    assert.equal(out['transfer-encoding'], undefined);
  });

  it('applies remove before set, so set wins', () => {
    const out = buildUpstreamHeaders(
      { host: 'localhost:3050', 'x-tenant': 'local' },
      ctx({ headers: { remove: ['x-tenant'], set: { 'X-Tenant': 'qa' } } }),
    );
    assert.equal(out['x-tenant'], 'qa');
  });

  it('lets headers.set restore a forwarded header the default dropped', () => {
    const out = buildUpstreamHeaders(
      { host: 'localhost:3050', 'x-forwarded-host': 'local' },
      ctx({ headers: { set: { 'X-Forwarded-Host': 'demoa.app.inprovider.cl' } } }),
    );
    assert.equal(out['x-forwarded-host'], 'demoa.app.inprovider.cl');
  });
});

describe('resolveHeaderValues', () => {
  it('interpolates ${VAR} from the environment', () => {
    const out = resolveHeaderValues({ authorization: 'Bearer ${TOKEN}' }, { TOKEN: 'abc' }, 'qa');
    assert.equal(out.authorization, 'Bearer abc');
  });

  it('throws on a missing variable instead of sending a blank header', () => {
    // A blank Authorization reaches the upstream as an anonymous request, and
    // the 401 that comes back reads as bad credentials, not a typo.
    assert.throws(
      () => resolveHeaderValues({ authorization: 'Bearer ${NOPE}' }, {}, 'qa'),
      /environments\.qa\.headers\.set\["authorization"\].*\$\{NOPE\}/,
    );
  });
});

describe('localizeSetCookie', () => {
  it('drops Domain and Secure so the cookie sticks on localhost', () => {
    const out = localizeSetCookie(
      'access_token=xyz; Domain=.qa.norelian.com; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400',
    );
    assert.ok(!/domain=/i.test(out), `Domain survived: ${out}`);
    assert.ok(!/;\s*secure/i.test(out), `Secure survived: ${out}`);
    assert.ok(out.includes('access_token=xyz'));
    assert.ok(out.includes('HttpOnly'));
    assert.ok(out.includes('SameSite=Strict'));
    assert.ok(out.includes('Max-Age=86400'));
  });

  it('downgrades SameSite=None to Lax, since None without Secure is rejected', () => {
    const out = localizeSetCookie('sid=1; Domain=.qa.norelian.com; Secure; SameSite=None');
    assert.ok(!/samesite=none/i.test(out), `SameSite=None survived: ${out}`);
    assert.ok(out.includes('SameSite=Lax'));
  });

  it('leaves a cookie that needed nothing untouched', () => {
    assert.equal(localizeSetCookie('sid=1; Path=/; HttpOnly'), 'sid=1; Path=/; HttpOnly');
  });
});

describe('localizeLocation', () => {
  const originMap = new Map([
    ['https://check-in-api.qa.norelian.com', 'http://localhost:3050'],
    ['https://qa.norelian.com', 'http://localhost:4201'],
  ]);

  it('rewrites a redirect to the service itself', () => {
    assert.equal(
      localizeLocation('https://check-in-api.qa.norelian.com/next?a=1#top', originMap, 'http://localhost:3050', 'https://check-in-api.qa.norelian.com'),
      'http://localhost:3050/next?a=1#top',
    );
  });

  it('rewrites a redirect that crosses to another remote service', () => {
    // A login answers with a 302 to the app, not to itself. Localizing only
    // same-origin redirects walks the browser out of the local stack exactly
    // when it is carrying a fresh session.
    assert.equal(
      localizeLocation('https://qa.norelian.com/home', originMap, 'http://localhost:3050', 'https://check-in-api.qa.norelian.com'),
      'http://localhost:4201/home',
    );
  });

  it('leaves a host devup does not serve alone', () => {
    const url = 'https://accounts.google.com/o/oauth2/auth?client_id=1';
    assert.equal(localizeLocation(url, originMap, 'http://localhost:3050', 'https://check-in-api.qa.norelian.com'), url);
  });

  it('leaves a relative location alone', () => {
    assert.equal(localizeLocation('/dashboard', originMap, 'http://localhost:3050', 'https://check-in-api.qa.norelian.com'), '/dashboard');
  });
});

describe('transformResponseHeaders', () => {
  it('restores the local origin in the CORS header when origin was rewritten', () => {
    // The upstream echoes back the origin it was given — the rewritten one —
    // and a browser on localhost rejects a reply that allows somebody else.
    const out = transformResponseHeaders(
      { 'access-control-allow-origin': 'https://qa.norelian.com' },
      ctx({ origin: 'https://qa.norelian.com' }),
      'http://localhost:4201',
    );
    assert.equal(out['access-control-allow-origin'], 'http://localhost:4201');
  });

  it('leaves a wildcard CORS header alone', () => {
    const out = transformResponseHeaders(
      { 'access-control-allow-origin': '*' },
      ctx({ origin: 'https://qa.norelian.com' }),
      'http://localhost:4201',
    );
    assert.equal(out['access-control-allow-origin'], '*');
  });

  it('does not touch the CORS header when origin is not rewritten', () => {
    const out = transformResponseHeaders(
      { 'access-control-allow-origin': 'http://localhost:4201' },
      ctx({}),
      'http://localhost:4201',
    );
    assert.equal(out['access-control-allow-origin'], 'http://localhost:4201');
  });

  it('localizes every Set-Cookie in the response', () => {
    const out = transformResponseHeaders(
      { 'set-cookie': ['a=1; Domain=.qa.norelian.com; Secure', 'b=2; Domain=.qa.norelian.com; Secure'] },
      ctx({}),
      undefined,
    );
    assert.deepEqual(out['set-cookie'], ['a=1', 'b=2']);
  });

  it('passes cookies through untouched when asked to', () => {
    const raw = ['a=1; Domain=.qa.norelian.com; Secure'];
    const out = transformResponseHeaders({ 'set-cookie': raw }, ctx({ cookies: 'passthrough' }), undefined);
    assert.deepEqual(out['set-cookie'], raw);
  });

  it('passes Location through untouched when asked to', () => {
    const url = 'https://check-in-api.qa.norelian.com/next';
    const out = transformResponseHeaders({ location: url }, ctx({ location: 'passthrough' }), undefined);
    assert.equal(out.location, url);
  });
});
