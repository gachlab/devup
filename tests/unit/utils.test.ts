import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnvFile, fmtUptime, highlightSearch, findSearchMatch,
  shouldLogLine, buildLogsLabel, calcCpuPercent, sortServiceNames,
  groupByPhase, buildProcessArgs, buildProcessEnv,
} from '../../src/utils.js';

describe('fmtUptime', () => {
  it('returns dash for invalid', () => { assert.equal(fmtUptime(-1), '-'); assert.equal(fmtUptime(0), '-'); });
  it('formats seconds', () => assert.equal(fmtUptime(45000), '45s'));
  it('formats minutes', () => assert.equal(fmtUptime(125000), '2m5s'));
  it('formats hours', () => assert.equal(fmtUptime(3725000), '1h2m'));
});

describe('highlightSearch', () => {
  it('returns text when no term', () => assert.equal(highlightSearch('hello', null), 'hello'));
  it('highlights match', () => assert.ok(highlightSearch('hello world', 'world').includes('{yellow-bg}')));
  it('case insensitive', () => assert.ok(highlightSearch('Hello', 'hello').includes('{yellow-bg}')));
  it('no match returns text', () => assert.equal(highlightSearch('hello', 'xyz'), 'hello'));
});

describe('findSearchMatch', () => {
  const lines = ['foo', 'bar', 'baz foo', 'qux'];
  it('finds next', () => assert.equal(findSearchMatch(lines, 'foo', 0, 'next'), 2));
  it('finds prev', () => assert.equal(findSearchMatch(lines, 'foo', 3, 'prev'), 2));
  it('wraps around', () => assert.equal(findSearchMatch(lines, 'foo', 2, 'next'), 0));
  it('returns -1 when not found', () => assert.equal(findSearchMatch(lines, 'xyz', 0, 'next'), -1));
  it('returns -1 for empty', () => assert.equal(findSearchMatch([], 'foo', 0, 'next'), -1));
});

describe('shouldLogLine', () => {
  it('passes all when no filter', () => assert.equal(shouldLogLine('any', null), true));
  it('passes matching filter', () => assert.equal(shouldLogLine('app-api', 'app-api'), true));
  it('blocks non-matching', () => assert.equal(shouldLogLine('app-api', 'app-web'), false));
});

describe('buildLogsLabel', () => {
  it('basic', () => assert.ok(buildLogsLabel(null, null, false).includes('Logs')));
  it('with filter', () => assert.ok(buildLogsLabel('app-api', null, false).includes('app-api')));
  it('with search', () => assert.ok(buildLogsLabel(null, 'error', false).includes('/error')));
  it('paused', () => assert.ok(buildLogsLabel(null, null, true).includes('PAUSED')));
});

describe('calcCpuPercent', () => {
  it('calculates delta', () => {
    const now = Date.now();
    const pct = calcCpuPercent(2, 1, now - 1000);
    assert.ok(pct > 90 && pct < 110); // ~100% (1 sec CPU in 1 sec wall)
  });
  it('returns 0 for no elapsed', () => assert.equal(calcCpuPercent(1, 0, Date.now()), 0));
});

describe('sortServiceNames', () => {
  it('sorts by name', () => {
    assert.deepEqual(sortServiceNames(['b', 'a', 'c'], 'name', {}, {}), ['a', 'b', 'c']);
  });
  it('sorts by mem desc', () => {
    const stats = { a: { mem: '10 MB' }, b: { mem: '50 MB' }, c: { mem: '5 MB' } };
    assert.deepEqual(sortServiceNames(['a', 'b', 'c'], 'mem', stats, {}), ['b', 'a', 'c']);
  });
  it('sorts by errors desc', () => {
    const state = { a: { errors: 1 }, b: { errors: 5 }, c: { errors: 0 } };
    assert.deepEqual(sortServiceNames(['a', 'b', 'c'], 'errors', {}, state), ['b', 'a', 'c']);
  });
});

describe('groupByPhase', () => {
  it('groups services', () => {
    const svcs = [
      { name: 'a', cwd: '.', cmd: 'node', args: [], type: 'api' as const, port: 3000, phase: 0 },
      { name: 'b', cwd: '.', cmd: 'node', args: [], type: 'api' as const, port: 3001, phase: 1 },
      { name: 'c', cwd: '.', cmd: 'node', args: [], type: 'api' as const, port: 3002, phase: 0 },
    ];
    const groups = groupByPhase(svcs);
    assert.equal(groups[0]!.length, 2);
    assert.equal(groups[1]!.length, 1);
  });
});

describe('buildProcessArgs', () => {
  it('injects max-old-space-size for node', () => {
    const svc = { name: 'a', cwd: '.', cmd: 'node', args: ['index.js'], type: 'api' as const, port: 3000, phase: 0, maxMem: 256 };
    const args = buildProcessArgs(svc);
    assert.equal(args[0], '--max-old-space-size=256');
    assert.equal(args[1], 'index.js');
  });
  it('skips for npx', () => {
    const svc = { name: 'a', cwd: '.', cmd: 'npx', args: ['vite'], type: 'web' as const, port: 4200, phase: 4, maxMem: 512 };
    assert.deepEqual(buildProcessArgs(svc), ['vite']);
  });
  it('no maxMem returns args as-is', () => {
    const svc = { name: 'a', cwd: '.', cmd: 'node', args: ['index.js'], type: 'api' as const, port: 3000, phase: 0 };
    assert.deepEqual(buildProcessArgs(svc), ['index.js']);
  });
});

describe('buildProcessEnv', () => {
  it('injects NODE_OPTIONS for npx with maxMem', () => {
    const svc = { name: 'a', cwd: '.', cmd: 'npx', args: ['vite'], type: 'web' as const, port: 4200, phase: 4, maxMem: 512 };
    const env = buildProcessEnv(svc, { PATH: '/usr/bin' });
    assert.equal(env['NODE_OPTIONS'], '--max-old-space-size=512');
  });
  it('skips NODE_OPTIONS for node cmd', () => {
    const svc = { name: 'a', cwd: '.', cmd: 'node', args: [], type: 'api' as const, port: 3000, phase: 0, maxMem: 256 };
    const env = buildProcessEnv(svc, {});
    assert.equal(env['NODE_OPTIONS'], undefined);
  });
  it('merges extraEnv', () => {
    const svc = { name: 'a', cwd: '.', cmd: 'node', args: [], type: 'api' as const, port: 3000, phase: 0, extraEnv: { FOO: 'bar' } };
    const env = buildProcessEnv(svc, { PATH: '/usr/bin' });
    assert.equal(env['FOO'], 'bar');
    assert.equal(env['PATH'], '/usr/bin');
  });
});

describe('parseEnvFile', () => {
  it('returns base when file missing', () => {
    const env = parseEnvFile('/nonexistent/.env', { EXISTING: 'yes' });
    assert.equal(env['EXISTING'], 'yes');
  });
});
