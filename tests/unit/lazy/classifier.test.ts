import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyServices, getLazyRealPort, rewriteServicePort, LAZY_PORT_OFFSET } from '../../../src/lazy/classifier.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const svc = (name: string, port = 3000): ServiceConfig => ({
  name, cwd: '.', cmd: 'node', args: ['--port', String(port), 'index.js'],
  type: 'api', port, phase: 0,
});

describe('classifyServices', () => {
  it('splits by alwaysOn config', () => {
    const svcs = [svc('a'), svc('b'), svc('c')];
    const { alwaysOn, lazy } = classifyServices(svcs, { alwaysOn: ['a', 'c'] });
    assert.deepEqual(alwaysOn.map(s => s.name), ['a', 'c']);
    assert.deepEqual(lazy.map(s => s.name), ['b']);
  });

  it('all lazy when no config', () => {
    const svcs = [svc('a'), svc('b')];
    const { alwaysOn, lazy } = classifyServices(svcs);
    assert.equal(alwaysOn.length, 0);
    assert.equal(lazy.length, 2);
  });

  it('all alwaysOn when all listed', () => {
    const svcs = [svc('a'), svc('b')];
    const { alwaysOn, lazy } = classifyServices(svcs, { alwaysOn: ['a', 'b'] });
    assert.equal(alwaysOn.length, 2);
    assert.equal(lazy.length, 0);
  });
});

describe('getLazyRealPort', () => {
  it('adds offset', () => assert.equal(getLazyRealPort(3000), 3000 + LAZY_PORT_OFFSET));
});

describe('rewriteServicePort', () => {
  it('rewrites port in args and adds PORT_OVERRIDE', () => {
    const s = svc('api', 3000);
    const rewritten = rewriteServicePort(s);
    assert.equal(rewritten.realPort, 13000);
    assert.equal(rewritten.port, 13000);
    assert.equal(rewritten.originalPort, 3000);
    assert.ok(rewritten.args.includes('13000'));
    assert.ok(!rewritten.args.includes('3000'));
    assert.equal(rewritten.extraEnv!['PORT_OVERRIDE'], '13000');
  });

  it('preserves non-port args', () => {
    const s = svc('api', 3000);
    const rewritten = rewriteServicePort(s);
    assert.ok(rewritten.args.includes('--port'));
    assert.ok(rewritten.args.includes('index.js'));
  });

  it('preserves existing extraEnv', () => {
    const s = { ...svc('api', 3000), extraEnv: { FOO: 'bar' } };
    const rewritten = rewriteServicePort(s);
    assert.equal(rewritten.extraEnv!['FOO'], 'bar');
    assert.equal(rewritten.extraEnv!['PORT_OVERRIDE'], '13000');
  });
});
