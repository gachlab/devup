import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileReadyPattern } from '../../../src/process/manager.js';

describe('compileReadyPattern', () => {
  it('returns null when pattern is undefined', () => {
    assert.equal(compileReadyPattern(undefined), null);
  });

  it('compiles plain string as case-insensitive regex', () => {
    const re = compileReadyPattern('ready in')!;
    assert.ok(re.test('Server READY IN 120 ms'));
    assert.ok(re.test('ready in 5ms'));
    assert.ok(!re.test('not yet'));
  });

  it('compiles vim-style /pattern/flags', () => {
    const re = compileReadyPattern('/^api: \\d+/')!;
    assert.ok(re.test('API: 3000 listening'));     // case-insensitive default
    assert.ok(!re.test('http api: 3000'));         // anchored
  });

  it('honors explicit flags in vim-style', () => {
    const re = compileReadyPattern('/READY/')!;
    assert.ok(re.test('ready')); // implied 'i' flag
    const sensitive = compileReadyPattern('/READY/')!;
    assert.equal(sensitive.flags, 'i');
  });

  it('returns null for invalid regex', () => {
    assert.equal(compileReadyPattern('(unclosed'), null);
  });
});
