import { ProcessManager } from '../process/manager.js';
import { checkHealth } from '../process/health.js';
import { classifyRemote, parseRemoteSelection } from '../remote/classifier.js';
import { startRemoteServices } from '../remote/boot.js';
import type { RemoteProxy } from '../remote/proxy.js';
import { groupByPhase } from '../utils.js';
import type { DevStackConfig, ServiceConfig } from '../config/types.js';
import type { CliArgs } from '../config/cli.js';
import type { Platform } from '../platform/types.js';
import type { LogSink } from '../process/log-sink.js';
import { startExternals, stopExternals, type ExternalProc } from '../process/external.js';

export interface OnceOpts {
  config: DevStackConfig;
  services: ServiceConfig[];
  cliArgs: CliArgs;
  platform: Platform;
  env: Record<string, string>;
  baseCwd: string;
  logSink: LogSink | null;
  /** For testing: override stdout. */
  out?: (line: string) => void;
}

/** Boots services phase-by-phase, waits until each API is healthy, then returns.
 *  Returns 0 if everything came up within onceTimeout, 1 otherwise. */
export interface OnceServiceReport {
  name: string;
  type: 'api' | 'web';
  phase: number;
  port: number;
  ready: boolean;
  /** ms from the start of the run to the moment it was ready, or null. */
  readyAfterMs: number | null;
  /** Why not, when not ready. */
  reason?: string;
}

export interface OnceReport {
  ok: boolean;
  elapsedMs: number;
  timeoutMs: number;
  services: OnceServiceReport[];
}

