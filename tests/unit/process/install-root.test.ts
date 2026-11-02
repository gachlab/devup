import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findInstallRoot, needsInstall, writeInstallStamp, isMember } from '../../../src/utils/install-stamp.js';
import { installService } from '../../../src/process/installer.js';

function ws(): { root: string; member: string } {
  const root = mkdtempSync(join(tmpdir(), 'devup-ws-'));
  writeFileSync(join(root, 'package.json'), '{"name":"root","workspaces":["apps/*"]}');
  const member = join(root, 'apps', 'api');
  mkdirSync(member, { recursive: true });
  writeFileSync(join(member, 'package.json'), '{"name":"api"}');
  return { root, member };
}

describe('findInstallRoot', () => {
  it('installs a workspace member at the workspace root, with the manager its lockfile names', () => {
    const { root, member } = ws();
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    assert.deepEqual(findInstallRoot(member), { root, member, lockfile: 'pnpm-lock.yaml', manager: 'pnpm' });
  });

  it('a package that is not in a workspace installs where it is, whatever an ancestor has', () => {
    const outer = mkdtempSync(join(tmpdir(), 'devup-outer-'));
    writeFileSync(join(outer, 'package.json'), '{"name":"not-a-workspace"}');
    writeFileSync(join(outer, 'package-lock.json'), '{}');
    const svc = join(outer, 'svc');
    mkdirSync(svc);
    writeFileSync(join(svc, 'package.json'), '{}');
    assert.equal(findInstallRoot(svc).root, svc);
  });

  it('does not look past the repository boundary', () => {
    const outer = mkdtempSync(join(tmpdir(), 'devup-outer-'));
    writeFileSync(join(outer, 'package.json'), '{"workspaces":["*"]}');
    const repo = join(outer, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const svc = join(repo, 'svc');
    mkdirSync(svc);
    writeFileSync(join(svc, 'package.json'), '{}');
    assert.equal(findInstallRoot(svc).root, svc);
  });
});

describe('install stamp', () => {
  it('a lockfile-only change needs an install', () => {
    const { root } = ws();
    writeFileSync(join(root, 'package-lock.json'), '{"v":1}');
    mkdirSync(join(root, 'node_modules'));
    writeInstallStamp(root);
    assert.equal(needsInstall(root), false);
    writeFileSync(join(root, 'package-lock.json'), '{"v":2}');
    assert.equal(needsInstall(root), true);
  });
});

describe('installService', () => {
  it('a directory without package.json has nothing to install, and does not run npm up the tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-nopkg-'));
    const logs: string[] = [];
    assert.equal(await installService(dir, {}, m => logs.push(m)), true);
    assert.ok(!logs.some(l => l.includes('install...')), logs.join('\n'));
  });
});

describe('review of #154', () => {
  it('a package outside the workspace globs installs where it is', () => {
    const { root } = ws();
    const tool = join(root, 'tools', 'seed');
    mkdirSync(tool, { recursive: true });
    writeFileSync(join(tool, 'package.json'), '{"name":"seed"}');
    assert.equal(findInstallRoot(tool).root, tool);
  });

  it('pnpm exclusions and ** globs', () => {
    assert.equal(isMember('packages/a/b', ['packages/**', '!packages/a/**']), false);
    assert.equal(isMember('packages/c', ['packages/**', '!packages/a/**']), true);
  });

  it("a dependency added to a member's own package.json needs an install", () => {
    const { root, member } = ws();
    writeFileSync(join(root, 'package-lock.json'), '{}');
    mkdirSync(join(root, 'node_modules'));
    writeInstallStamp(member);
    assert.equal(needsInstall(member), false);
    writeFileSync(join(member, 'package.json'), '{"name":"api","dependencies":{"zod":"3"}}');
    assert.equal(needsInstall(member), true);
  });

  it("Yarn Plug'n'Play keeps its stamp without node_modules", () => {
    const { root } = ws();
    writeFileSync(join(root, 'yarn.lock'), '');
    writeFileSync(join(root, '.pnp.cjs'), '');
    writeInstallStamp(root);
    assert.equal(needsInstall(root), false);
  });
});
