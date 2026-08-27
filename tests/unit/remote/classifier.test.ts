import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRemote, parseRemoteSelection, releaseRemoteProxy } from '../../../src/remote/classifier.js';
import type { EnvironmentConfig, ServiceConfig } from '../../../src/config/types.js';

const svc = (name: string, port: number): ServiceConfig => ({
  name, cwd: '.', cmd: 'node', args: ['index.js'], type: 'api', port, phase: 0,
});

const all = [svc('configurations-api', 2999), svc('app-api', 3000), svc('check-in-api', 3050), svc('rules-api', 3007)];
const routes = {
  'configurations-api': 'configurations-api',
  'app-api': 'app-api',
  'check-in-api': 'check-in-api',
};
const qa: EnvironmentConfig = { domain: 'qa.norelian.com' };

describe('classifyRemote', () => {
  it('returns everything local when no environment is selected', () => {
    const out = classifyRemote(all, all, null, routes);
    assert.equal(out.local.length, 4);
    assert.equal(out.remote.length, 0);
  });

  it('proxies everything the local selection left out', () => {
    const local = [svc('check-in-api', 3050)];
    const out = classifyRemote(all, local, { envName: 'qa', env: qa }, routes);
    assert.deepEqual(out.local.map(s => s.name), ['check-in-api']);
    assert.deepEqual(out.remote.map(r => r.svc.name), ['configurations-api', 'app-api']);
  });

  it('reports a service with no route instead of dropping it', () => {
    // rules-api is absent from proxy.routes, so the environment cannot reach
    // it. Leaving it out silently looks exactly like a slow start.
    const out = classifyRemote(all, [], { envName: 'qa', env: qa }, routes);
    assert.deepEqual(out.unresolved, ['rules-api']);
    assert.ok(!out.remote.some(r => r.svc.name === 'rules-api'));
  });

  it('the explicit list wins over a profile', () => {
    // Naming a service on the command line is more specific than the profile
    // it happens to belong to.
    const local = [svc('app-api', 3000), svc('check-in-api', 3050)];
    const out = classifyRemote(all, local, { envName: 'qa', env: qa, only: ['app-api'] }, routes);
    assert.deepEqual(out.local.map(s => s.name), ['check-in-api']);
    assert.deepEqual(out.remote.map(r => r.svc.name), ['app-api']);
  });

  it('the blanket form defers to the profile', () => {
    const local = [svc('app-api', 3000)];
    const out = classifyRemote(all, local, { envName: 'qa', env: qa }, routes);
    assert.ok(out.local.some(s => s.name === 'app-api'));
    assert.ok(!out.remote.some(r => r.svc.name === 'app-api'));
  });

  it('carries the target and the environment on each spec', () => {
    const out = classifyRemote(all, [], { envName: 'qa', env: qa }, routes);
    const appApi = out.remote.find(r => r.svc.name === 'app-api')!;
    assert.equal(appApi.target, 'https://app-api.qa.norelian.com');
    assert.equal(appApi.envName, 'qa');
    assert.equal(appApi.env, qa);
  });
});

describe('parseRemoteSelection', () => {
  const environments = { qa: qa, staging: { domain: 'stg.norelian.com' } };

  it('reads the blanket form', () => {
    const sel = parseRemoteSelection('qa', environments);
    assert.equal(sel.envName, 'qa');
    assert.equal(sel.only, undefined);
  });

  it('reads the explicit list', () => {
    const sel = parseRemoteSelection('qa:app-api, rules-api', environments);
    assert.deepEqual(sel.only, ['app-api', 'rules-api']);
  });

  it('throws on an unknown environment, listing the ones that exist', () => {
    // A typo must not degrade into a plain local boot: the services it was
    // meant to cover would just be missing.
    assert.throws(() => parseRemoteSelection('prod', environments), /Unknown environment: "prod".*qa, staging/s);
  });

  it('says so when the config defines no environments at all', () => {
    assert.throws(() => parseRemoteSelection('qa', undefined), /No environments defined/);
  });

  it('rejects an empty service list', () => {
    assert.throws(() => parseRemoteSelection('qa:', environments), /needs at least one service name/);
  });
});

describe('releaseRemoteProxy', () => {
  it('destroys the proxy and forgets it', () => {
    let destroyed = false;
    const proxies = new Map([['app-api', { destroy: () => { destroyed = true; } }]]);
    assert.equal(releaseRemoteProxy(proxies, 'app-api'), true);
    assert.equal(destroyed, true);
    assert.equal(proxies.has('app-api'), false);
  });

  it('reports false for a service that had none', () => {
    assert.equal(releaseRemoteProxy(new Map(), 'app-api'), false);
    assert.equal(releaseRemoteProxy(undefined, 'app-api'), false);
  });
});
