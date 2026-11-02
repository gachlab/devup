import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../../../src/config/cli.js';

describe('parseCliArgs: malformed flags are errors, not silent defaults', () => {
  it('a value flag at the end, or followed by a flag, is an error — and does not swallow the flag', () => {
    const a = parseCliArgs(['--config']);
    assert.deepEqual(a.errors, ['--config needs a value']);
    const b = parseCliArgs(['--config', '--no-lazy']);
    assert.deepEqual(b.errors, ['--config needs a value']);
    assert.equal(b.lazy, false, '--no-lazy was swallowed as the config path');
    assert.equal(b.configPath, undefined);
  });

  it('a timeout that is not a whole number is a boot error, not 10', () => {
    // Boot-only: to `ctl wait`, `--timeout 2.5` is seconds and valid.
    const bad = parseCliArgs(['--timeout', 'abc']);
    assert.deepEqual(bad.errors, []);
    assert.match(bad.bootErrors![0]!, /--timeout needs a whole number/);
    assert.match(parseCliArgs(['--once-timeout', '0']).bootErrors![0]!, /at least 1/);
    const zero = parseCliArgs(['--timeout', '0']);
    assert.deepEqual(zero.bootErrors, []);
    assert.equal(zero.lazyTimeout, 0);
  });

  it('collects unknown flags for the boot path to reject', () => {
    assert.deepEqual(parseCliArgs(['--watch-confg', 'logs']).unknown, ['--watch-confg']);
  });

  it('--profile with --services or --only is an error, since the profile silently won', () => {
    assert.match(parseCliArgs(['--profile', 'x', '--services', 'a']).bootErrors![0]!, /cannot be combined/);
  });
});
