import type { ProxyConfig } from '../config/types.js';

/** The base domain routes are built on: `proxy.domain`, then `$DOMAIN`, then
 *  `localhost`.
 *
 *  `$GUESTHUB_DOMAIN` is still read — it was the first place looked, named
 *  after the one project devup was first written for — but only after the
 *  config and `$DOMAIN`, and with a warning, so a stack that relies on it keeps
 *  working while it moves to `proxy.domain`. */
export function resolveProxyDomain(
  proxy: Pick<ProxyConfig, 'domain'>,
  env: Record<string, string | undefined>,
  warn: (msg: string) => void = msg => console.error(msg),
): string {
  if (proxy.domain) return proxy.domain;
  if (env['DOMAIN']) return env['DOMAIN'];
  if (env['GUESTHUB_DOMAIN']) {
    warn('⚠ GUESTHUB_DOMAIN is deprecated — set proxy.domain in the config (or DOMAIN in the env)');
    return env['GUESTHUB_DOMAIN'];
  }
  return 'localhost';
}
