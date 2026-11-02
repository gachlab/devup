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

/** The one origin map for a run, shared by every remote proxy in it.
 *
 *  Keyed by the run's proxy registry, so the boot and every later switch find
 *  the same `Map`, and every proxy holds a reference to it: a proxy built at
 *  boot used to keep the map it was given then, so after `ctl remote app qa`
 *  the auth service's login redirect to `https://app.qa…` was no longer
 *  localized and the browser left the local stack with the fresh session. */
const originMaps = new WeakMap<object, Map<string, string>>();
export function originMapFor(registry: object): Map<string, string> {
  let map = originMaps.get(registry);
  if (!map) { map = new Map(); originMaps.set(registry, map); }
  return map;
}

/** Map every service an environment can serve to its local port — local and
 *  remote alike, and never removed.
 *
 *  The local port is the service's public port either way: served from the
 *  environment, devup's proxy answers there; run here, the process (or its
 *  lazy proxy) does. So a redirect to the environment's copy of *any* of them
 *  belongs on localhost. Mapping only the remote ones made switching a service
 *  back to local — to work on it — send the login redirect to QA's copy. */
export function addEnvironmentOrigins(
  registry: object,
  services: Iterable<{ name: string; port: number }>,
  env: EnvironmentConfig,
  routes: Record<string, string> | undefined,
): Map<string, string> {
  const map = originMapFor(registry);
  for (const svc of services) {
    const target = resolveRemoteTarget(svc.name, env, routes);
    if (target) map.set(new URL(target).origin, `http://localhost:${svc.port}`);
  }
  return map;
}
