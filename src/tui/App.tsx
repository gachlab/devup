import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Platform } from '../platform/types.js';
import type { DevStackConfig, ServiceConfig } from '../config/types.js';
import type { CliArgs } from '../config/cli.js';
import type { ProxyConfigProvider, ProxyOpts } from '../proxy-config/types.js';
import type { LogSink } from '../process/log-sink.js';
import { useProcessManager } from './hooks/useProcessManager.js';
import { useKeyBindings } from './hooks/useKeyBindings.js';
import { useProxySync } from './hooks/useProxySync.js';
import { LogsPanel } from './LogsPanel.js';
import { StatsPanel } from './StatsPanel.js';
import { StatusBar } from './StatusBar.js';
import { ServiceList } from './ServiceList.js';
import { SearchInput } from './SearchInput.js';
import { groupByPhase } from '../utils.js';
import { waitForPort } from '../process/health.js';
import { classifyServices, rewriteServicePort } from '../lazy/classifier.js';
import { createLazyProxy, type LazyProxy } from '../lazy/proxy.js';
import type { ProcessState } from '../process/types.js';
import { startExternals, stopExternals, type ExternalProc } from '../process/external.js';
import { isCrashLooped } from './StatsPanel.js';
import { pickTip } from './tips.js';

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
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout?.rows ?? 40);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setRows(stdout.rows ?? 40);
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  const logsHeight = Math.floor(rows * 0.65);
  const statsHeight = rows - logsHeight - 2; // 2 for header + statusbar
  const maxNameLen = Math.max(...services.map(s => s.name.length), 10);

  const pm = useProcessManager(platform, baseCwd, env, logSink);
  const [booted, setBooted] = useState(false);
  const lazyProxies = useRef<Map<string, LazyProxy>>(new Map());
  const externals = useRef<ExternalProc[]>([]);
  const shownTips = useRef<Set<string>>(new Set());
  const [activeTip, setActiveTip] = useState<string | null>(null);

  const kb = useKeyBindings({
    onQuit: () => {
      void shutdown();
    },
    onClearLogs: pm.clearLogs,
    onToggleProxy: () => {},
  });

  const shutdown = useCallback(async () => {
    lazyProxies.current.forEach(p => p.destroy());
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
  }, [pm, logSink, platform, baseCwd, env]);

  // Propagar pausa al sink de logs (incluye auto-pausa cuando el usuario scrolleó arriba).
  useEffect(() => {
    pm.setPaused(kb.logsPaused || kb.logsScrollOffset > 0);
  }, [kb.logsPaused, kb.logsScrollOffset, pm]);

  // Contextual tips: evaluate periodically, surface once per session.
  useEffect(() => {
    const tip = pickTip({
      totalLogs: pm.logs.length,
      hasSearch: !!kb.searchTerm,
      hasFilter: !!kb.logFilter,
      crashLoopedCount: [...pm.states.values()].filter(isCrashLooped).length,
      shown: shownTips.current,
    });
    if (tip && tip.id !== activeTip) {
      shownTips.current.add(tip.id);
      setActiveTip(tip.message);
      const timer = setTimeout(() => setActiveTip(null), 12_000);
      return () => clearTimeout(timer);
    }
  }, [pm.logs.length, pm.states, kb.searchTerm, kb.logFilter, activeTip]);

  useProxySync(proxyProvider, proxyOpts, pm.states, kb.proxyEnabled);

  // Boot sequence
  useEffect(() => {
    if (booted || !pm.manager) return;
    setBooted(true);
    const mgr = pm.manager;

    (async () => {
      const lazyMode = cliArgs.lazy;
      const lazyTimeout = cliArgs.lazyTimeout;

      // External dependencies (DBs, queues, etc.) — must be healthy before phase 0.
      if (config.external?.length) {
        const result = await startExternals(config.external, {
          baseCwd, env, platform,
          onLog: (svc, msg) => pm.pushLog(`ext:${svc}`, msg, 12),
        });
        externals.current = result.procs;
        if (!result.allHealthy) {
          pm.pushLog('devup', `❌ external(s) failed: ${result.failed.join(', ')}. Aborting boot.`, 5);
          return;
        }
      }

      if (lazyMode && config.lazy) {
        // ── Lazy mode ──
        const { alwaysOn, lazy } = classifyServices(services, config.lazy);

        // Boot always-on services normally
        const aoPhases = groupByPhase(alwaysOn);
        let colorIdx = 0;
        for (const num of Object.keys(aoPhases).map(Number).sort((a, b) => a - b)) {
          const svcs = aoPhases[num]!;
          for (const svc of svcs) {
            const ci = colorIdx++;
            await mgr.install(svc, ci);
            await mgr.start(svc, ci);
          }
          const apis = svcs.filter(s => s.type === 'api');
          if (apis.length) await Promise.all(apis.map(s => waitForPort(s.port, { timeout: 45000 })));
          svcs.filter(s => s.type === 'web').forEach(s => {
            const st = mgr.state.get(s.name);
            if (st) st.status = 'running';
          });
        }

        // Set up lazy proxies
        for (const svc of lazy) {
          const ci = colorIdx++;
          const rewritten = rewriteServicePort(svc);

          // Register as idle in process state
          const idleState: ProcessState = {
            svc: rewritten, proc: null, pid: null,
            status: 'idle', health: 'idle',
            errors: 0, restarts: 0, startedAt: null,
            intentionalStop: false, colorIdx: ci,
          };
          mgr.state.set(svc.name, idleState);

          const proxy = createLazyProxy({
            listenPort: svc.port,
            targetPort: rewritten.realPort,
            timeoutMin: lazyTimeout,
            onDemandStart: async () => {
              await mgr.install(rewritten, ci);
              await mgr.start(rewritten, ci);
              const ok = await waitForPort(rewritten.realPort, { timeout: 45000 });
              const st = mgr.state.get(svc.name);
              if (st) {
                st.status = ok ? 'running' : 'timeout';
                if (ok) st.health = 'up';
              }
            },
            onIdleStop: () => {
              mgr.stop(svc.name);
              const st = mgr.state.get(svc.name);
              if (st) { st.status = 'idle'; st.health = 'idle'; st.pid = null; st.proc = null; st.startedAt = null; }
            },
            isAlive: () => {
              const st = mgr.state.get(svc.name);
              return !!st && !!st.proc && !st.proc.killed && st.health === 'up';
            },
          });

          lazyProxies.current.set(svc.name, proxy);
        }
      } else {
        // ── Normal mode ──
        const phases = groupByPhase(services);
        let colorIdx = 0;
        for (const num of Object.keys(phases).map(Number).sort((a, b) => a - b)) {
          const svcs = phases[num]!;
          for (const svc of svcs) {
            const ci = colorIdx++;
            await mgr.install(svc, ci);
            await mgr.start(svc, ci);
          }
          const apis = svcs.filter(s => s.type === 'api');
          if (apis.length) await Promise.all(apis.map(s => waitForPort(s.port, { timeout: 45000 })));
          svcs.filter(s => s.type === 'web').forEach(s => {
            const st = mgr.state.get(s.name);
            if (st) st.status = 'running';
          });
        }
      }
    })();
  }, [booted, pm.manager, services, cliArgs, config.lazy]);

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