export async function runOnce(opts: OnceOpts): Promise<number> {
  const json = opts.cliArgs.onceJson;
  // With --json the summary *is* the output, so nothing else may reach stdout:
  // one `[app-api] listening` line in the middle and the caller cannot parse
  // it. The service output still goes somewhere — stderr — because losing it
  // is how a failing CI run becomes undiagnosable.
  const write = opts.out ?? ((l: string) => console.log(l));
  const out = json
    ? (l: string) => process.stderr.write(l + '\n')
    : write;
  const emitJson = (report: OnceReport) => write(JSON.stringify(report, null, 2));
  const startedAt = Date.now();
  const { config, services, cliArgs, platform, env, baseCwd, logSink } = opts;

  const mgr = new ProcessManager({
    baseCwd, env, platform,
    events: {
      onLog: (svc, text) => { logSink?.write(svc, text); out(`[${svc}] ${text}`); },
      onStateChange: () => {},
    },
  });

  // Declared here rather than where it is filled, so the teardown below can be
  // the single exit path: a proxy left holding a port keeps `--once` from
  // exiting at all, and there are five places this function returns from.
  const remoteProxies = new Map<string, RemoteProxy>();
  const cleanupAll = async (): Promise<void> => {
    for (const proxy of remoteProxies.values()) proxy.destroy();
    remoteProxies.clear();
    await mgr.cleanup();
  };

  const reports: OnceServiceReport[] = [];
  /** Names actually spawned, so the report can tell "never launched" from
   *  "launched but never reached". */
  const started = new Set<string>();
  const describe = (svc: ServiceConfig, ready: boolean, reason?: string): OnceServiceReport => ({
    name: svc.name, type: svc.type, phase: svc.phase, port: svc.port,
    ready, readyAfterMs: ready ? Date.now() - startedAt : null,
    ...(reason ? { reason } : {}),
  });
  const finish = (ok: boolean): number => {
    if (json) {
      // Everything selected, not only what was reached: a service that never
      // got its turn because an earlier phase failed is not "ready", and
      // leaving it out of the report makes the pipeline guess.
      for (const svc of services) {
        if (reports.some(r => r.name === svc.name)) continue;
        // Everything in a phase is spawned before any of it is awaited, so a
        // service can have been started and still not appear above. Saying
        // "never started" would send a pipeline past the logs of the service
        // that may well be the culprit.
        reports.push(describe(svc, false, started.has(svc.name)
          ? 'started, but the run stopped before it was checked'
          : 'never started — an earlier phase failed first'));
      }
      emitJson({ ok, elapsedMs: Date.now() - startedAt, timeoutMs: cliArgs.onceTimeout * 1000, services: reports });
    }
    return ok ? 0 : 1;
  };


  // External dependencies (DBs, queues, etc.) before phase 0.
  let externals: ExternalProc[] = [];
  if (config.external?.length) {
    out(`▶ externals (${config.external.length})`);
    const result = await startExternals(config.external, {
      baseCwd, env, platform,
      onLog: (svc, msg) => { logSink?.write(`ext:${svc}`, msg); out(`[ext:${svc}] ${msg}`); },
    });
    externals = result.procs;
    if (!result.allHealthy) {
      out(`✗ externals failed: ${result.failed.join(', ')}`);
      await stopExternals(externals, platform, { baseCwd, env });
      await cleanupAll();
      // Every service reports as never-started, with the real reason —
      // `finish` fills them in, so there is one place that decides what an
      // unreached service looks like.
      for (const svc of services) {
        reports.push(describe(svc, false, `externals failed: ${result.failed.join(', ')}`));
      }
      return finish(false);
    }
  }

  // Remote services before the phases, and before anything is spawned: what
  // is served from an environment must not also be started here, and it needs
  // its port bound before a local service that talks to it comes up.
  //
  // Silently ignoring `--remote` here would be the exact failure this feature
  // exists to remove — a CI run reporting a stack healthy while the services
  // it was told to proxy were simply absent.
  let localServices = services;
  if (cliArgs.remote) {
    const selection = parseRemoteSelection(cliArgs.remote, config.environments);
    const classification = classifyRemote(config.services, services, selection, config.proxy?.routes);
    localServices = classification.local;
    startRemoteServices({
      mgr, classification, proxies: remoteProxies,
      colorIdxStart: config.services.length,
      onLog: (svc, msg) => { logSink?.write(svc, msg); out(`[${svc}] ${msg}`); },
      processEnv: env,
    });

    // Reachability decides readiness, since there is no process to watch. A
    // proxy that binds while the environment is unreachable is not a stack a
    // suite can run against, and reporting it ready is how a CI failure gets
    // attributed to the tests.
    for (const spec of classification.remote) {
      const proxy = remoteProxies.get(spec.svc.name)!;
      const reachable = await proxy.probe();
      const st = mgr.state.get(spec.svc.name);
      if (st) st.health = reachable ? 'up' : 'down';
      if (reachable) {
        out(`✓ ${spec.svc.name} served from ${spec.envName}`);
        reports.push({ ...describe(spec.svc, true), readyAfterMs: Date.now() - startedAt });
      } else {
        out(`✗ ${spec.svc.name}: ${spec.target} did not answer`);
        reports.push(describe(spec.svc, false, `${spec.envName} unreachable at ${spec.target}`));
      }
    }
    if (classification.remote.some(spec => mgr.state.get(spec.svc.name)?.health !== 'up')) {
      await cleanupAll();
      await stopExternals(externals, platform, { baseCwd, env });
      return finish(false);
    }
  }

  const phases = groupByPhase(localServices);
  const phaseNums = Object.keys(phases).map(Number).sort((a, b) => a - b);
  const deadline = startedAt + cliArgs.onceTimeout * 1000;
  let colorIdx = 0;

  for (const num of phaseNums) {
    out(`▶ phase ${num}`);
    for (const svc of phases[num]!) {
      const ci = colorIdx++;
      const installed = await mgr.install(svc, ci);
      if (!installed) {
        out(`✗ install failed for ${svc.name}`);
        reports.push(describe(svc, false, 'install failed'));
        await cleanupAll();
        await stopExternals(externals, platform, { baseCwd, env });
        return finish(false);
      }
      await mgr.start(svc, ci);
      started.add(svc.name);
    }

    // Wait for everything in this phase, webs included. Waiting only for APIs
    // is why `--once` used to hand back control while the front end was still
    // compiling — and `--once` exists precisely so the caller does not have to
    // wait again on its own.
    //
    // Concurrently, because they were started concurrently: awaiting them one
    // at a time made `readyAfterMs` measure when the loop got round to a
    // service rather than when it was ready, so one that came up in 2 s behind
    // a sibling taking 40 s was reported at 40 s. Results are reported in
    // config order afterwards, so the output stays deterministic.
    const settled = await Promise.all(phases[num]!.map(async svc => ({
      svc,
      ok: await waitReady(mgr, svc, deadline),
      atMs: Date.now() - startedAt,
    })));

    for (const { svc, ok, atMs } of settled) {
      if (ok) {
        out(`✓ ${svc.name} ready`);
        reports.push({ ...describe(svc, true), readyAfterMs: atMs });
        const st = mgr.state.get(svc.name);
        if (st) { st.status = 'running'; st.health = 'up'; }
        continue;
      }
      const st = mgr.state.get(svc.name);
      out(`✗ ${svc.name} did not become ready within ${cliArgs.onceTimeout}s`);
      if (st?.status === 'crashed') {
        out(`    (it crashed ${st.crashes ?? 0} time${(st.crashes ?? 0) === 1 ? '' : 's'} — \`devup logs ${svc.name}\`)`);
      } else if (svc.type === 'web' && !svc.readyPattern) {
        // Its port is all we had to go on, and for a dev server that opens
        // late this is the difference between a real failure and a config
        // that never said what "ready" looks like.
        out(`    (no readyPattern for ${svc.name} — devup could only watch its port)`);
      } else if (svc.type === 'web' && svc.readyPattern) {
        // The other half of that: a pattern that is right for a tool version
        // you no longer run fails just as silently.
        out(`    (waited for readyPattern /${svc.readyPattern}/ — check it still matches what ${svc.name} prints)`);
      }
      reports.push(describe(svc, false, st?.status === 'crashed'
        ? `crashed ${st.crashes ?? 0} time${(st.crashes ?? 0) === 1 ? '' : 's'}`
        : `did not become ready within ${cliArgs.onceTimeout}s`));
    }

    if (settled.some(r => !r.ok)) {
      await cleanupAll();
      await stopExternals(externals, platform, { baseCwd, env });
      return finish(false);
    }
  }

  // From the classification, not from the difference in list lengths: under
  // the blanket `--remote qa` the remote services were never in `services` to
  // begin with, so the subtraction is zero and the run reports "3 services"
  // without a word about the twenty-one being proxied.
  const remoteCount = remoteProxies.size;
  out(`ready: ${services.length} services in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    + (remoteCount > 0 ? ` (${remoteCount} served from ${cliArgs.remote!.split(':')[0]})` : ''));
  await cleanupAll();
  await stopExternals(externals, platform, { baseCwd, env });
  return finish(true);
}

/** Wait until a service is genuinely serving.
 *
 *  Two signals, and which one counts depends on what the service is:
 *
 *  - **`readyPattern` on a web is the only honest signal.** `ng serve` and
 *    friends open their port long before the bundle exists, so a port probe
 *    reports ready while a browser still gets nothing — which is exactly how
 *    `--once` came to return before the front end served. When a web declares
 *    a pattern, that pattern is the bar; the port is ignored.
 *  - **For an API the port answering is the service serving.** That is the bar
 *    `bootNormal` uses, so it stays the bar here — a pattern, when there is
 *    one, only ever lets it finish sooner.
 *
 *  A web with no pattern has nothing better than its port. That is worse than
 *  the pattern and better than not waiting at all; it is also the reason
 *  `readyPattern` is worth setting on every web in the config. */
async function waitReady(mgr: ProcessManager, svc: ServiceConfig, deadline: number): Promise<boolean> {
  const declaresPattern = svc.type === 'web' && !!svc.readyPattern;
  while (Date.now() < deadline) {
    const st = mgr.state.get(svc.name);
    // The spawner sets health to 'up' the moment a line matches readyPattern.
    if (st?.health === 'up') return true;
    // The pattern gets the startup window to itself, and then the port is
    // accepted — the same rule `HealthPoller` follows, and for the same
    // reason: a pattern that no longer matches its tool's output must not fail
    // a run for a front end that is serving perfectly well. The spawner's
    // startup timer is what ends the window.
    const patternOnly = declaresPattern && st?.status !== 'timeout';
    if (!patternOnly) {
      const { ok } = await checkHealth(svc.port, svc.healthCheck);
      if (ok) return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
