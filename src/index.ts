import React from 'react';
import { render } from 'ink';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { findConfigFile, loadConfig } from './config/loader.js';
import { validateConfig, formatValidationErrors } from './config/validator.js';
import { parseCliArgs, filterServices } from './config/cli.js';
import { detectPlatform } from './platform/detect.js';
import { detectProxyProvider } from './proxy-config/detect.js';
import { parseEnvFile } from './utils.js';
import { App } from './tui/App.js';
import type { ProxyConfigProvider, ProxyOpts } from './proxy-config/types.js';

// Re-export for config files
export { defineConfig } from './config/types.js';
export type { DevStackConfig, ServiceConfig, LazyConfig, ProxyConfig } from './config/types.js';
export type { Platform, ProcessStats } from './platform/types.js';
export type { ProxyConfigProvider, ProxyOpts } from './proxy-config/types.js';

async function main() {
  const cwd = process.cwd();
  const cliArgs = parseCliArgs(process.argv.slice(2));

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

  // Filter services
  const services = filterServices(config.services, cliArgs);
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

  // Render TUI
  const isInteractive = process.stdin.isTTY ?? false;
  const { waitUntilExit } = render(
    React.createElement(App, {
      config, services, cliArgs, platform, env, baseCwd: cwd,
      proxyProvider, proxyOpts,
    }),
    { exitOnCtrlC: false, patchConsole: isInteractive, interactive: isInteractive },
  );

  await waitUntilExit();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
