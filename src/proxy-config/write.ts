import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write a proxy config file in place, in one call.
 *
 *  In place on purpose. A temp file + rename looks safer — a watching proxy
 *  can never read half a file — and broke more than it fixed: the new inode
 *  is invisible through a single-file Docker bind mount (how Caddy and nginx
 *  are usually given this file), it needs a writable *directory* (a
 *  `chown`-ed file in a root-owned `conf.d` is not enough), it replaces a
 *  symlinked `confPath` with a plain file, and it resets the file's mode and
 *  group. A proxy that reads a file mid-write sees the next change event and
 *  reloads, and these files are small enough to go out in one `write`. */
export function writeConfigFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
