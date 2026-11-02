import type { ProxyConfig } from '../config/types.js';

/** The base domain routes are built on: `proxy.domain`, then
 *  `$GUESTHUB_DOMAIN` (deprecated), then `$DOMAIN`, then `localhost`.
 *
 *  `$GUESTHUB_DOMAIN` keeps its place ahead of `$DOMAIN` for now: it was
 *  looked up first, named after the one project devup was first written for,
 *  and a stack that has both may well use `DOMAIN` for something else — an
 *  app or cookie domain. Moving it behind would re-point every route of that
 *  stack, silently. It warns instead, every time it is the one used. */
export function resolveProxyDomain(
  proxy: Pick<ProxyConfig, 'domain'>,
  env: Record<string, string | undefined>,
  warn: (msg: string) => void = msg => console.error(msg),
): string {
  if (proxy.domain) return proxy.domain;
  if (env['GUESTHUB_DOMAIN']) {
    warn('⚠ GUESTHUB_DOMAIN is deprecated — set proxy.domain in the config (or DOMAIN in the env)');
    return env['GUESTHUB_DOMAIN'];
  }
  return env['DOMAIN'] || 'localhost';
}
