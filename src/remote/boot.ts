import type { ProcessManager } from '../process/manager.js';
import type { ProcessState } from '../process/types.js';
import type { RemoteClassification, RemoteSpec } from './classifier.js';
import { createRemoteProxy, type RemoteProxy } from './proxy.js';
import { buildOriginMap } from './target.js';

export interface StartRemoteOpts {
  mgr: ProcessManager;
  classification: RemoteClassification;
  proxies: Map<string, RemoteProxy>;
  /** First colour index to hand out, so remote services keep their own tags in
   *  the log panel instead of colliding with the local ones. */
  colorIdxStart: number;
  onLog: (svc: string, msg: string, colorIdx: number) => void;
  processEnv?: Record<string, string | undefined>;
}

/** Register the remote services and put their proxies on the configured ports.
 *
 *  These are entries in `state` with `proc` and `pid` null: everything that
 *  reads the state map — the TUI, the stats panel, the reverse-proxy
 *  generator, the control plane — already iterates it, and a service that is
 *  answering on its port belongs there whether or not devup spawned it.
 *
 *  `status` is `running` and not a new member of `ProcessStatus`, on purpose:
 *  widening that union breaks every exhaustive switch built against it,
 *  including the hand-written copy in gachlab/devup-vscode. `state.remote`
 *  carries the distinction as an added field, which an older client ignores
 *  and renders as an ordinary running service — wrong in detail, right in
 *  substance.
 *
 *  Returns the next free colour index. */
export function startRemoteServices(opts: StartRemoteOpts): number {
  const { mgr, classification, proxies, onLog } = opts;
  const { remote, unresolved, unknown } = classification;
  let colorIdx = opts.colorIdxStart;

  if (unknown?.length) {
    onLog('devup', `⚠ --remote named ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a service' : 'are not services'} in this config`, 5);
  }
  if (unresolved.length) {
    // Never silent. A service that is neither started nor proxied looks
    // exactly like one that is starting slowly, and the difference only shows
    // up as a connection refused several minutes later.
    onLog('devup', `⚠ no remote target for: ${unresolved.join(', ')} — these stay down`, 5);
  }
  if (!remote.length) {
    // The blanket `--remote qa` proxies whatever the local selection left out,
    // so with no `--profile` / `--services` / `--skip` it selects nothing at
    // all. That is the right rule, and a silent no-op is the wrong way to
    // report it: somebody who asked for an environment and got an ordinary
    // local boot should hear why.
    if (!unresolved.length && !unknown?.length) {
      onLog('devup', '⚠ --remote selected no services — everything is running locally. Combine it with --profile / --services / --skip, or name them: --remote <env>:a,b', 5);
    }
    return colorIdx;
  }

  const originMap = buildOriginMap(new Map(
    remote.map(r => [r.svc.name, { target: r.target, port: r.svc.port }]),
  ));

  const envName = remote[0]!.envName;
  const writable = remote.filter(r => !r.env.readOnly);
  onLog('devup', `🌐 ${remote.length} service(s) served from "${envName}"`, 6);
  if (writable.length) {
    // Where the warning goes, since `readOnly` is off by default: a request
    // made from this machine changes data everyone else on that environment
    // is looking at.
    onLog('devup', `⚠ writes reach ${envName} for: ${writable.map(r => r.svc.name).join(', ')}`, 5);
  }

  for (const spec of remote) {
    const ci = colorIdx++;
    registerRemote(mgr, spec, ci);
    const proxy = createRemoteProxy({
      listenPort: spec.svc.port,
      target: spec.target,
      envName: spec.envName,
      env: spec.env,
      originMap,
      processEnv: opts.processEnv,
      onLog: msg => onLog(spec.svc.name, msg, ci),
      onUpstreamError: () => {
        const st = mgr.state.get(spec.svc.name);
        // The counter the TUI already shows. For a local service it counts
        // stderr lines; for a remote one the equivalent is a request that
        // never reached the environment — a 500 that came *back* is the
        // service's own business and is not counted here.
        if (st) st.errors++;
      },
      onHealth: reachable => {
        const st = mgr.state.get(spec.svc.name);
        if (!st || !st.remote) return; // removed, or replaced by a local start
        const next = reachable ? 'up' : 'down';
        if (st.health === next) return;
        st.health = next;
        // The health poller skips remote services, so this probe is the only
        // thing that can tell a follower the environment stopped answering.
        mgr.notifyStateChange(spec.svc.name);
      },
    });
    proxies.set(spec.svc.name, proxy);
    // Followers learn about this service the same way they learn about a
    // spawned one. Without it a `status.follow` client — the VS Code extension
    // this contract bump is for — never hears the stack has remote services.
    mgr.notifyStateChange(spec.svc.name);
    onLog(spec.svc.name, `🌐 :${spec.svc.port} → ${spec.target}`, ci);
  }

  return colorIdx;
}

function registerRemote(mgr: ProcessManager, spec: RemoteSpec, colorIdx: number): void {
  const state: ProcessState = {
    svc: spec.svc,
    proc: null,
    pid: null,
    status: 'running',
    // `wait`, not `up`: the first probe has not answered yet, and claiming an
    // environment is reachable before asking is how a stack reports itself
    // healthy while every request 502s.
    health: 'wait',
    errors: 0,
    restarts: 0,
    startedAt: Date.now(),
    intentionalStop: false,
    colorIdx,
    crashLog: null,
    remote: {
      envName: spec.envName,
      target: spec.target,
      readOnly: spec.env.readOnly === true,
    },
  };
  mgr.state.set(spec.svc.name, state);
}
