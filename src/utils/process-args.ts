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
 *  NODE_OPTIONS=--max-old-space-size when maxMem is set and cmd != 'node'. */
export function buildProcessEnv(svc: ServiceConfig, baseEnv: Record<string, string>): Record<string, string> {
  const env = { ...baseEnv, ...(svc.extraEnv ?? {}) };
  if (svc.maxMem && svc.cmd !== 'node') {
    const existing = env['NODE_OPTIONS'] ?? '';
    const flag = `--max-old-space-size=${svc.maxMem}`;
    if (!existing.includes('max-old-space-size')) {
      env['NODE_OPTIONS'] = existing ? `${existing} ${flag}` : flag;
    }
  }
  return env;
}
