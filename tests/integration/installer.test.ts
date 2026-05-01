import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installService } from '../../src/process/installer.js';
import { needsInstall } from '../../src/utils.js';

describe('installer integration', () => {
  it('runs npm install and writes stamp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-int-inst-'));
    try {
      // Need at least one dep so npm creates node_modules
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'test-pkg', version: '1.0.0',
        dependencies: { 'is-number': '7.0.0' },
      }));

      const logs: string[] = [];
      const ok = await installService(dir, { ...process.env as Record<string, string> }, msg => logs.push(msg));

      assert.equal(ok, true);
      assert.ok(logs.some(l => l.includes('dependencies ready')));
      assert.equal(needsInstall(dir), false, 'stamp should mark as up to date');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('skips when already up to date', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-int-inst-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'test-pkg2', version: '1.0.0',
        dependencies: { 'is-number': '7.0.0' },
      }));

      // First install
      await installService(dir, { ...process.env as Record<string, string> });

      // Second install should skip
      const logs: string[] = [];
      const ok = await installService(dir, { ...process.env as Record<string, string> }, msg => logs.push(msg));
      assert.equal(ok, true);
      assert.ok(logs.some(l => l.includes('up to date')));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('returns false for nonexistent directory', async () => {
    const logs: string[] = [];
    const ok = await installService('/tmp/nonexistent-dir-xyz', {}, msg => logs.push(msg));
    assert.equal(ok, false);
    assert.ok(logs.some(l => l.includes('not found')));
  });
});
