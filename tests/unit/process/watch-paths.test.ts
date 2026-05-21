import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractWatchPaths } from '../../../src/process/manager.js';

describe('extractWatchPaths', () => {
  it('returns empty for no args', () => {
    assert.deepEqual(extractWatchPaths([]), []);
  });

  it('handles --watch-path X form', () => {
    assert.deepEqual(extractWatchPaths(['--watch-path', 'src', 'index.js']), ['src']);
  });

  it('handles --watch X form', () => {
    assert.deepEqual(extractWatchPaths(['--watch', 'lib', 'app.js']), ['lib']);
  });

  it('handles --watch-path=X form', () => {
    assert.deepEqual(extractWatchPaths(['--watch-path=src']), ['src']);
  });

  it('handles multiple watch paths', () => {
    const args = ['--watch-path', 'src', '--watch-path', 'lib', '--watch-path=tools', 'index.js'];
    assert.deepEqual(extractWatchPaths(args), ['src', 'lib', 'tools']);
  });

  it('ignores --watch-path followed by another flag', () => {
    assert.deepEqual(extractWatchPaths(['--watch-path', '--other-flag', 'src']), []);
  });

  it('does not match unrelated flags', () => {
    assert.deepEqual(extractWatchPaths(['--import', 'tsx', '--watcher', 'foo']), []);
  });
});
