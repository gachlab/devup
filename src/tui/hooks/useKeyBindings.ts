import { useInput } from 'ink';
import React, { useState, useCallback, useRef } from 'react';

export type Modal = 'none' | 'filter' | 'restart' | 'open' | 'search' | 'remote';
export type Panel = 'logs' | 'stats';

export type LevelFilter = 'all' | 'error' | 'warn';

export interface KeyState {
  panel: Panel;
  modal: Modal;
  logFilter: string | null;
  searchTerm: string | null;
  logsPaused: boolean;
  showTimestamps: boolean;
  sortIdx: number;
  proxyEnabled: boolean;
  logsScrollOffset: number;
  statsScrollOffset: number;
  levelFilter: LevelFilter;
  verboseStats: boolean;
}

const SORT_MODES = ['name', 'mem', 'errors'] as const;

/** How far each panel can scroll, reported by the panels themselves (they are
 *  the ones that know the line count and their height). */
export interface ScrollLimits { logs: number; stats: number }

const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max));

// delta < 0 moves the view up, delta > 0 down. The logs offset counts lines
// above the bottom (0 = follow); the stats offset counts rows below the top.
//
// Clamped to what the panel can show. Unclamped, the offset could run past the
// content: one ↑ with fewer lines than fit paused the logs (the pause reads the
// raw offset) with no [SCROLL] shown, and every extra ↑ past the top had to be
// undone by a ↓ that seemed to do nothing.
function scrollBy(setState: React.Dispatch<React.SetStateAction<KeyState>>, limits: ScrollLimits, delta: number) {
  setState(s => {
    if (s.panel === 'logs') {
      return { ...s, logsScrollOffset: clamp(s.logsScrollOffset - delta, limits.logs) };
    }
    return { ...s, statsScrollOffset: clamp(s.statsScrollOffset + delta, limits.stats) };
  });
}

// A real offset, not a sentinel. `Number.MAX_SAFE_INTEGER` for "top" left the
// next ↓ at MAX - 1 — no longer the sentinel, so it clamped straight back to
// the top and ↓, `]` and Ctrl+F never moved after Home.
function scrollTo(setState: React.Dispatch<React.SetStateAction<KeyState>>, limits: ScrollLimits, target: 'top' | 'bottom') {
  setState(s => {
    if (s.panel === 'logs') {
      return { ...s, logsScrollOffset: target === 'top' ? limits.logs : 0 };
    }
    return { ...s, statsScrollOffset: target === 'top' ? 0 : limits.stats };
  });
}

export function useKeyBindings(opts: {
  onQuit: () => void;
  onClearLogs: () => void;
  onToggleProxy: () => void;
}) {
  const [state, setState] = useState<KeyState>({
    panel: 'logs', modal: 'none', logFilter: null, searchTerm: null,
    logsPaused: false, showTimestamps: false, sortIdx: 0, proxyEnabled: false,
    logsScrollOffset: 0, statsScrollOffset: 0, levelFilter: 'all', verboseStats: false,
  });

  const LEVEL_CYCLE: LevelFilter[] = ['all', 'error', 'warn'];

  const setModal = useCallback((modal: Modal) => setState(s => ({ ...s, modal })), []);
  const setFilter = useCallback((f: string | null) => setState(s => ({ ...s, logFilter: f, modal: 'none' })), []);
  const setSearch = useCallback((t: string | null) => setState(s => ({ ...s, searchTerm: t, modal: 'none' })), []);

  // Infinity until a panel reports in, which keeps the old behaviour for a
  // render that has not measured yet.
  const limits = useRef<ScrollLimits>({ logs: Infinity, stats: Infinity });
  // Content can shrink under the offset (`c`, a filter, a resize): clamp the
  // stored offset too, or the logs stay paused on an offset nothing shows.
  const setLogsMaxOffset = useCallback((max: number) => {
    limits.current.logs = max;
    setState(s => s.logsScrollOffset > max ? { ...s, logsScrollOffset: max } : s);
  }, []);
  const setStatsMaxOffset = useCallback((max: number) => {
    limits.current.stats = max;
    setState(s => s.statsScrollOffset > max ? { ...s, statsScrollOffset: max } : s);
  }, []);

  const isActive = process.stdin.isTTY ?? false;

  useInput((input, key) => {
    // Ctrl+C quits from anywhere, a modal included: Ink does not turn it into
    // SIGINT here (`exitOnCtrlC: false`), so swallowing it left no way out but
    // Esc first — and docs/tui.md says it always quits.
    if (key.ctrl && input === 'c') { opts.onQuit(); return; }
    if (state.modal !== 'none') return;

    const l = limits.current;
    if (input === 'q') opts.onQuit();
    // ── Scroll (ctrl + key first, so it does not collide with plain letters) ──
    else if (key.ctrl && input === 'a') scrollTo(setState, l, 'top');
    else if (key.ctrl && input === 'e') scrollTo(setState, l, 'bottom');
    else if (key.ctrl && input === 'b') scrollBy(setState, l, -10);
    else if (key.ctrl && input === 'f') scrollBy(setState, l, +10);
    else if (key.pageUp)                scrollBy(setState, l, -10);
    else if (key.pageDown)              scrollBy(setState, l, +10);
    else if (key.upArrow)               scrollBy(setState, l, -1);
    else if (key.downArrow)             scrollBy(setState, l, +1);
    else if (input === '[')             scrollBy(setState, l, -10);
    else if (input === ']')             scrollBy(setState, l, +10);
    // ── Acciones ──
    else if (input === 'c') opts.onClearLogs();
    else if (key.tab) setState(s => ({ ...s, panel: s.panel === 'logs' ? 'stats' : 'logs' }));
    else if (input === 'f') setModal('filter');
    else if (input === 'r') setModal('restart');
    else if (input === 'o') setModal('open');
    else if (input === 'e') setModal('remote');
    else if (input === '/') setModal('search');
    else if (input === 'a') setState(s => ({ ...s, logFilter: null, searchTerm: null, levelFilter: 'all' }));
    else if (input === 'p') setState(s => ({ ...s, logsPaused: !s.logsPaused }));
    else if (input === 't') setState(s => ({ ...s, showTimestamps: !s.showTimestamps }));
    else if (input === 's') setState(s => ({ ...s, sortIdx: (s.sortIdx + 1) % SORT_MODES.length }));
    else if (input === 'T') { opts.onToggleProxy(); setState(s => ({ ...s, proxyEnabled: !s.proxyEnabled })); }
    else if (input === 'L') setState(s => ({ ...s, levelFilter: LEVEL_CYCLE[(LEVEL_CYCLE.indexOf(s.levelFilter) + 1) % LEVEL_CYCLE.length]! }));
    else if (input === 'v') setState(s => ({ ...s, verboseStats: !s.verboseStats }));
  }, { isActive });

  return { 
    ...state, 
    setModal, 
    setFilter, 
    setSearch, 
    sortMode: SORT_MODES[state.sortIdx]!,
    // Funciones para resetear el scroll cuando cambia el contenido
    resetLogsScroll: useCallback(() => setState(s => ({ ...s, logsScrollOffset: 0 })), []),
    resetStatsScroll: useCallback(() => setState(s => ({ ...s, statsScrollOffset: 0 })), []),
    setLogsMaxOffset,
    setStatsMaxOffset,
  };
}
