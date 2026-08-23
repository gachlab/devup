import React from 'react';
import { render } from 'ink';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { findConfigFile, loadConfig } from './config/loader.js';
import { validateConfig, formatValidationErrors, collectWarnings, formatValidationWarnings } from './config/validator.js';
import { parseCliArgs, filterServices, USAGE } from './config/cli.js';
import { detectSubcommand, runLogs, runInstall, runStatus, runHelp, runCtl, runDown, runConfig } from './orchestrator/subcommands.js';
import { runDetached, daemonBody, isDaemonRunning } from './orchestrator/daemon.js';
import { scanPortConflicts, resolvePortConflicts } from './process/port-conflicts.js';
import { detectPlatform } from './platform/detect.js';
import { detectProxyProvider } from './proxy-config/detect.js';
import { parseEnvFile } from './utils.js';
import { App } from './tui/App.js';
import { LogSink } from './process/log-sink.js';
import { runDryRun } from './orchestrator/dry-run.js';
import { runOnce } from './orchestrator/once.js';
import { readVersion } from './utils/version.js';
import { runExec, ownArgsFor, daemonChildArgs } from './orchestrator/exec.js';
import type { ProxyConfigProvider, ProxyOpts } from './proxy-config/types.js';

// Re-export for config files
export { defineConfig } from './config/types.js';
export type { DevStackConfig, ServiceConfig, LazyConfig, ProxyConfig } from './config/types.js';
export type { Platform, ProcessStats } from './platform/types.js';
export type { ProxyConfigProvider, ProxyOpts } from './proxy-config/types.js';

