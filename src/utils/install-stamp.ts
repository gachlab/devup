import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Returns true if the service's node_modules is missing or its install stamp
 *  doesn't match the current package.json hash. */
export function needsInstall(fullCwd: string): boolean {
  const nm = join(fullCwd, 'node_modules');
  if (!existsSync(nm)) return true;
  try {
    const pkgHash = createHash('md5').update(readFileSync(join(fullCwd, 'package.json'))).digest('hex');
    const stampFile = join(nm, '.install-stamp');
    if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === pkgHash) return false;
  } catch { /* stamp missing or unreadable */ }
  return true;
}

/** Writes the install stamp file for a service after a successful `npm install`. */
export function writeInstallStamp(fullCwd: string): void {
  try {
    const pkgHash = createHash('md5').update(readFileSync(join(fullCwd, 'package.json'))).digest('hex');
    writeFileSync(join(fullCwd, 'node_modules', '.install-stamp'), pkgHash);
  } catch { /* best effort */ }
}
