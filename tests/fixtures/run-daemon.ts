/** Test fixture: starts a daemon directly via daemonBody. Used by the
 *  daemon integration test to avoid having to build dist/ first. */
import { dirname, resolve } from 'node:path';
import { daemonBody } from '../../src/orchestrator/daemon.js';
import { loadConfig } from '../../src/config/loader.js';
import { LinuxPlatform } from '../../src/platform/linux.js';
import type { CliArgs } from '../../src/config/cli.js';

const configPath = resolve(process.argv[2]!);
const baseCwd = dirname(configPath);

const cliArgs: CliArgs = {
  skip: [], lazy: false, lazyTimeout: 10,
  proxy: false, proxyTls: true, proxyEntrypoint: 'websecure',
  dryRun: false, once: false, onceTimeout: 30, logFile: true,
};

const config = await loadConfig(configPath);
await daemonBody({
  config,
  services: config.services,
  cliArgs,
  platform: new LinuxPlatform(),
  env: process.env as Record<string, string>,
  baseCwd,
  proxyProvider: null,
  proxyOpts: null,
});
