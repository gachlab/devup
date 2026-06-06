import type { ServiceConfig } from '../config/types.js';

/** Builds the final args list for spawning a service: prepends `--max-old-space-size`
 *  for `node` commands when maxMem is set, plus any nodeArgs overrides. */
export function buildProcessArgs(svc: ServiceConfig): string[] {
  const extra = svc.nodeArgs ?? [];
  if (!svc.maxMem) return [...extra, ...svc.args];
  if (svc.cmd === 'node') return [`--max-old-space-size=${svc.maxMem}`, ...extra, ...svc.args];
  return [...extra, ...svc.args];
}

/** Builds the env for spawning a service: merges extraEnv and injects
 *  NODE_OPTIONS=--max-old-space-size when maxMem is set and cmd != 'node'.
 *  maxMem always overrides any system-level NODE_OPTIONS; only yields to an
 *  explicit max-old-space-size set by the user in extraEnv. */
export function buildProcessEnv(svc: ServiceConfig, baseEnv: Record<string, string>): Record<string, string> {
  const env = { ...baseEnv, ...(svc.extraEnv ?? {}) };
  if (svc.maxMem && svc.cmd !== 'node') {
    const userExplicit = svc.extraEnv?.['NODE_OPTIONS'] ?? '';
    if (!userExplicit.includes('max-old-space-size')) {
      const existing = env['NODE_OPTIONS'] ?? '';
      const flag = `--max-old-space-size=${svc.maxMem}`;
      env['NODE_OPTIONS'] = existing.includes('max-old-space-size')
        ? existing.replace(/--max-old-space-size=\d+/, flag)
        : existing ? `${existing} ${flag}` : flag;
    }
  }
  return env;
}
