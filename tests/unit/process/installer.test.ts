import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { needsInstall, writeInstallStamp } from '../../../src/utils.js';

describe('needsInstall', () => {
  it('returns true when no node_modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-inst-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{}');
      assert.equal(needsInstall(dir), true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('returns true when stamp mismatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-inst-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"a"}');
      mkdirSync(join(dir, 'node_modules'));
      writeFileSync(join(dir, 'node_modules', '.install-stamp'), 'wrong-hash');
      assert.equal(needsInstall(dir), true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('returns false when stamp matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-inst-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"b"}');
      mkdirSync(join(dir, 'node_modules'));
      writeInstallStamp(dir);
      assert.equal(needsInstall(dir), false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('writeInstallStamp', () => {
  it('writes stamp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-inst-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"c"}');
      mkdirSync(join(dir, 'node_modules'));
      writeInstallStamp(dir);
      assert.ok(existsSync(join(dir, 'node_modules', '.install-stamp')));
      const stamp = readFileSync(join(dir, 'node_modules', '.install-stamp'), 'utf8');
      assert.ok(stamp.length === 32); // md5 hex
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
