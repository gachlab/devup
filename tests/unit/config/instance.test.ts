import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { qualifyInstance, validateInstance, instanceSuffix } from '../../../src/config/instance.js';
import { defaultSocketPath } from '../../../src/control-plane/socket-path.js';

describe('qualifyInstance', () => {
  it('leaves the project name alone without an instance', () => {
    assert.equal(qualifyInstance('Guesthub'), 'Guesthub');
    assert.equal(qualifyInstance('Guesthub', undefined), 'Guesthub');
  });

  it('appends the instance', () => {
    assert.equal(qualifyInstance('Guesthub', 'e2e'), 'Guesthub-e2e');
  });

  it('qualifies before sanitising, so each sanitiser keeps its own rule', () => {
    // The socket sanitiser does *not* trim leading underscores while the log
    // one does — `@gachlab/web` answers on `sock-_gachlab_web.sock` and logs to
    // `logs/gachlab_web/`. That divergence is load-bearing for anything
    // already running, so the instance is appended to the *name* and each rule
    // is left to apply itself.
    assert.ok(defaultSocketPath(qualifyInstance('@gachlab/web', 'e2e')).endsWith('sock-_gachlab_web-e2e.sock'));
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

describe('instanceSuffix', () => {
  it('recovers the instance from a qualified name', () => {
    assert.equal(instanceSuffix('Guesthub-e2e', 'Guesthub'), 'e2e');
    assert.equal(instanceSuffix('Guesthub', 'Guesthub'), undefined);
  });

  it('does not mistake a dash in the project name for an instance', () => {
    // Cutting at the last dash would report `my-app`'s default instance as
    // "app", and the message would suggest `devup down --instance app` for a
    // daemon that does not exist.
    assert.equal(instanceSuffix('my-app', 'my-app'), undefined);
    assert.equal(instanceSuffix('my-app-e2e', 'my-app'), 'e2e');
    assert.equal(instanceSuffix('my-app-ci-2', 'my-app'), 'ci-2');
  });

  it('says nothing for a name that is not this project at all', () => {
    assert.equal(instanceSuffix('OtherProject-e2e', 'Guesthub'), undefined);
  });

  it('round-trips with qualifyInstance', () => {
    for (const [project, instance] of [['Guesthub', 'e2e'], ['my-app', 'ci-2'], ['@gachlab/web', 'x']] as const) {
      assert.equal(instanceSuffix(qualifyInstance(project, instance), project), instance);
    }
  });
});
