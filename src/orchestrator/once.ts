import { ProcessManager } from '../process/manager.js';
import { checkHealth } from '../process/health.js';
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
export async function runOnce(opts: OnceOpts): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const { config, services, cliArgs, platform, env, baseCwd, logSink } = opts;

  const mgr = new ProcessManager({
    baseCwd, env, platform,
    events: {
      onLog: (svc, text) => { logSink?.write(svc, text); out(`[${svc}] ${text}`); },
      onStateChange: () => {},
    },
  });

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
      await mgr.cleanup();
      return 1;
    }
  }

  const phases = groupByPhase(services);
  const phaseNums = Object.keys(phases).map(Number).sort((a, b) => a - b);
  const deadline = Date.now() + cliArgs.onceTimeout * 1000;
  let colorIdx = 0;

  for (const num of phaseNums) {
    out(`▶ phase ${num}`);
    for (const svc of phases[num]!) {
      const ci = colorIdx++;
      const installed = await mgr.install(svc, ci);
      if (!installed) {
        out(`✗ install failed for ${svc.name}`);
        await mgr.cleanup();
        await stopExternals(externals, platform, { baseCwd, env });
        return 1;
      }
      await mgr.start(svc, ci);
    }

    // Wait for everything in this phase, webs included. Waiting only for APIs
    // is why `--once` used to hand back control while the front end was still
    // compiling — and `--once` exists precisely so the caller does not have to
    // wait again on its own.
    for (const svc of phases[num]!) {
      const ok = await waitReady(mgr, svc, deadline);
      if (!ok) {
        out(`✗ ${svc.name} did not become ready within ${cliArgs.onceTimeout}s`);
        if (svc.type === 'web' && !svc.readyPattern) {
          // Its port is all we had to go on, and for a dev server that opens
          // late this is the difference between a real failure and a config
          // that never said what "ready" looks like.
          out(`    (no readyPattern for ${svc.name} — devup could only watch its port)`);
        }
        await mgr.cleanup();
        await stopExternals(externals, platform, { baseCwd, env });
        return 1;
      }
      out(`✓ ${svc.name} ready`);
      const st = mgr.state.get(svc.name);
      if (st) { st.status = 'running'; st.health = 'up'; }
    }
  }

  const summary = `ready: ${services.length} services in ${((cliArgs.onceTimeout * 1000 - (deadline - Date.now())) / 1000).toFixed(1)}s`;
  out(summary);
  await mgr.cleanup();
  await stopExternals(externals, platform, { baseCwd, env });
  return 0;
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
  const patternOnly = svc.type === 'web' && !!svc.readyPattern;
  while (Date.now() < deadline) {
    // The spawner sets health to 'up' the moment a line matches readyPattern.
    if (mgr.state.get(svc.name)?.health === 'up') return true;
    if (!patternOnly) {
      const { ok } = await checkHealth(svc.port, svc.healthCheck);
      if (ok) return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
