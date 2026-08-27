import type { DevStackConfig } from '../config/types.js';

export interface ToggleTarget {
  /** `null` means "bring it back local". */
  envName: string | null;
}

/** Which way the TUI's one-key toggle should go for a service, or why it
 *  cannot decide.
 *
 *  A key press carries no environment name, so this has to infer one — and the
 *  honest answer is sometimes "ask properly". Guessing between two configured
 *  environments would point a service at a shared system nobody named, which
 *  is precisely the thing this feature has to be loud about.
 *
 *  The preference order is what someone would expect: whatever this run was
 *  started against, then the only environment there is. */
export function resolveToggle(
  config: DevStackConfig,
  isRemote: boolean,
  /** The environment named on the command line, if any — the env half of
   *  `--remote qa:app-api`. */
  bootEnv: string | undefined,
): ToggleTarget | { error: string } {
  if (isRemote) return { envName: null };

  const names = Object.keys(config.environments ?? {});
  if (!names.length) return { error: 'no environments defined in config' };
  if (bootEnv && names.includes(bootEnv)) return { envName: bootEnv };
  if (names.length === 1) return { envName: names[0]! };

  return {
    error: `several environments (${names.join(', ')}) — use \`devup ctl remote <svc> <env>\``,
  };
}

/** The environment half of a `--remote` value, ignoring any service list. */
export function bootEnvName(remoteFlag: string | undefined): string | undefined {
  if (!remoteFlag) return undefined;
  const name = remoteFlag.split(':')[0];
  return name || undefined;
}
