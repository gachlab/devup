import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';

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
  /** The service directory this was resolved for. */
  member: string;
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
      const globs = workspaceGlobs(dir);
      if (globs) {
        // A member only if the root's globs say so: `workspaces: ["apps/*"]`
        // does not cover `tools/seed`, which installs where it is.
        if (isMember(relative(dir, cwd), globs)) root = dir;
        break;
      }
      const parent = dirname(dir);
      if (existsSync(join(dir, '.git')) || parent === dir) break;
      dir = parent;
    }
  }
  for (const [name, manager] of LOCKFILES) {
    if (existsSync(join(root, name))) return { root, member: cwd, lockfile: name, manager };
  }
  return { root, member: cwd, lockfile: null, manager: 'npm' };
}

/** The workspace globs a directory declares — `package.json` `workspaces`
 *  (an array, or `{ packages }`) or `pnpm-workspace.yaml` `packages` — or null
 *  when it is not a workspace root. */
function workspaceGlobs(dir: string): string[] | null {
  const pnpm = join(dir, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    const globs: string[] = [];
    let inPackages = false;
    for (const line of readFileSync(pnpm, 'utf8').split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
      if (inPackages && /^\S/.test(line)) break;
      const m = inPackages && /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
      if (m) globs.push(m[1]!.trim());
    }
    return globs;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { workspaces?: unknown };
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) return ws.filter((g): g is string => typeof g === 'string');
    if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
      return ((ws as { packages: unknown[] }).packages).filter((g): g is string => typeof g === 'string');
    }
    return null;
  } catch { return null; }
}

/** Whether a path relative to the workspace root matches its globs. `*` is one
 *  path segment, `**` any number; a `!pattern` (pnpm) excludes. */
export function isMember(rel: string, globs: string[]): boolean {
  const path = rel.split(sep).join('/');
  const toRe = (g: string) => new RegExp('^' + g.replace(/\/+$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
  let member = false;
  for (const g of globs) {
    if (g.startsWith('!')) { if (toRe(g.slice(1)).test(path)) member = false; }
    else if (toRe(g).test(path)) member = true;
  }
  return member;
}

/** The stamp: `package.json` *and* the lockfile. A lockfile-only change — a
 *  teammate's upgrade pulled with git — is a change to what is installed, and
 *  hashing `package.json` alone said there was nothing to do. */
function stampHash(at: InstallRoot): string {
  const h = createHash('md5').update(readFileSync(join(at.root, 'package.json')));
  if (at.lockfile) h.update(readFileSync(join(at.root, at.lockfile)));
  // The member's own manifest too: adding a dependency to
  // `apps/api/package.json` changes neither of the above until an install
  // runs — which then never did, and the service died on "Cannot find module".
  if (at.member !== at.root) {
    try { h.update(readFileSync(join(at.member, 'package.json'))); } catch { /* no manifest */ }
  }
  return h.digest('hex');
}

/** Where the stamp for this member lives. One per member, so members of one
 *  root do not overwrite each other's; in `.yarn/` under Plug'n'Play, which
 *  has no `node_modules` — it used to reinstall on every boot. */
function stampPath(at: InstallRoot): string {
  const dir = isPnp(at.root) ? join(at.root, '.yarn') : join(at.root, 'node_modules');
  const rel = relative(at.root, at.member);
  const suffix = rel ? '-' + rel.replace(/[^a-zA-Z0-9._-]+/g, '_') : '';
  return join(dir, `.install-stamp${suffix}`);
}

function isPnp(root: string): boolean {
  return existsSync(join(root, '.pnp.cjs')) || existsSync(join(root, '.pnp.js'));
}

/** Whether `install` has to run for this root. */
export function needsInstall(at: InstallRoot | string): boolean {
  const r = typeof at === 'string' ? findInstallRoot(at) : at;
  if (!isPnp(r.root) && !existsSync(join(r.root, 'node_modules'))) return true;
  try {
    const stampFile = stampPath(r);
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
    const file = stampPath(r);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, stampHash(r));
  } catch { /* best effort */ }
}
