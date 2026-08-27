import type { EnvironmentConfig } from '../config/types.js';

/** Where a service's traffic goes when it is served from a remote environment.
 *
 *  Two ways to say it, and the second is the one that scales: an explicit
 *  `targets[name]`, or `domain` plus the **`proxy.routes` map that is already
 *  in the config**. That map exists because the reverse-proxy generator needs
 *  it, and it holds exactly the subdomains the deployed frontends call — so a
 *  stack that already runs behind Traefik needs one line per environment, not
 *  one per service.
 *
 *  A route of `''` is the bare domain (the root frontend), which is why this
 *  checks `!== undefined` rather than truthiness.
 *
 *  Returns null when neither way resolves. Callers must report those by name
 *  instead of leaving the service silently absent — that silence is the
 *  failure mode this whole feature exists to remove. */
export function resolveRemoteTarget(
  name: string,
  env: EnvironmentConfig,
  routes: Record<string, string> | undefined,
): string | null {
  const explicit = env.targets?.[name];
  if (explicit) return stripTrailingSlash(explicit);

  if (!env.domain) return null;
  const sub = routes?.[name];
  if (sub === undefined) return null;

  const scheme = env.tls === false ? 'http' : 'https';
  return `${scheme}://${sub ? `${sub}.${env.domain}` : env.domain}`;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Every remote origin this run knows about, mapped back to the local port
 *  that fronts it.
 *
 *  Needed because a redirect does not have to stay within one service: QA's
 *  authorization API answers a login with a 302 to the QA *app*, and
 *  localizing only same-origin redirects would walk the browser straight out
 *  of the local stack at the one moment it is carrying a fresh session. */
export function buildOriginMap(targets: Map<string, { target: string; port: number }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const { target, port } of targets.values()) {
    map.set(new URL(target).origin, `http://localhost:${port}`);
  }
  return map;
}
