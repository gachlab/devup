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
  }, { isActive });

  return { ...state, setModal, setFilter, setSearch, sortMode: SORT_MODES[state.sortIdx]! };
}
