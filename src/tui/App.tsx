import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Platform } from '../platform/types.js';
import type { DevStackConfig, ServiceConfig } from '../config/types.js';
import type { CliArgs } from '../config/cli.js';
import type { ProxyConfigProvider, ProxyOpts } from '../proxy-config/types.js';
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

interface Props {
  config: DevStackConfig;
  services: ServiceConfig[];
  cliArgs: CliArgs;
  platform: Platform;
  env: Record<string, string>;
  baseCwd: string;
  proxyProvider: ProxyConfigProvider | null;
  proxyOpts: ProxyOpts | null;
}

export function App({ config, services, cliArgs, platform, env, baseCwd, proxyProvider, proxyOpts }: Props) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 40;
  const logsHeight = Math.floor(rows * 0.65);
  const statsHeight = rows - logsHeight - 2; // 2 for header + statusbar
  const maxNameLen = Math.max(...services.map(s => s.name.length), 10);

  const pm = useProcessManager(platform, baseCwd, env);
  const [booted, setBooted] = useState(false);
  const lazyProxies = useRef<Map<string, LazyProxy>>(new Map());

  const kb = useKeyBindings({
    onQuit: () => {
      lazyProxies.current.forEach(p => p.destroy());
      pm.cleanup();
      process.exit(0);
    },
    onClearLogs: () => {},
    onToggleProxy: () => {},
  });

  useProxySync(proxyProvider, proxyOpts, pm.states, kb.proxyEnabled);

  // Boot sequence
  useEffect(() => {
    if (booted || !pm.manager) return;
    setBooted(true);
    const mgr = pm.manager;

    (async () => {
      const lazyMode = cliArgs.lazy;
      const lazyTimeout = cliArgs.lazyTimeout;

      if (lazyMode && config.lazy) {
        // ── Lazy mode ──
        const { alwaysOn, lazy } = classifyServices(services, config.lazy);

        // Boot always-on services normally
        const aoPhases = groupByPhase(alwaysOn);
        let colorIdx = 0;
        for (const num of Object.keys(aoPhases).map(Number).sort((a, b) => a - b)) {
          const svcs = aoPhases[num]!;
          for (const svc of svcs) {
            await mgr.install(svc);
            await mgr.start(svc, colorIdx++);
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
              await mgr.install(rewritten);
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
            await mgr.install(svc);
            await mgr.start(svc, colorIdx++);
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
    if (st) platform.openBrowser(`http://localhost:${st.svc.port}`);
    kb.setModal('none');
  }, [pm, platform, kb]);

  const icon = config.icon ?? '📦';
  const modeLabel = cliArgs.lazy && config.lazy ? 'lazy' : 'normal';

  return (
    <Box flexDirection="column" height={rows}>
      <Box><Text bold color="cyan"> {icon} {config.name} — devup — {services.length} services ({modeLabel}) </Text></Box>

      <LogsPanel
        logs={pm.logs} filter={kb.logFilter} searchTerm={kb.searchTerm}
        paused={kb.logsPaused} showTimestamps={kb.showTimestamps}
        maxNameLen={maxNameLen} height={logsHeight} focused={kb.panel === 'logs'}
      />

      <StatsPanel
        states={pm.states} stats={pm.stats} sortMode={kb.sortMode}
        maxNameLen={maxNameLen} height={statsHeight} focused={kb.panel === 'stats'}
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
