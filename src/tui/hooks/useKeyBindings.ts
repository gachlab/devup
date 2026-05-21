import { useInput } from 'ink';
import React, { useState, useCallback } from 'react';

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

// delta < 0 = mover vista hacia arriba; delta > 0 = hacia abajo.
// Para logs el offset crece hacia atrás (más viejo), para stats crece hacia abajo (siguientes filas).
function scrollBy(setState: React.Dispatch<React.SetStateAction<KeyState>>, delta: number) {
  setState(s => {
    if (s.panel === 'logs') {
      // up visual → más viejas → bottomOffset + |delta|
      const next = s.logsScrollOffset - delta;
      return { ...s, logsScrollOffset: Math.max(0, next) };
    }
    const next = s.statsScrollOffset + delta;
    return { ...s, statsScrollOffset: Math.max(0, next) };
  });
}

function scrollTo(setState: React.Dispatch<React.SetStateAction<KeyState>>, target: 'top' | 'bottom') {
  setState(s => {
    if (s.panel === 'logs') {
      // top visual = línea más vieja = bottomOffset máximo
      return { ...s, logsScrollOffset: target === 'top' ? Number.MAX_SAFE_INTEGER : 0 };
    }
    return { ...s, statsScrollOffset: target === 'top' ? 0 : Number.MAX_SAFE_INTEGER };
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
    logsScrollOffset: 0, statsScrollOffset: 0,
  });

  const setModal = useCallback((modal: Modal) => setState(s => ({ ...s, modal })), []);
  const setFilter = useCallback((f: string | null) => setState(s => ({ ...s, logFilter: f, modal: 'none' })), []);
  const setSearch = useCallback((t: string | null) => setState(s => ({ ...s, searchTerm: t, modal: 'none' })), []);

  const isActive = process.stdin.isTTY ?? false;

  useInput((input, key) => {
    if (state.modal !== 'none') return;

    if (input === 'q' || (key.ctrl && input === 'c')) opts.onQuit();
    // ── Scroll (ctrl + tecla evaluado primero para no chocar con letras simples) ──
    else if (key.ctrl && input === 'a') scrollTo(setState, 'top');
    else if (key.ctrl && input === 'e') scrollTo(setState, 'bottom');
    else if (key.ctrl && input === 'b') scrollBy(setState, -10); // PgUp
    else if (key.ctrl && input === 'f') scrollBy(setState, +10); // PgDn
    else if (key.upArrow)               scrollBy(setState, -1);
    else if (key.downArrow)             scrollBy(setState, +1);
    else if (input === '[')             scrollBy(setState, -10);
    else if (input === ']')             scrollBy(setState, +10);
    // ── Acciones ──
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
