import { useState, useEffect, useRef, useCallback } from 'react';
import { ProcessManager } from '../../process/manager.js';
import type { ProcessState } from '../../process/types.js';
import type { Platform } from '../../platform/types.js';
import type { ServiceConfig } from '../../config/types.js';
import { calcCpuPercent, tagColors } from '../../utils.js';

export interface LogEntry {
  svcName: string;
  text: string;
  colorIdx: number;
  ts: number;
}

export interface ServiceStats {
  cpu: string;
  mem: string;
}

export function useProcessManager(platform: Platform, baseCwd: string, env: Record<string, string>) {
  const [states, setStates] = useState<Map<string, ProcessState>>(new Map());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<Map<string, ServiceStats>>(new Map());
  const mgrRef = useRef<ProcessManager | null>(null);
  const prevCpu = useRef<Map<string, { time: number; cpu: number }>>(new Map());

  useEffect(() => {
    const mgr = new ProcessManager({
      baseCwd, env, platform,
      events: {
        onLog: (svcName, text, colorIdx) => {
          const lines = text.split('\n').filter(Boolean);
          setLogs(prev => {
            const next = [...prev, ...lines.map(l => ({ svcName, text: l, colorIdx, ts: Date.now() }))];
            return next.length > 5000 ? next.slice(-5000) : next;
          });
        },
        onStateChange: () => setStates(new Map(mgr.state)),
      },
    });
    mgrRef.current = mgr;
    return () => { mgr.cleanup(); };
  }, [baseCwd, env, platform]);

  // Health + stats polling
  useEffect(() => {
    const id = setInterval(async () => {
      const mgr = mgrRef.current;
      if (!mgr) return;
      await mgr.checkAllHealth();
      setStates(new Map(mgr.state));

      const pids: number[] = [];
      const pidMap = new Map<number, string>();
      for (const [name, st] of mgr.state) {
        if (st.pid) { pids.push(st.pid); pidMap.set(st.pid, name); }
      }
      if (pids.length) {
        const raw = await platform.getProcessStats(pids);
        const next = new Map<string, ServiceStats>();
        for (const [pid, data] of raw) {
          const name = pidMap.get(pid);
          if (!name) continue;
          const prev = prevCpu.current.get(name) ?? { time: Date.now(), cpu: 0 };
          const cpuPct = calcCpuPercent(data.cpuSeconds, prev.cpu, prev.time);
          prevCpu.current.set(name, { time: Date.now(), cpu: data.cpuSeconds });
          next.set(name, { cpu: cpuPct.toFixed(1) + '%', mem: (data.rss / 1024).toFixed(1) + ' MB' });
        }
        setStats(next);
      }
    }, 3000);
    return () => clearInterval(id);
  }, [platform]);

  const mgr = mgrRef.current;

  return {
    states, logs, stats,
    start: useCallback((svc: ServiceConfig, colorIdx: number) => mgr?.start(svc, colorIdx), [mgr]),
    stop: useCallback((name: string) => mgr?.stop(name), [mgr]),
    restart: useCallback((name: string) => mgr?.restart(name), [mgr]),
    install: useCallback((svc: ServiceConfig) => mgr?.install(svc), [mgr]),
    cleanup: useCallback(() => mgr?.cleanup(), [mgr]),
    manager: mgr,
  };
}
