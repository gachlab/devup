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
  const apiNames = services.filter(s => s.type === 'api').map(s => s.name);
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

    // Wait for all APIs in this phase
    const apis = phases[num]!.filter(s => s.type === 'api');
    for (const api of apis) {
      const ok = await waitHealthy(api, deadline);
      if (!ok) {
        out(`✗ ${api.name} did not become healthy within ${cliArgs.onceTimeout}s`);
        await mgr.cleanup();
        await stopExternals(externals, platform, { baseCwd, env });
        return 1;
      }
      out(`✓ ${api.name} ready`);
      const st = mgr.state.get(api.name);
      if (st) { st.status = 'running'; st.health = 'up'; }
    }
  }

  const summary = `ready: ${apiNames.length} APIs in ${((cliArgs.onceTimeout * 1000 - (deadline - Date.now())) / 1000).toFixed(1)}s`;
  out(summary);
  await mgr.cleanup();
  await stopExternals(externals, platform, { baseCwd, env });
  return 0;
}

async function waitHealthy(svc: ServiceConfig, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    const ok = await checkHealth(svc.port, svc.healthCheck);
    if (ok) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
