import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const LOCKFILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

export interface InstallRoot {
  /** Where `install` runs and the stamp lives. */
  root: string;
  lockfile: string | null;
  manager: PackageManager;
}

/** Where a service's dependencies are installed, and with what.
 *
 *  A member of a workspace installs at the workspace root: the nearest
 *  ancestor whose `package.json` declares `workspaces`, or that has a
 *  `pnpm-workspace.yaml` — looked for up to the repository boundary (the
 *  directory holding `.git`), never past it. A hoisted member has no
 *  `node_modules` of its own, so treating it as its own root reinstalled on
 *  every boot and the stamp write failed in silence. Anything else installs
 *  where it is. The manager follows the lockfile: `npm install` in a pnpm
 *  workspace is not an install, it is a second, different tree. */
export function findInstallRoot(cwd: string): InstallRoot {
  let root = cwd;
  let dir = dirname(cwd);
  if (!existsSync(join(cwd, '.git'))) {
    for (;;) {
      if (isWorkspaceRoot(dir)) { root = dir; break; }
      const parent = dirname(dir);
      if (existsSync(join(dir, '.git')) || parent === dir) break;
      dir = parent;
    }
  }
  for (const [name, manager] of LOCKFILES) {
    if (existsSync(join(root, name))) return { root, lockfile: name, manager };
  }
  return { root, lockfile: null, manager: 'npm' };
}

function isWorkspaceRoot(dir: string): boolean {
  if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { workspaces?: unknown };
    return pkg.workspaces !== undefined;
  } catch { return false; }
}

/** The stamp: `package.json` *and* the lockfile. A lockfile-only change — a
 *  teammate's upgrade pulled with git — is a change to what is installed, and
 *  hashing `package.json` alone said there was nothing to do. */
function stampHash(at: InstallRoot): string {
  const h = createHash('md5').update(readFileSync(join(at.root, 'package.json')));
  if (at.lockfile) h.update(readFileSync(join(at.root, at.lockfile)));
  return h.digest('hex');
}

/** Whether `install` has to run for this root. */
export function needsInstall(at: InstallRoot | string): boolean {
  const r = typeof at === 'string' ? findInstallRoot(at) : at;
  const nm = join(r.root, 'node_modules');
  if (!existsSync(nm)) return true;
  try {
    const stampFile = join(nm, '.install-stamp');
    if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stampHash(r)) return false;
  } catch { /* stamp missing or unreadable */ }
  return true;
}

/** Records a successful install. The lockfile is looked up again: the install
 *  may have just created it, and a stamp computed without it never matched. */
export function writeInstallStamp(at: InstallRoot | string): void {
  const base = typeof at === 'string' ? findInstallRoot(at) : at;
  const lockfile = LOCKFILES.find(([name]) => existsSync(join(base.root, name)))?.[0] ?? null;
  const r = { ...base, lockfile };
  try {
    writeFileSync(join(r.root, 'node_modules', '.install-stamp'), stampHash(r));
  } catch { /* best effort */ }
}
