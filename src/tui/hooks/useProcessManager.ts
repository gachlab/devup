import { useState, useEffect, useRef, useCallback } from 'react';
import { ProcessManager } from '../../process/manager.js';
import type { ProcessState } from '../../process/types.js';
import type { Platform } from '../../platform/types.js';
import type { ServiceConfig } from '../../config/types.js';
import { calcCpuPercent, detectLogLevel, type LogLevel } from '../../utils.js';
import { LogSink } from '../../process/log-sink.js';
import { Broadcaster } from '../../utils/broadcaster.js';
import { releaseRemoteProxy } from '../../remote/classifier.js';
import { releaseLazyProxy } from '../../lazy/classifier.js';

export interface LogEntry {
  svcName: string;
  text: string;
  colorIdx: number;
  ts: number;
  level: LogLevel;
}

/** Lines kept in memory for the panel. */
export const LOG_CAP = 5000;
/** How long lines pile up before one render shows them all. */
export const LOG_FLUSH_MS = 50;

const capped = (lines: LogEntry[]) => lines.length > LOG_CAP ? lines.slice(-LOG_CAP) : lines;

export interface ServiceStats {
  cpu: string;
  mem: string;
}

export function useProcessManager(
  platform: Platform,
  baseCwd: string,
  env: Record<string, string>,
  logSink: LogSink | null = null,
  lazyProxies?: React.RefObject<Map<string, { destroy: () => void }>>,
  remoteProxies?: React.RefObject<Map<string, { destroy: () => void }>>,
) {
  const [states, setStates] = useState<Map<string, ProcessState>>(new Map());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<Map<string, ServiceStats>>(new Map());
  const mgrRef = useRef<ProcessManager | null>(null);
  // State, not only the ref: reading a ref during render saw `null` until some
  // unrelated update happened to re-render, so the boot effect — which waits
  // for the manager — only ran once a panel's mount effect forced a second
  // render. That was luck, not design.
  const [manager, setManager] = useState<ProcessManager | null>(null);
  const prevCpu = useRef<Map<string, { time: number; cpu: number }>>(new Map());
  const pausedRef = useRef(false);
  const pendingLogsRef = useRef<LogEntry[]>([]);
  // Lines waiting for the next flush. Every line used to call `setLogs` on its
  // own: a copy of up to 5000 entries and a full render per line, which a
  // chatty dev server (vite, webpack) turned into a pinned CPU.
  const incomingRef = useRef<LogEntry[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushIncoming = useCallback(() => {
    flushTimer.current = null;
    const batch = incomingRef.current;
    if (!batch.length) return;
    incomingRef.current = [];
    setLogs(prev => capped(prev.concat(batch)));
  }, []);

  /** One path for every line, from a service or from devup itself. */
  const enqueueLog = useCallback((entry: LogEntry) => {
    if (pausedRef.current) {
      pendingLogsRef.current.push(entry);
      if (pendingLogsRef.current.length > LOG_CAP) pendingLogsRef.current = pendingLogsRef.current.slice(-LOG_CAP);
      return;
    }
    incomingRef.current.push(entry);
    if (incomingRef.current.length > LOG_CAP) incomingRef.current = incomingRef.current.slice(-LOG_CAP);
    flushTimer.current ??= setTimeout(flushIncoming, LOG_FLUSH_MS);
  }, [flushIncoming]);
  useEffect(() => () => { if (flushTimer.current) clearTimeout(flushTimer.current); }, []);
  const sinkRef = useRef<LogSink | null>(logSink);
  sinkRef.current = logSink;

  // Stable broadcaster instances — control plane subscribers tap into these.
  const logBus = useRef(new Broadcaster<{ svc: string; text: string }>());
  const stateBus = useRef(new Broadcaster<{ name: string; state: ProcessState }>());
  const removedBus = useRef(new Broadcaster<{ name: string }>());

  useEffect(() => {
    const mgr = new ProcessManager({
      baseCwd, env, platform,
      events: {
        onLog: (svcName, text, colorIdx) => {
          sinkRef.current?.write(svcName, text);
          logBus.current.emit({ svc: svcName, text });
          enqueueLog({ svcName, text, colorIdx, ts: Date.now(), level: detectLogLevel(text) });
        },
        onStateChange: (name, state) => {
          stateBus.current.emit({ name, state });
          setStates(new Map(mgr.state));
        },
        onServiceRemoved: (name) => {
          releaseLazyProxy(lazyProxies?.current, name);
          // Both, and before the removal is announced: either one left alive
          // keeps answering on the service's public port.
          releaseRemoteProxy(remoteProxies?.current, name);
          prevCpu.current?.delete(name);
          removedBus.current.emit({ name });
          setStates(new Map(mgr.state));
        },
      },
    });
    mgrRef.current = mgr;
    setManager(mgr);
    return () => { mgrRef.current = null; setManager(null); mgr.cleanup(); };
  }, [baseCwd, env, platform, enqueueLog]);

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

  const mgr = manager;

  const clearLogs = useCallback(() => { pendingLogsRef.current = []; incomingRef.current = []; setLogs([]); }, []);

  /** Push a log line not tied to a ProcessManager-managed service (e.g. externals). */
  const pushLog = useCallback((svcName: string, text: string, colorIdx = 0) => {
    sinkRef.current?.write(svcName, text);
    logBus.current.emit({ svc: svcName, text });
    enqueueLog({ svcName, text, colorIdx, ts: Date.now(), level: detectLogLevel(text) });
  }, [enqueueLog]);

  /** Pause or resume the panel. Lines already queued for the next flush go
   *  out *now*, ahead of anything that arrives later: left on their timer they
   *  landed after a resume's backlog (out of order), or after the pause itself
   *  — moving the view under someone who just scrolled up to read it. */
  const setPaused = useCallback((paused: boolean) => {
    if (paused === pausedRef.current) return;
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    const queued = incomingRef.current;
    incomingRef.current = [];
    pausedRef.current = paused;
    const backlog = paused ? [] : pendingLogsRef.current;
    if (!paused) pendingLogsRef.current = [];
    if (queued.length || backlog.length) setLogs(prev => capped(prev.concat(queued, backlog)));
  }, []);

  return {
    states, logs, stats,
    start: useCallback((svc: ServiceConfig, colorIdx: number) => mgr?.start(svc, colorIdx), [mgr]),
    stop: useCallback((name: string) => mgr?.stop(name), [mgr]),
    install: useCallback((svc: ServiceConfig, colorIdx: number) => mgr?.install(svc, colorIdx), [mgr]),
    cleanup: useCallback(() => mgr?.cleanup(), [mgr]),
    clearLogs,
    setPaused,
    pushLog,
    manager: mgr,
    logBus: logBus.current,
    stateBus: stateBus.current,
    removedBus: removedBus.current,
  };
}
