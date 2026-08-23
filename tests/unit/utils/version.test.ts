import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readVersion, findVersionFrom } from '../../../src/utils/version.js';

describe('readVersion', () => {
  it('finds the real version, not "unknown"', () => {
    // The whole point of the `info` field is to be trusted. A fixed relative
    // path cannot do this: under tsx the module sits at `src/utils/`, and in
    // the published bundle it has been inlined into `dist/index.js` — two
    // different distances from the manifest, and getting it wrong is silent.
    const v = readVersion();
    assert.notEqual(v, 'unknown');
    assert.match(v, /^\d+\.\d+\.\d+/);
  });

  it('agrees with package.json', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(readVersion(), pkg.version);
  });
});

describe('findVersionFrom', () => {
  /** Build a directory tree from a { relPath: contents } map. */
  function tree(files: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'devup-ver-'));
    for (const [rel, contents] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
    }
    return root;
  }

  it('walks up to our manifest', () => {
    const root = tree({ 'package.json': { name: '@gachlab/devup', version: '9.9.9' } });
    try {
      assert.equal(findVersionFrom(join(root, 'dist', 'control-plane')), '9.9.9');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('walks past a package.json that is not ours, rather than reporting its version', () => {
    // The real shape of this: installed under node_modules, if our own
    // manifest were unreadable a first-match walk would climb out and report
    // the *consuming project's* version as devup's. A wrong version is worse
    // than none, because a client checking info().version would act on it.
    const root = tree({
      'package.json': { name: 'someone-elses-app', version: '1.2.3' },
      'node_modules/@gachlab/devup/package.json': { name: '@gachlab/devup', version: '0.16.0' },
    });
    try {
      assert.equal(findVersionFrom(join(root, 'node_modules', '@gachlab', 'devup', 'dist')), '0.16.0');
      // And with ours missing entirely, it reports nothing rather than theirs.
      const noneOfOurs = tree({ 'package.json': { name: 'someone-elses-app', version: '1.2.3' } });
      try {
        assert.equal(findVersionFrom(join(noneOfOurs, 'a', 'b')), null);
      } finally { rmSync(noneOfOurs, { recursive: true, force: true }); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('gives up rather than walking the whole filesystem', () => {
    const root = tree({ 'package.json': { name: '@gachlab/devup', version: '9.9.9' } });
    try {
      assert.equal(findVersionFrom(join(root, 'a', 'b', 'c', 'd', 'e', 'f')), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('ignores a manifest of ours with no version', () => {
    const root = tree({ 'package.json': { name: '@gachlab/devup' } });
    try {
      assert.equal(findVersionFrom(root), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('survives a manifest that is not JSON at all', () => {
    const root = tree({ 'package.json': 'not json {{{', 'x/package.json': { name: '@gachlab/devup', version: '3.2.1' } });
    try {
      assert.equal(findVersionFrom(join(root, 'x')), '3.2.1');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
