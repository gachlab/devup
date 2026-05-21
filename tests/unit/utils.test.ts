import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnvFile, fmtUptime, calcCpuPercent, sortServiceNames,
  groupByPhase, buildProcessArgs, buildProcessEnv, compileSearchPattern,
} from '../../src/utils.js';

describe('compileSearchPattern', () => {
  it('returns null for empty / null term', () => {
    assert.equal(compileSearchPattern(null), null);
    assert.equal(compileSearchPattern(''), null);
  });

  it('plain string is case-insensitive substring', () => {
    const m = compileSearchPattern('Error')!;
    assert.equal(m.test('database ERROR thrown'), true);
    assert.equal(m.test('database error thrown'), true);
    assert.equal(m.test('no match here'), false);
    assert.equal(m.regex, undefined);
  });

  it('/pattern/ compiles to a case-insensitive regex by default', () => {
    const m = compileSearchPattern('/^api: \\d+/')!;
    assert.ok(m.regex);
    assert.equal(m.regex!.flags, 'i');
    assert.equal(m.test('API: 3000 listening'), true);
    assert.equal(m.test('http api: 3000'), false);  // anchored
  });

  it('honors explicit flags after the closing slash', () => {
    const m = compileSearchPattern('/error/g')!;
    assert.ok(m.regex);
    assert.ok(m.regex!.flags.includes('i')); // i is added if missing
    assert.ok(m.regex!.flags.includes('g'));
  });

  it('falls back to substring on invalid regex and reports invalid', () => {
    const m = compileSearchPattern('/(unclosed/')!;
    assert.equal(m.invalid, true);
    assert.equal(m.regex, undefined);
    // Still works as substring search of the literal text
    assert.equal(m.test('a /(unclosed/ b'), true);
  });

  it('plain string with slashes does NOT trigger regex mode', () => {
    const m = compileSearchPattern('some/path')!;
    assert.equal(m.regex, undefined);
    assert.equal(m.test('see SOME/PATH here'), true);
  });
});

describe('fmtUptime', () => {
  it('returns dash for invalid', () => { assert.equal(fmtUptime(-1), '-'); assert.equal(fmtUptime(0), '-'); });
  it('formats seconds', () => assert.equal(fmtUptime(45000), '45s'));
  it('formats minutes', () => assert.equal(fmtUptime(125000), '2m5s'));
  it('formats hours', () => assert.equal(fmtUptime(3725000), '1h2m'));
  it('formats days', () => assert.equal(fmtUptime(2 * 24 * 3600_000 + 3 * 3600_000), '2d3h'));
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
