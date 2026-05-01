import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs, filterServices } from '../../../src/config/cli.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const svc = (name: string, type: 'api' | 'web' = 'api'): ServiceConfig => ({
  name, cwd: '.', cmd: 'node', args: [], type, port: 3000, phase: 0,
});

describe('parseCliArgs', () => {
  it('defaults', () => {
    const args = parseCliArgs([]);
    assert.equal(args.lazy, true);
    assert.equal(args.lazyTimeout, 10);
    assert.equal(args.proxy, false);
    assert.equal(args.proxyTls, true);
    assert.equal(args.proxyEntrypoint, 'websecure');
  });

  it('--config', () => assert.equal(parseCliArgs(['--config', 'my.ts']).configPath, 'my.ts'));
  it('--only', () => assert.equal(parseCliArgs(['--only', 'apis']).only, 'apis'));
  it('--skip', () => assert.deepEqual(parseCliArgs(['--skip', 'a,b']).skip, ['a', 'b']));
  it('--services', () => assert.deepEqual(parseCliArgs(['--services', 'x,y']).services, ['x', 'y']));
  it('--no-lazy', () => assert.equal(parseCliArgs(['--no-lazy']).lazy, false));
  it('--timeout', () => assert.equal(parseCliArgs(['--timeout', '20']).lazyTimeout, 20));
  it('--proxy flags', () => {
    const args = parseCliArgs(['--proxy', '--proxy-host', '127.0.0.1', '--no-proxy-tls', '--proxy-entrypoint', 'web']);
    assert.equal(args.proxy, true);
    assert.equal(args.proxyHost, '127.0.0.1');
    assert.equal(args.proxyTls, false);
    assert.equal(args.proxyEntrypoint, 'web');
  });
});

describe('filterServices', () => {
  const all = [svc('app-api'), svc('app-web', 'web'), svc('tasks-api'), svc('staff-web', 'web')];

  it('returns all with no filters', () => {
    const result = filterServices(all, parseCliArgs([]));
    assert.equal(result.length, 4);
  });

  it('--only apis', () => {
    const result = filterServices(all, parseCliArgs(['--only', 'apis']));
    assert.ok(result.every(s => s.type === 'api'));
  });

  it('--only webs', () => {
    const result = filterServices(all, parseCliArgs(['--only', 'webs']));
    assert.ok(result.every(s => s.type === 'web'));
  });

  it('--skip', () => {
    const result = filterServices(all, parseCliArgs(['--skip', 'tasks-api']));
    assert.equal(result.length, 3);
    assert.ok(!result.find(s => s.name === 'tasks-api'));
  });

  it('--services explicit', () => {
    const result = filterServices(all, parseCliArgs(['--services', 'app-api,app-web']));
    assert.equal(result.length, 2);
  });
});
