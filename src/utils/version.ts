import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The devup release this process is running.
 *
 *  Found by walking up from this module until a `package.json` with our name
 *  turns up. A fixed relative path cannot work: under `tsx` this file sits at
 *  `src/utils/`, and in the published bundle it has been inlined into
 *  `dist/index.js` — two different distances from the manifest. Getting that
 *  wrong is silent, and the whole point of the field is to be trusted.
 *
 *  `'unknown'` rather than a throw: nobody should lose a daemon over a version
 *  string, and a client can tell `'unknown'` from a real answer. */
let cached: string | null = null;

export function readVersion(): string {
  if (cached !== null) return cached;
  cached = findVersion() ?? 'unknown';
  return cached;
}

function findVersion(): string | null {
  try { return findVersionFrom(dirname(fileURLToPath(import.meta.url))); } catch { return null; }
}

/** The walk itself, from an explicit directory so it can be tested.
 *
 *  Bounded to five levels — enough for `src/utils` → repo root and for `dist`
 *  → package root, with room to spare. And it insists on **our** manifest: a
 *  walk that took the first `package.json` it found would, if ours were
 *  unreadable, keep going up out of `node_modules` and report the consuming
 *  project's version as devup's. A wrong version is worse than no version,
 *  because a client checking `info().version` would act on it. */
export function findVersionFrom(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg?.name === PACKAGE_NAME && typeof pkg.version === 'string') return pkg.version;
    } catch { /* not here, or not ours — keep walking */ }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const PACKAGE_NAME = '@gachlab/devup';
