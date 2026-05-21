import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffServices, summariseDiff } from '../../../src/config/diff.js';
import type { ServiceConfig } from '../../../src/config/types.js';

function svc(over: Partial<ServiceConfig>): ServiceConfig {
  return { name: 'x', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0, ...over };
}

describe('diffServices', () => {
  it('detects added services', () => {
    const d = diffServices([svc({ name: 'a' })], [svc({ name: 'a' }), svc({ name: 'b', port: 3001 })]);
    assert.equal(d.added.length, 1);
    assert.equal(d.added[0]!.name, 'b');
    assert.equal(d.removed.length, 0);
    assert.equal(d.changed.length, 0);
    assert.deepEqual(d.unchanged, ['a']);
  });

  it('detects removed services', () => {
    const d = diffServices([svc({ name: 'a' }), svc({ name: 'b', port: 3001 })], [svc({ name: 'a' })]);
    assert.deepEqual(d.removed, ['b']);
    assert.deepEqual(d.unchanged, ['a']);
  });

  it('detects port changes as changed', () => {
    const d = diffServices(
      [svc({ name: 'a', port: 3000 })],
      [svc({ name: 'a', port: 3001 })],
    );
    assert.equal(d.changed.length, 1);
    assert.equal(d.changed[0]!.prev.port, 3000);
    assert.equal(d.changed[0]!.next.port, 3001);
  });

  it('detects args changes as changed', () => {
    const d = diffServices(
      [svc({ name: 'a', args: ['src/index.js'] })],
      [svc({ name: 'a', args: ['src/index.js', '--inspect'] })],
    );
    assert.equal(d.changed.length, 1);
  });

  it('detects extraEnv changes as changed', () => {
    const d = diffServices(
      [svc({ name: 'a', extraEnv: { FOO: 'bar' } })],
      [svc({ name: 'a', extraEnv: { FOO: 'baz' } })],
    );
    assert.equal(d.changed.length, 1);
  });

  it('detects healthCheck changes as changed', () => {
    const d = diffServices(
      [svc({ name: 'a', healthCheck: { type: 'tcp' } })],
      [svc({ name: 'a', healthCheck: { type: 'http', path: '/healthz' } })],
    );
    assert.equal(d.changed.length, 1);
  });

  it('ignores non-spawn metadata (no field listed is treated as changed)', () => {
    // Identical spawn-relevant fields → unchanged
    const a = svc({ name: 'a', cwd: '.', cmd: 'node', args: ['x.js'], port: 3000, phase: 0 });
    const b = svc({ name: 'a', cwd: '.', cmd: 'node', args: ['x.js'], port: 3000, phase: 0 });
    const d = diffServices([a], [b]);
    assert.deepEqual(d.unchanged, ['a']);
    assert.equal(d.changed.length, 0);
  });

  it('handles complete replacement', () => {
    const d = diffServices(
      [svc({ name: 'a' }), svc({ name: 'b', port: 3001 })],
      [svc({ name: 'c', port: 3002 }), svc({ name: 'd', port: 3003 })],
    );
    assert.equal(d.added.length, 2);
    assert.equal(d.removed.length, 2);
    assert.equal(d.changed.length, 0);
  });

  it('handles empty input on either side', () => {
    assert.deepEqual(diffServices([], []), { added: [], removed: [], changed: [], unchanged: [] });
    const onlyNew = diffServices([], [svc({ name: 'a' })]);
    assert.equal(onlyNew.added.length, 1);
    const onlyOld = diffServices([svc({ name: 'a' })], []);
    assert.deepEqual(onlyOld.removed, ['a']);
  });
});

describe('summariseDiff', () => {
  it('formats added/removed/changed counts', () => {
    assert.equal(summariseDiff({ added: [{} as any, {} as any], removed: ['x'], changed: [{} as any], unchanged: [] }),
      '+2 added, -1 removed, ~1 changed');
  });

  it('omits sections that are empty', () => {
    assert.equal(summariseDiff({ added: [{} as any], removed: [], changed: [], unchanged: [] }), '+1 added');
  });

  it('says "no changes" when everything is empty', () => {
    assert.equal(summariseDiff({ added: [], removed: [], changed: [], unchanged: [] }), 'no changes');
  });
});
