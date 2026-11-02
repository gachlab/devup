import { dirname, resolve } from 'node:path';

/** The directory a config's relative paths are relative to: the one holding
 *  the config file. Not the shell's cwd — with `--config ../stack/devup.config.ts`
 *  the two differ, and every `cwd` in the file was written against the former. */
export function projectDirOf(configPath: string): string {
  return dirname(resolve(configPath));
}

/** A service's (or external's) working directory. `resolve`, not `join`: an
 *  absolute `cwd` is honoured instead of being glued onto the project dir —
 *  `join('/repo', '/srv/api')` is `/repo/srv/api`, which the validator (using
 *  `resolve`) accepted and the spawner then failed to find. */
export function serviceDir(baseCwd: string, cwd: string | undefined): string {
  return cwd ? resolve(baseCwd, cwd) : baseCwd;
}
