import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findConfigFile } from '../../../src/config/loader.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('findConfigFile', () => {
  it('throws when no config found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-test-'));
    try {
      assert.throws(() => findConfigFile(dir), /No config found/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('finds devup.config.ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-test-'));
    try {
      writeFileSync(join(dir, 'devup.config.ts'), 'export default {}');
      const found = findConfigFile(dir);
      assert.ok(found.endsWith('devup.config.ts'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('finds .json when no .ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-test-'));
    try {
      writeFileSync(join(dir, 'devup.config.json'), '{}');
      const found = findConfigFile(dir);
      assert.ok(found.endsWith('devup.config.json'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('prefers .ts over .json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-test-'));
    try {
      writeFileSync(join(dir, 'devup.config.ts'), 'export default {}');
      writeFileSync(join(dir, 'devup.config.json'), '{}');
      const found = findConfigFile(dir);
      assert.ok(found.endsWith('.ts'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('uses explicit --config path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-test-'));
    try {
      writeFileSync(join(dir, 'custom.json'), '{}');
      const found = findConfigFile(dir, 'custom.json');
      assert.ok(found.endsWith('custom.json'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('throws for explicit path that does not exist', () => {
    assert.throws(() => findConfigFile('/tmp', 'nope.ts'), /Config not found/);
  });
});
