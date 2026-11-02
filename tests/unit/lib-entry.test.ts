import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lib = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib.ts')).href;

describe('the library entry', () => {
  it('does not load Ink, React or the CLI', () => {
    // A config doing `import { defineConfig } from '@gachlab/devup'` used to
    // pull in the whole CLI bundle to get an identity function.
    const script = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(spec, ctx, next) {
        if (spec === 'ink' || spec === 'react' || /\\/index\\.(ts|js)$/.test(spec)) throw new Error('loaded ' + spec);
        return next(spec, ctx);
      } });
      const m = await import(${JSON.stringify(lib)});
      if (typeof m.defineConfig !== 'function') throw new Error('no defineConfig');
    `;
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
});
