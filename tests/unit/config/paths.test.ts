import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { projectDirOf, serviceDir } from '../../../src/config/paths.js';

describe('serviceDir', () => {
  it('resolves a relative cwd against the project dir', () => {
    assert.equal(serviceDir('/repo', 'apps/api'), resolve('/repo/apps/api'));
  });

  it('honours an absolute cwd instead of gluing it on, as join() did', () => {
    assert.equal(serviceDir('/repo', '/srv/api'), resolve('/srv/api'));
  });

  it('falls back to the project dir when there is no cwd', () => {
    assert.equal(serviceDir('/repo', undefined), '/repo');
  });
});

describe('projectDirOf', () => {
  it('is the directory holding the config', () => {
    assert.equal(projectDirOf('/repo/stack/devup.config.ts'), resolve('/repo/stack'));
  });
});
