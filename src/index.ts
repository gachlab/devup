import React from 'react';
import { render } from 'ink';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { findConfigFile, loadConfig } from './config/loader.js';
import { validateConfig, formatValidationErrors, collectWarnings, formatValidationWarnings } from './config/validator.js';
import { parseCliArgs, filterServices, USAGE } from './config/cli.js';
import { detectSubcommand, runLogs, runInstall, runStatus, runHelp, runCtl } from './orchestrator/subcommands.js';
import { detectPlatform } from './platform/detect.js';
import { detectProxyProvider } from './proxy-config/detect.js';
import { parseEnvFile } from './utils.js';
import { App } from './tui/App.js';
import { LogSink } from './process/log-sink.js';
import { runDryRun } from './orchestrator/dry-run.js';
import { runOnce } from './orchestrator/once.js';
import type { ProxyConfigProvider, ProxyOpts } from './proxy-config/types.js';

// Re-export for config files
export { defineConfig } from './config/types.js';
export type { DevStackConfig, ServiceConfig, LazyConfig, ProxyConfig } from './config/types.js';
export type { Platform, ProcessStats } from './platform/types.js';
export type { ProxyConfigProvider, ProxyOpts } from './proxy-config/types.js';

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main() {
  const raw = process.argv.slice(2);
  // --version / --help short-circuit before any config loading
  if (raw.includes('-v') || raw.includes('--version')) {
    console.log(readVersion());
    return;
  }
  if (raw.includes('-h') || raw.includes('--help')) {
    console.log(USAGE);
    return;
  }

  // Subcommand dispatch (devup logs / install / status / help). All require the config
  // file to be present so we can know which services exist and where logs live.
  const subcmd = detectSubcommand(raw);
  if (subcmd === 'help') {
    process.exit(runHelp(raw.slice(1)));
  }

  const cwd = process.cwd();
  const cliArgs = parseCliArgs(raw);

  if (subcmd) {
    const subArgs = raw.slice(1);
    // Load config (no validation needed for read-only ops, but resolve path errors clearly)
    let cfgPath: string;
    try { cfgPath = findConfigFile(cwd, cliArgs.configPath); }
    catch (e: any) { console.error(`❌ ${e.message}`); process.exit(1); }
    const cfg = await loadConfig(cfgPath);
    const subOpts = { config: cfg, baseCwd: cwd, env: process.env as Record<string, string>, logDir: cliArgs.logDir };
    if (subcmd === 'logs')    process.exit(await runLogs(subArgs, subOpts));
    if (subcmd === 'install') process.exit(await runInstall(subOpts));
    if (subcmd === 'status')  process.exit(await runStatus(subOpts));
    if (subcmd === 'ctl')     process.exit(await runCtl(subArgs, subOpts));
  }

  // Load config
  let configPath: string;
  try {
    configPath = findConfigFile(cwd, cliArgs.configPath);
  } catch (e: any) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const config = await loadConfig(configPath);

  // Validate
  const errors = validateConfig(config, cwd);
  if (errors.length) {
    console.error(`❌ Config validation failed:\n${formatValidationErrors(errors)}`);
    process.exit(1);
  }
  const warnings = collectWarnings(config);
  if (warnings.length) {
    console.warn(`⚠ Config warnings:\n${formatValidationWarnings(warnings)}`);
  }

  // Filter services
  let services: ReturnType<typeof filterServices>;
  try {
    services = filterServices(config.services, cliArgs, config);
  } catch (e: any) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
  if (!services.length) {
    console.error('❌ No services to run after filtering');
    process.exit(1);
  }

  // Platform
  const platform = await detectPlatform();

  // Env
  const envFile = config.envFile ? join(cwd, config.envFile) : join(cwd, '.env');
  const env = parseEnvFile(envFile, process.env as Record<string, string>);
  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) {
      if (!env[k]) env[k] = v;
    }
  }

  // Proxy provider
  let proxyProvider: ProxyConfigProvider | null = null;
  let proxyOpts: ProxyOpts | null = null;
  if (cliArgs.proxy && config.proxy) {
    proxyProvider = detectProxyProvider(config.proxy.provider);
    proxyOpts = {
      host: cliArgs.proxyHost ?? config.proxy.host ?? platform.defaultTraefikHost,
      domain: env['GUESTHUB_DOMAIN'] ?? env['DOMAIN'] ?? 'localhost',
      routes: config.proxy.routes,
      tls: cliArgs.proxyTls ?? config.proxy.tls ?? true,
      entrypoint: cliArgs.proxyEntrypoint ?? config.proxy.entrypoint ?? 'websecure',
      confPath: cliArgs.proxyConf ?? config.proxy.confPath ?? join(homedir(), '.traefik', 'traefik_conf.yaml'),
    };
  }

  // --dry-run: imprime plan y sale
  if (cliArgs.dryRun) {
    runDryRun({ config, services, cliArgs, env, baseCwd: cwd, proxyProvider, proxyOpts });
    return;
  }

  // Log sink (a disco). Desactivable con --no-log-file.
  let logSink: LogSink | null = null;
  if (cliArgs.logFile) {
    logSink = new LogSink({ projectName: config.name, rootDir: cliArgs.logDir });
  }

  // --once: arranca, espera ready, sale 0/1 (sin TUI)
  if (cliArgs.once) {
    const code = await runOnce({
      config, services, cliArgs, platform, env, baseCwd: cwd, logSink,
    });
    await logSink?.close();
    process.exit(code);
  }

  // Render TUI
  const isInteractive = process.stdin.isTTY ?? false;
  const { waitUntilExit } = render(
    React.createElement(App, {
      config, services, cliArgs, platform, env, baseCwd: cwd,
      proxyProvider, proxyOpts, logSink,
    }),
    { exitOnCtrlC: false, patchConsole: isInteractive, interactive: isInteractive },
  );

  await waitUntilExit();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
