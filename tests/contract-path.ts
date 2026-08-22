import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolved from this module, not `process.cwd()`: an editor test runner or a
 *  `--watch` session started in a subdirectory would otherwise miss it. */
export const CONTRACT_FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'contract', 'status-snapshot.json',
);
