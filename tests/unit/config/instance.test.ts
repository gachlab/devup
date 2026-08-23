import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { qualifyInstance, validateInstance } from '../../../src/config/instance.js';
import { defaultSocketPath } from '../../../src/control-plane/socket-path.js';

describe('qualifyInstance', () => {
  it('leaves the project name alone without an instance', () => {
    assert.equal(qualifyInstance('Guesthub'), 'Guesthub');
    assert.equal(qualifyInstance('Guesthub', undefined), 'Guesthub');
  });

  it('appends the instance', () => {
    assert.equal(qualifyInstance('Guesthub', 'e2e'), 'Guesthub--e2e');
  });

  it('separates with a doubled dash, so a dashed project name cannot collide', () => {
    // A single dash makes project `foo-bar` and project `foo` with
    // `--instance bar` share a pid file and a log directory, and `devup down`
    // in one would stop the other.
    assert.notEqual(qualifyInstance('foo', 'bar'), qualifyInstance('foo-bar'));
    assert.notEqual(defaultSocketPath(qualifyInstance('foo', 'bar')), defaultSocketPath(qualifyInstance('foo-bar')));
  });

  it('qualifies before sanitising, so each sanitiser keeps its own rule', () => {
    // The socket sanitiser does *not* trim leading underscores while the log
    // one does — `@gachlab/web` answers on `sock-_gachlab_web.sock` and logs to
    // `logs/gachlab_web/`. That divergence is load-bearing for anything
    // already running, so the instance is appended to the *name* and each rule
    // is left to apply itself.
    assert.ok(defaultSocketPath(qualifyInstance('@gachlab/web', 'e2e')).endsWith('sock-_gachlab_web--e2e.sock'));
    assert.ok(defaultSocketPath(qualifyInstance('@gachlab/web')).endsWith('sock-_gachlab_web.sock'));
  });

  it('gives two instances of one project different sockets', () => {
    // The whole point: an e2e run must not reach into the stack you work in.
    assert.notEqual(defaultSocketPath(qualifyInstance('P', 'e2e')), defaultSocketPath(qualifyInstance('P')));
    assert.notEqual(defaultSocketPath(qualifyInstance('P', 'a')), defaultSocketPath(qualifyInstance('P', 'b')));
  });
});

describe('validateInstance', () => {
  it('accepts ordinary names', () => {
    for (const ok of ['e2e', 'ci', 'ci-2', 'test_1', 'a.b', 'A1']) {
      assert.equal(validateInstance(ok), null, `rejected ${ok}`);
    }
  });

  it('rejects rather than sanitising', () => {
    // A name quietly rewritten is a socket you cannot find, and knowing which
    // daemon you are talking to is the entire point of the flag.
    for (const bad of ['', 'a/b', '../up', 'a b', '-lead', '.hidden', 'a\\0b']) {
      assert.ok(validateInstance(bad), `accepted ${JSON.stringify(bad)}`);
    }
  });

  it('rejects a path separator, which would move the socket', () => {
    assert.match(validateInstance('../../etc')!, /invalid instance name/);
  });

  it('caps the length', () => {
    assert.equal(validateInstance('a'.repeat(32)), null);
    assert.match(validateInstance('a'.repeat(33))!, /too long/);
  });
});
