import { useState, useEffect, useRef, useCallback } from 'react';
import { ProcessManager } from '../../process/manager.js';
import type { ProcessState } from '../../process/types.js';
import type { Platform } from '../../platform/types.js';
import type { ServiceConfig } from '../../config/types.js';
import { calcCpuPercent, detectLogLevel, type LogLevel } from '../../utils.js';
import { LogSink } from '../../process/log-sink.js';
import { Broadcaster } from '../../utils/broadcaster.js';

export interface LogEntry {
  svcName: string;
  text: string;
  colorIdx: number;
  ts: number;
  level: LogLevel;
}

export interface ServiceStats {
  cpu: string;
  mem: string;
}

export function useProcessManager(
  platform: Platform,
  baseCwd: string,
  env: Record<string, string>,
  logSink: LogSink | null = null,
) {
  const [states, setStates] = useState<Map<string, ProcessState>>(new Map());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<Map<string, ServiceStats>>(new Map());
  const mgrRef = useRef<ProcessManager | null>(null);
  const prevCpu = useRef<Map<string, { time: number; cpu: number }>>(new Map());
  const pausedRef = useRef(false);
  const pendingLogsRef = useRef<LogEntry[]>([]);
  const sinkRef = useRef<LogSink | null>(logSink);
  sinkRef.current = logSink;

  // Stable broadcaster instances — control plane subscribers tap into these.
  const logBus = useRef(new Broadcaster<{ svc: string; text: string }>());
  const stateBus = useRef(new Broadcaster<{ name: string; state: ProcessState }>());

  useEffect(() => {
    const mgr = new ProcessManager({
      baseCwd, env, platform,
      events: {
        onLog: (svcName, text, colorIdx) => {
          sinkRef.current?.write(svcName, text);
          logBus.current.emit({ svc: svcName, text });
          const entry: LogEntry = { svcName, text, colorIdx, ts: Date.now(), level: detectLogLevel(text) };
          if (pausedRef.current) {
            pendingLogsRef.current.push(entry);
            if (pendingLogsRef.current.length > 5000) {
              pendingLogsRef.current = pendingLogsRef.current.slice(-5000);
            }
            return;
          }
          setLogs(prev => {
            const next = prev.concat(entry);
            return next.length > 5000 ? next.slice(-5000) : next;
          });
        },
        onStateChange: (name, state) => {
          stateBus.current.emit({ name, state });
          setStates(new Map(mgr.state));
        },
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

  const clearLogs = useCallback(() => { pendingLogsRef.current = []; setLogs([]); }, []);

  /** Push a log line not tied to a ProcessManager-managed service (e.g. externals). */
  const pushLog = useCallback((svcName: string, text: string, colorIdx = 0) => {
    sinkRef.current?.write(svcName, text);
    logBus.current.emit({ svc: svcName, text });
    const entry: LogEntry = { svcName, text, colorIdx, ts: Date.now(), level: detectLogLevel(text) };
    if (pausedRef.current) {
      pendingLogsRef.current.push(entry);
      if (pendingLogsRef.current.length > 5000) {
        pendingLogsRef.current = pendingLogsRef.current.slice(-5000);
      }
      return;
    }
    setLogs(prev => {
      const next = prev.concat(entry);
      return next.length > 5000 ? next.slice(-5000) : next;
    });
  }, []);

  const setPaused = useCallback((paused: boolean) => {
    pausedRef.current = paused;
    if (!paused && pendingLogsRef.current.length) {
      const flush = pendingLogsRef.current;
      pendingLogsRef.current = [];
      setLogs(prev => {
        const next = prev.concat(flush);
        return next.length > 5000 ? next.slice(-5000) : next;
      });
    }
  }, []);

  return {
    states, logs, stats,
    start: useCallback((svc: ServiceConfig, colorIdx: number) => mgr?.start(svc, colorIdx), [mgr]),
    stop: useCallback((name: string) => mgr?.stop(name), [mgr]),
    restart: useCallback((name: string) => mgr?.restart(name), [mgr]),
    install: useCallback((svc: ServiceConfig, colorIdx: number) => mgr?.install(svc, colorIdx), [mgr]),
    cleanup: useCallback(() => mgr?.cleanup(), [mgr]),
    clearLogs,
    setPaused,
    pushLog,
    manager: mgr,
    logBus: logBus.current,
    stateBus: stateBus.current,
  };
}
