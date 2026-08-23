import React, { useCallback, useRef } from 'react';
import { Box, Text } from 'ink';
import type { Platform } from '../platform/types.js';
import type { DevStackConfig, ServiceConfig } from '../config/types.js';
import type { CliArgs } from '../config/cli.js';
import type { ProxyConfigProvider, ProxyOpts } from '../proxy-config/types.js';
import type { LogSink } from '../process/log-sink.js';
import { useProcessManager } from './hooks/useProcessManager.js';
import { useKeyBindings } from './hooks/useKeyBindings.js';
import { useProxySync } from './hooks/useProxySync.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useLogsPause } from './hooks/useLogsPause.js';
import { useControlPlane } from './hooks/useControlPlane.js';
import { useHotReload } from './hooks/useHotReload.js';
import { useContextualTips } from './hooks/useContextualTips.js';
import { useBootSequence } from './hooks/useBootSequence.js';
import { LogsPanel } from './LogsPanel.js';
import { StatsPanel } from './StatsPanel.js';
import { StatusBar } from './StatusBar.js';
import { ServiceList } from './ServiceList.js';
import { SearchInput } from './SearchInput.js';
import type { LazyProxy } from '../lazy/proxy.js';
import { stopExternals, type ExternalProc } from '../process/external.js';

/** Builds the URL to open in the browser when the user picks a service.
 *  Honors the proxy + TLS settings: if --proxy is active and the service has
 *  a route, opens https://<sub>.<domain>; otherwise falls back to http://localhost:<port>. */
export function buildServiceUrl(
  name: string,
  port: number,
  proxyActive: boolean,
  proxyOpts: ProxyOpts | null,
): string {
  if (proxyActive && proxyOpts) {
    const sub = proxyOpts.routes[name];
    if (sub !== undefined) {
      const host = sub ? `${sub}.${proxyOpts.domain}` : proxyOpts.domain;
      const scheme = proxyOpts.tls ? 'https' : 'http';
      return `${scheme}://${host}`;
    }
  }
  return `http://localhost:${port}`;
}

interface Props {
  config: DevStackConfig;
  services: ServiceConfig[];
  cliArgs: CliArgs;
  platform: Platform;
  env: Record<string, string>;
  baseCwd: string;
  proxyProvider: ProxyConfigProvider | null;
  proxyOpts: ProxyOpts | null;
  logSink: LogSink | null;
}

export function App({ config, services, cliArgs, platform, env, baseCwd, proxyProvider, proxyOpts, logSink }: Props) {
  const rows = useTerminalSize();
  const logsHeight = Math.floor(rows * 0.65);
  const statsHeight = rows - logsHeight - 2; // 2 for header + statusbar
  const maxNameLen = Math.max(...services.map(s => s.name.length), 10);

  // Declared before the manager so it can tear a proxy down as part of removal.
  const lazyProxies = useRef<Map<string, LazyProxy>>(new Map());
  const pm = useProcessManager(platform, baseCwd, env, logSink, lazyProxies);
  const externals = useRef<ExternalProc[]>([]);

  const kb = useKeyBindings({
    onQuit: () => { void shutdown(); },
    onClearLogs: pm.clearLogs,
    onToggleProxy: () => {},
  });

  const proxyCtx = proxyProvider && proxyOpts ? { provider: proxyProvider, opts: proxyOpts } : null;
  const socketServer = useControlPlane(pm.manager, config.name, logSink, pm.pushLog, pm.logBus, pm.stateBus, pm.removedBus, lazyProxies, platform, proxyCtx, config.profiles ?? {}, cliArgs.instance);

  const shutdown = useCallback(async () => {
    lazyProxies.current.forEach(p => p.destroy());
    await socketServer.current?.close();
    await pm.cleanup();
    if (externals.current.length) {
      await stopExternals(externals.current, platform, {
        baseCwd, env,
        onLog: (svc, msg) => pm.pushLog(`ext:${svc}`, msg, 12),
      });
      externals.current = [];
    }
    await logSink?.close();
    process.exit(0);
  }, [pm, logSink, platform, baseCwd, env, socketServer]);

  useHotReload(pm.manager, cliArgs, baseCwd, pm.pushLog, config.services);
  useLogsPause(pm.setPaused, kb.logsPaused, kb.logsScrollOffset);
  const activeTip = useContextualTips(pm.logs.length, !!kb.searchTerm, !!kb.logFilter, pm.states);
  useProxySync(proxyProvider, proxyOpts, pm.states, kb.proxyEnabled);
  useBootSequence(pm.manager, config, services, cliArgs, platform, env, baseCwd,
    { lazyProxies, externals }, pm.pushLog);

  const handleFilterSelect = useCallback((name: string) => kb.setFilter(name), [kb]);
  const handleRestartSelect = useCallback((name: string) => { pm.restart(name); kb.setModal('none'); }, [pm, kb]);
  const handleOpenSelect = useCallback((name: string) => {
    const st = pm.states.get(name);
    if (st) {
      const url = buildServiceUrl(name, st.svc.port, cliArgs.proxy, proxyOpts);
      platform.openBrowser(url);
    }
    kb.setModal('none');
  }, [pm, platform, kb, cliArgs.proxy, proxyOpts]);

  const icon = config.icon ?? '📦';
  const modeLabel = cliArgs.lazy && config.lazy ? 'lazy' : 'normal';

  return (
    <Box flexDirection="column" height={rows}>
      <Box>
        <Text bold color="cyan"> {icon} {config.name} — devup — {services.length} services ({modeLabel}) </Text>
        {activeTip && <Text dimColor> · {activeTip}</Text>}
      </Box>

      <LogsPanel
        logs={pm.logs} filter={kb.logFilter} searchTerm={kb.searchTerm}
        paused={kb.logsPaused} showTimestamps={kb.showTimestamps}
        maxNameLen={maxNameLen} height={logsHeight} focused={kb.panel === 'logs'}
        scrollOffset={kb.logsScrollOffset} resetScroll={kb.resetLogsScroll}
        levelFilter={kb.levelFilter}
        filteredColorIdx={kb.logFilter ? (pm.states.get(kb.logFilter)?.colorIdx ?? null) : null}
      />

      <StatsPanel
        states={pm.states} stats={pm.stats} sortMode={kb.sortMode}
        maxNameLen={maxNameLen} height={statsHeight} focused={kb.panel === 'stats'}
        scrollOffset={kb.statsScrollOffset} resetScroll={kb.resetStatsScroll}
        verbose={kb.verboseStats}
      />

      {kb.modal === 'filter' && (
        <ServiceList title="Filter by service" services={pm.states} onSelect={handleFilterSelect} onClose={() => kb.setModal('none')} />
      )}
      {kb.modal === 'restart' && (
        <ServiceList title="Restart service" services={pm.states} onSelect={handleRestartSelect} onClose={() => kb.setModal('none')} />
      )}
      {kb.modal === 'open' && (
        <ServiceList title="Open in browser" services={pm.states} onSelect={handleOpenSelect} onClose={() => kb.setModal('none')} filterType="web" />
      )}
      {kb.modal === 'search' && (
        <SearchInput onSubmit={kb.setSearch} onClose={() => kb.setModal('none')} />
      )}

      <StatusBar />
    </Box>
  );
}
