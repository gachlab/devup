/** Contextual tips for new users. Pure function — easy to test, easy to extend. */

export interface TipState {
  totalLogs: number;
  hasSearch: boolean;
  hasFilter: boolean;
  crashLoopedCount: number;
  /** IDs of tips already shown this session — they don't repeat. */
  shown: Set<string>;
}

export interface Tip {
  id: string;
  message: string;
}

/** Picks the highest-priority unseen tip whose conditions are met,
 *  or null if no tip applies right now. */
export function pickTip(state: TipState): Tip | null {
  // Order = priority. Higher-impact first.
  if (state.crashLoopedCount > 0 && !state.shown.has('crashed')) {
    return { id: 'crashed', message: 'tip: press r to restart, or check the log of the failing service' };
  }
  if (state.totalLogs > 1000 && !state.hasSearch && !state.shown.has('search')) {
    return { id: 'search', message: 'tip: press / to search in logs' };
  }
  if (state.totalLogs > 500 && !state.hasFilter && !state.shown.has('filter')) {
    return { id: 'filter', message: 'tip: press f to filter logs by service' };
  }
  return null;
}
