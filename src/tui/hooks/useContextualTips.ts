import { useEffect, useRef, useState } from 'react';
import type { ProcessState } from '../../process/types.js';
import { pickTip } from '../tips.js';
import { isCrashLooped } from '../StatsPanel.js';

/** Surfaces a one-liner tip in teachable moments (high log volume, crash
 *  loop, etc.). Each tip shows at most once per session and auto-clears
 *  after 12 s. */
export function useContextualTips(
  totalLogs: number,
  hasSearch: boolean,
  hasFilter: boolean,
  states: Map<string, ProcessState>,
): string | null {
  const shownTips = useRef<Set<string>>(new Set());
  const [activeTip, setActiveTip] = useState<string | null>(null);

  useEffect(() => {
    const tip = pickTip({
      totalLogs,
      hasSearch,
      hasFilter,
      crashLoopedCount: [...states.values()].filter(isCrashLooped).length,
      shown: shownTips.current,
    });
    if (tip && tip.message !== activeTip) {
      shownTips.current.add(tip.id);
      setActiveTip(tip.message);
      const timer = setTimeout(() => setActiveTip(null), 12_000);
      return () => clearTimeout(timer);
    }
  }, [totalLogs, states, hasSearch, hasFilter, activeTip]);

  return activeTip;
}
