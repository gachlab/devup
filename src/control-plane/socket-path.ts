import { join } from 'node:path';
import { homedir } from 'node:os';

/** Where the daemon for a project listens.
 *
 *  Its own module so both the server and `./client` can use it without either
 *  importing the other — a client that pulled in `socket-server.ts` would drag
 *  a whole `net.Server` into every consumer's bundle. */
export function defaultSocketPath(projectName: string): string {
  const safe = projectName.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'devup';
  return join(homedir(), '.devup', `sock-${safe}.sock`);
}
