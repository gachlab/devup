import type { DevStackConfig, ServiceConfig } from '../config/types.js';
import type { CliArgs } from '../config/cli.js';
import type { ProxyConfigProvider, ProxyOpts } from '../proxy-config/types.js';
import type { ServiceState } from '../proxy-config/types.js';
import { groupByPhase, buildProcessArgs, buildProcessEnv } from '../utils.js';
import { classifyServices, rewriteServicePort, getLazyRealPort } from '../lazy/classifier.js';

export interface DryRunOpts {
  config: DevStackConfig;
  services: ServiceConfig[];
  cliArgs: CliArgs;
  env: Record<string, string>;
  baseCwd: string;
  proxyProvider: ProxyConfigProvider | null;
  proxyOpts: ProxyOpts | null;
}

export function renderDryRun(opts: DryRunOpts): string {
  const { config, services, cliArgs, env, proxyProvider, proxyOpts } = opts;
  const lines: string[] = [];

  lines.push(`Project:  ${config.icon ?? '📦'} ${config.name}`);
  lines.push(`Mode:     ${cliArgs.lazy && config.lazy ? 'lazy' : 'normal'}`);
  if (cliArgs.profile) lines.push(`Profile:  ${cliArgs.profile}`);
  lines.push(`Services: ${services.length}`);
  lines.push('');

  const lazyMode = cliArgs.lazy && !!config.lazy;
  let alwaysOn: ServiceConfig[] = services;
  let lazy: ServiceConfig[] = [];
  if (lazyMode) {
    const c = classifyServices(services, config.lazy!);
    alwaysOn = c.alwaysOn;
    lazy = c.lazy;
  }

  const phases = groupByPhase(alwaysOn);
  const phaseNums = Object.keys(phases).map(Number).sort((a, b) => a - b);
  for (const num of phaseNums) {
    lines.push(`Phase ${num}:`);
    for (const svc of phases[num]!) {
      lines.push(formatService(svc, env, false));
    }
  }

  if (lazy.length) {
    lines.push('');
    lines.push('Lazy (on-demand):');
    for (const svc of lazy) {
      const rewritten = rewriteServicePort(svc);
      lines.push(formatService(rewritten, env, true));
      lines.push(`    proxy   :${svc.port} → :${getLazyRealPort(svc.port)} (idle timeout ${cliArgs.lazyTimeout}m)`);
    }
  }

  if (proxyProvider && proxyOpts) {
    lines.push('');
    lines.push(`Proxy:    ${proxyProvider.name} → ${proxyOpts.confPath}`);
    // Simulamos todas las rutas como "up" para mostrar el output
    const svcStates = new Map<string, ServiceState>();
    for (const svc of services) {
      const real = lazyMode && !alwaysOn.includes(svc) ? getLazyRealPort(svc.port) : undefined;
      svcStates.set(svc.name, { port: svc.port, health: 'up', realPort: real });
    }
    const content = proxyProvider.generate(svcStates, proxyOpts);
    lines.push('');
    lines.push('--- generated config ---');
    lines.push(content);
  }

  return lines.join('\n');
}

function formatService(svc: ServiceConfig, env: Record<string, string>, isLazy: boolean): string {
  const args = buildProcessArgs(svc);
  const cmdLine = [svc.cmd, ...args].join(' ');
  const built = buildProcessEnv(svc, env);
  const extraEnv = Object.keys(svc.extraEnv ?? {}).length
    ? '  env=' + Object.entries(svc.extraEnv!).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  const memTag = svc.maxMem ? ` mem=${svc.maxMem}MB` : '';
  const hc = svc.healthCheck;
  const hcTag = hc?.type === 'http' ? ` health=http ${hc.path ?? '/'}` : '';
  const lazyTag = isLazy ? ' [lazy]' : '';
  void built;
  return `  - ${svc.name.padEnd(20)} (${svc.type}) :${svc.port}  ${cmdLine}${memTag}${hcTag}${lazyTag}${extraEnv}`;
}

export function runDryRun(opts: DryRunOpts): void {
  // eslint-disable-next-line no-console
  console.log(renderDryRun(opts));
}