async function main() {
  const raw = process.argv.slice(2);

  // Subcommand dispatch (devup logs / install / status / help). All require the config
  // file to be present so we can know which services exist and where logs live.
  const subcmd = detectSubcommand(raw);

  // --version / --help short-circuit before any config loading — but only over
  // devup's *own* arguments. `devup exec -- npx playwright test --help` asks
  // Playwright for help, not devup: scanning the whole argv printed devup's
  // usage and exited 0 without running anything, which in CI reads as a pass.
  const ownArgs = ownArgsFor(raw, subcmd);
  if (ownArgs.includes('-v') || ownArgs.includes('--version')) {
    console.log(readVersion());
    return;
  }
  if (ownArgs.includes('-h') || ownArgs.includes('--help')) {
    console.log(USAGE);
    return;
  }

  if (subcmd === 'help') {
    process.exit(runHelp(raw.slice(1)));
  }

  const cwd = process.cwd();
  // `ownArgs` above already stopped at `--` for exec: everything after it
  // belongs to the command. See `execOwnArgs`.
  const cliArgs = parseCliArgs(ownArgs);

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
    if (subcmd === 'down')    process.exit(await runDown(subOpts));
    if (subcmd === 'config')  process.exit(await runConfig(subArgs, { cwd, configPath: cliArgs.configPath }));
    // `up` and `exec` fall through to the full setup pipeline: both boot the
    // stack, and exec needs the same resolved services, env and proxy the
    // daemon child will be given.
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

  // Daemon-already-running guard. Applies to all "boot the stack" flows
  // (TUI, --once, devup up -d). If a healthy daemon is up for this project,
  // the ports we'd scan belong to its services — killing them only triggers
  // the daemon's auto-restarter and produces churn. Skipped for the daemon
  // child itself (which IS the running daemon), and for `exec`, whose whole
  // point is that an existing daemon is something to use rather than a reason
  // to stop: it reuses it and leaves it up, and only boots one when there is
  // none. Refusing here would leave every harness parsing this message to
  // decide, which is what the flag exists to avoid.
  if (process.env.DEVUP_DAEMON_CHILD !== '1' && subcmd !== 'exec') {
    const daemonStatus = isDaemonRunning(config.name);
    if (daemonStatus.pid && !daemonStatus.stale) {
      console.error(`❌ A devup daemon is already running for "${config.name}" (pid=${daemonStatus.pid}).`);
      console.error('');
      console.error('Stop it first with `devup down`, or interact via the control plane:');
      console.error('  devup ctl status');
      console.error('  devup ctl logs <svc> --follow');
      console.error('  devup ctl restart <svc>');
      await logSink?.close();
      process.exit(1);
    }
  }

  // Pre-boot port conflict resolution. Skip in the daemon child (the parent
  // already cleared conflicts before spawning us). All other flows benefit:
  // TUI, `devup up -d`, `--once`.
  const ensurePortsFree = async (): Promise<boolean> => {
    const conflicts = await scanPortConflicts(services);
    if (!conflicts.length) return true;
    return await resolvePortConflicts(conflicts, {
      autoKill: cliArgs.killPortConflicts,
      out: msg => process.stderr.write(msg + '\n'),
      prompt: () => askYesNo('Kill these processes and continue? [y/N]: '),
    });
  };

  // `exec` decides for itself whether to boot, so it also decides when the
  // ports have to be free: a daemon it is reusing owns them, and clearing them
  // would kill the very stack it is about to test against.
  if (subcmd === 'exec') {
    const code = await runExec({
      argv: raw.slice(1),
      childArgs: daemonChildArgs(raw),
      config, services, cliArgs, platform, env, baseCwd: cwd, proxyProvider, proxyOpts,
      ensurePortsFree,
    });
    await logSink?.close();
    process.exit(code);
  }

  if (process.env.DEVUP_DAEMON_CHILD !== '1') {
    if (!await ensurePortsFree()) {
      await logSink?.close();
      process.exit(1);
    }
  }

  // --once: arranca, espera ready, sale 0/1 (sin TUI)
  if (cliArgs.once) {
    const code = await runOnce({
      config, services, cliArgs, platform, env, baseCwd: cwd, logSink,
    });
    await logSink?.close();
    process.exit(code);
  }

  // Daemon child: spawned by `devup up -d`. Skip Ink/TUI; run the daemon body
  // which stays alive until SIGTERM. The parent process polls for the PID file.
  if (process.env.DEVUP_DAEMON_CHILD === '1') {
    await daemonBody({ config, services, cliArgs, platform, env, baseCwd: cwd, proxyProvider, proxyOpts });
    return; // daemonBody installs its own signal handlers and only exits via process.exit
  }

  // `devup up -d`: spawn the daemon child detached, wait for it to signal ready, exit.
  if (subcmd === 'up') {
    if (!raw.includes('-d') && !raw.includes('--detach')) {
      console.error('usage: devup up -d  (use plain `devup` for the TUI)');
      process.exit(1);
    }
    process.exit(await runDetached({
      config, services, cliArgs, platform, env, baseCwd: cwd, proxyProvider, proxyOpts,
    }));
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

/** Single-line y/N prompt. Reads stdin directly rather than going through
 *  readline — `readline.createInterface` can no-op silently when the input
 *  stream has been touched elsewhere (e.g. terminal multiplexers, IDE
 *  integrated terminals, complex shells), which left users with the
 *  question printed but the process moving on without waiting.
 *
 *  TTY is detected via any of stdin / stderr / stdout being a TTY; some
 *  environments misreport one but not the others. Resolves false on EOF
 *  or non-TTY so a caller can fall back to "non-interactive" handling. */
function askYesNo(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const isTTY = Boolean(process.stdin.isTTY || process.stderr.isTTY || process.stdout.isTTY);
    if (!isTTY) { resolve(false); return; }

    process.stderr.write(question);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.pause();
    };
    const onData = (data: string | Buffer) => {
      cleanup();
      resolve(/^y(es)?$/i.test(String(data).trim()));
    };
    const onEnd = () => { cleanup(); resolve(false); };

    process.stdin.once('data', onData);
    process.stdin.once('end', onEnd);
  });
}

/** Only run main() when this script is invoked directly (i.e. as the `devup`
 *  binary). When the bundle is *imported* — which happens whenever a user's
 *  `devup.config.ts` does `import { defineConfig } from '@gachlab/devup'` —
 *  we just want our exports (`defineConfig`, types) to be available, NOT to
 *  start a second concurrent main() that races for the same ports and
 *  duplicates every line of output.
 *
 *  Compare `import.meta.url` (this module's file URL) against the realpath
 *  of `process.argv[1]` (the entry script). When invoked as `devup`, npm
 *  installs `bin/devup` as a symlink to `dist/index.js`, so the realpath
 *  resolves to our module and the comparison matches. When imported from a
 *  config file, `process.argv[1]` points at the outer entry — which lives
 *  at a different node_modules path even when the same version — and the
 *  comparison fails, so `main()` does not fire. */
function isInvokedDirectly(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  const moduleFile = fileURLToPath(import.meta.url);
  try {
    return realpathSync(argvPath) === moduleFile;
  } catch {
    return argvPath === moduleFile;
  }
}

if (isInvokedDirectly()) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
