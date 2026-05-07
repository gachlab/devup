import { useInput } from 'ink';
import { useState, useCallback } from 'react';

export type Modal = 'none' | 'filter' | 'restart' | 'open' | 'search';
export type Panel = 'logs' | 'stats';

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
}

const SORT_MODES = ['name', 'mem', 'errors'] as const;

export function useKeyBindings(opts: {
  onQuit: () => void;
  onClearLogs: () => void;
  onToggleProxy: () => void;
}) {
  const [state, setState] = useState<KeyState>({
    panel: 'logs', modal: 'none', logFilter: null, searchTerm: null,
    logsPaused: false, showTimestamps: false, sortIdx: 0, proxyEnabled: false,
    logsScrollOffset: 0, statsScrollOffset: 0,
  });

  const setModal = useCallback((modal: Modal) => setState(s => ({ ...s, modal })), []);
  const setFilter = useCallback((f: string | null) => setState(s => ({ ...s, logFilter: f, modal: 'none' })), []);
  const setSearch = useCallback((t: string | null) => setState(s => ({ ...s, searchTerm: t, modal: 'none' })), []);

  const isActive = process.stdin.isTTY ?? false;

  useInput((input, key) => {
    if (state.modal !== 'none') return;

    if (input === 'q' || (key.ctrl && input === 'c')) opts.onQuit();
    else if (input === 'c') opts.onClearLogs();
    else if (key.tab) setState(s => ({ ...s, panel: s.panel === 'logs' ? 'stats' : 'logs' }));
    else if (input === 'f') setModal('filter');
    else if (input === 'r') setModal('restart');
    else if (input === 'o') setModal('open');
    else if (input === '/') setModal('search');
    else if (input === 'a') setState(s => ({ ...s, logFilter: null, searchTerm: null }));
    else if (input === 'p') setState(s => ({ ...s, logsPaused: !s.logsPaused }));
    else if (input === 't') setState(s => ({ ...s, showTimestamps: !s.showTimestamps }));
    else if (input === 's') setState(s => ({ ...s, sortIdx: (s.sortIdx + 1) % SORT_MODES.length }));
    else if (input === 'T') { opts.onToggleProxy(); setState(s => ({ ...s, proxyEnabled: !s.proxyEnabled })); }
    // Navegación con flechas
    else if (key.upArrow) {
      setState(s => {
        if (s.panel === 'logs') {
          return { ...s, logsScrollOffset: Math.max(0, s.logsScrollOffset - 1) };
        } else if (s.panel === 'stats') {
          return { ...s, statsScrollOffset: Math.max(0, s.statsScrollOffset - 1) };
        }
        return s;
      });
    }
    else if (key.downArrow) {
      setState(s => {
        if (s.panel === 'logs') {
          return { ...s, logsScrollOffset: s.logsScrollOffset + 1 };
        } else if (s.panel === 'stats') {
          return { ...s, statsScrollOffset: s.statsScrollOffset + 1 };
        }
        return s;
      });
    }
    // Teclas de página (Page Up/Page Down)
    else if (input === '[' || (key.ctrl && input === 'b')) { // Page Up
      setState(s => {
        if (s.panel === 'logs') {
          return { ...s, logsScrollOffset: Math.max(0, s.logsScrollOffset - 10) };
        } else if (s.panel === 'stats') {
          return { ...s, statsScrollOffset: Math.max(0, s.statsScrollOffset - 10) };
        }
        return s;
      });
    }
    else if (input === ']' || (key.ctrl && input === 'f')) { // Page Down
      setState(s => {
        if (s.panel === 'logs') {
          return { ...s, logsScrollOffset: s.logsScrollOffset + 10 };
        } else if (s.panel === 'stats') {
          return { ...s, statsScrollOffset: s.statsScrollOffset + 10 };
        }
        return s;
      });
    }
    // Ir al inicio/fin
    else if (key.ctrl && input === 'a') { // Home
      setState(s => {
        if (s.panel === 'logs') {
          return { ...s, logsScrollOffset: 0 };
        } else if (s.panel === 'stats') {
          return { ...s, statsScrollOffset: 0 };
        }
        return s;
      });
    }
    else if (key.ctrl && input === 'e') { // End
      setState(s => {
        if (s.panel === 'logs') {
          return { ...s, logsScrollOffset: Number.MAX_SAFE_INTEGER };
        } else if (s.panel === 'stats') {
          return { ...s, statsScrollOffset: Number.MAX_SAFE_INTEGER };
        }
        return s;
      });
    }
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
  };
}
