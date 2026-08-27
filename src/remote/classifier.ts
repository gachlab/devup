import type { DevStackConfig, EnvironmentConfig, ServiceConfig } from '../config/types.js';
import { resolveRemoteTarget } from './target.js';

export interface RemoteSelection {
  envName: string;
  env: EnvironmentConfig;
  /** The `--remote qa:a,b` form. Absent means the blanket form. */
  only?: string[];
}

export interface RemoteSpec {
  svc: ServiceConfig;
  target: string;
  envName: string;
  env: EnvironmentConfig;
}

export interface RemoteClassification {
  /** Services to start as processes, after the remote ones are taken out. */
  local: ServiceConfig[];
  remote: RemoteSpec[];
  /** Named for the remote set but with no resolvable target. Report these:
   *  a service that is neither started nor proxied is exactly the silent
   *  absence this feature exists to remove. */
  unresolved: string[];
  /** Names passed to `--remote <env>:a,b` that are not services at all —
   *  a typo, or a service renamed since the command was last used. Separate
   *  from `unresolved`, which is about a real service the environment cannot
   *  reach: "no target for app_api" would send someone looking at their
   *  environment config when the problem is the underscore they typed. */
  unknown: string[];
}

/** Split the stack into what runs here and what is forwarded to an environment.
 *
 *  Two forms, with different precedence, and the difference is deliberate:
 *
 *  - `--remote qa` — the blanket form. Everything the local selection did
 *    *not* pick becomes remote. The profile wins, because the profile is the
 *    statement of what you are working on.
 *  - `--remote qa:app-api,rules-api` — the explicit form. Those services are
 *    remote even if a profile named them, because naming a service on the
 *    command line is more specific than the profile it happens to belong to.
 *
 *  `--skip x` under the blanket form makes `x` remote rather than absent. That
 *  is the point: "not running it here" is what skipping has always meant, and
 *  what changes is only what happens to its port.
 *
 *  Lazy classification runs on `local` afterwards, which is what keeps a
 *  service from being lazy and remote at once — the lazy proxy and the remote
 *  proxy would bind the same port, and the second one loses. */
export function classifyRemote(
  all: ServiceConfig[],
  local: ServiceConfig[],
  selection: RemoteSelection | null,
  routes: Record<string, string> | undefined,
): RemoteClassification {
  if (!selection) return { local, remote: [], unresolved: [], unknown: [] };

  const localNames = new Set(local.map(s => s.name));
  const known = new Set(all.map(s => s.name));
  // A name in the explicit list that matches nothing would otherwise vanish:
  // the filter simply returns fewer entries, and `--remote qa:app_api` runs
  // `app-api` locally with nothing said about the underscore.
  const unknown = (selection.only ?? []).filter(name => !known.has(name));
  const wanted = selection.only
    ? all.filter(s => selection.only!.includes(s.name))
    : all.filter(s => !localNames.has(s.name));

  const remote: RemoteSpec[] = [];
  const unresolved: string[] = [];
  for (const svc of wanted) {
    const target = resolveRemoteTarget(svc.name, selection.env, routes);
    if (target) remote.push({ svc, target, envName: selection.envName, env: selection.env });
    else unresolved.push(svc.name);
  }

  const remoteNames = new Set(remote.map(r => r.svc.name));
  return { local: local.filter(s => !remoteNames.has(s.name)), remote, unresolved, unknown };
}

/** Tear down and forget the remote proxy for a service that has been removed.
 *
 *  Same hazard as `releaseLazyProxy`, and the same rule: the proxy holds the
 *  service's **public** port, so until it is destroyed the stack still answers
 *  for a service every client was just told had gone. Call this before
 *  announcing the removal, not after. */
export function releaseRemoteProxy(
  proxies: Map<string, { destroy: () => void }> | undefined | null,
  name: string,
): boolean {
  const proxy = proxies?.get(name);
  if (!proxy) return false;
  proxy.destroy();
  proxies!.delete(name);
  return true;
}

/** Turn the `--remote` value into a selection, or throw with the list of
 *  environments that do exist.
 *
 *  A misspelled environment name must not degrade into a plain local boot: the
 *  services it was meant to cover would just be missing, and what the
 *  developer sees is a frontend failing to connect — several minutes away from
 *  the typo that caused it. */
export function parseRemoteSelection(
  raw: string,
  environments: Record<string, EnvironmentConfig> | undefined,
): RemoteSelection {
  const [envName, list] = splitOnce(raw, ':');
  const env = environments?.[envName];
  if (!env) {
    const available = Object.keys(environments ?? {});
    const hint = available.length
      ? `Available: ${available.join(', ')}`
      : 'No environments defined in config.';
    throw new Error(`Unknown environment: "${envName}". ${hint}`);
  }

  if (list === undefined) return { envName, env };
  const only = list.split(',').map(s => s.trim()).filter(Boolean);
  if (!only.length) throw new Error(`--remote ${envName}: needs at least one service name`);
  return { envName, env, only };
}

function splitOnce(value: string, sep: string): [string, string | undefined] {
  const idx = value.indexOf(sep);
  return idx < 0 ? [value, undefined] : [value.slice(0, idx), value.slice(idx + 1)];
}

/** Resolve the whole remote split for a run, once.
 *
 *  Four entry paths were each doing `parseRemoteSelection` + `classifyRemote`
 *  themselves, and the one place that does **not** — `index.ts`, which runs the
 *  pre-boot port scan — therefore scanned the wrong set: under the blanket
 *  `--remote qa` the remote services are not in the filtered list, so their
 *  ports were never checked, while under `--remote qa:a,b` they were. Two forms
 *  of one flag, opposite behaviour before a single process started.
 *
 *  Returns `null` when no environment was asked for, so a caller can keep its
 *  plain-local path unchanged. */
export function resolveRemote(
  config: Pick<DevStackConfig, 'services' | 'environments' | 'proxy'>,
  localSelection: ServiceConfig[],
  remoteFlag: string | undefined,
): RemoteClassification | null {
  if (!remoteFlag) return null;
  const selection = parseRemoteSelection(remoteFlag, config.environments);
  return classifyRemote(config.services, localSelection, selection, config.proxy?.routes);
}

/** Every port this run will hold, local and proxied alike — what the pre-boot
 *  scan has to look at.
 *
 *  When there is a classification its **own** local set wins over the one
 *  passed in, and that is the point rather than a nicety: with the explicit
 *  form (`--remote qa:a,b`) those services are still in the filtered list *and*
 *  in the remote set, so combining the two listed each port twice.
 *  `scanPortConflicts` does not dedupe, so `--kill-port-conflicts` killed the
 *  holder on the first entry and then reported the second as "survived
 *  SIGKILL" — aborting a boot whose port was by then free. Deciding here means
 *  a caller cannot get it wrong. */
export function allHeldPorts(
  local: ServiceConfig[],
  classification: RemoteClassification | null,
): ServiceConfig[] {
  if (!classification) return local;
  return [...classification.local, ...classification.remote.map(r => r.svc)];
}
