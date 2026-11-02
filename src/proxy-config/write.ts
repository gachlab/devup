import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write a proxy config file in one step: to a temp file beside it, then a
 *  rename over the real one. Traefik, Caddy and nginx all watch or reload this
 *  file, and `writeFileSync` truncates before it writes — a reload landing in
 *  between read half a config, or an empty one. */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.devup-${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
