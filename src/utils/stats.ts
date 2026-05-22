/** Returns a copy of `names` sorted by the requested mode.
 *  - `'name'` → alphabetical
 *  - `'mem'` → highest mem first (string-parsed)
 *  - any other (treated as `'errors'`) → highest error count first */
export function sortServiceNames(
  names: string[], sortMode: string,
  statsMap: Record<string, { cpu?: string; mem?: string }>,
  procState: Record<string, { errors?: number }>,
): string[] {
  if (sortMode === 'name') return names.slice().sort();
  return names.slice().sort((a, b) => {
    if (sortMode === 'mem') {
      return (parseFloat(statsMap[b]?.mem ?? '0') || 0) - (parseFloat(statsMap[a]?.mem ?? '0') || 0);
    }
    return (procState[b]?.errors ?? 0) - (procState[a]?.errors ?? 0);
  });
}

/** Converts cumulative CPU seconds into a percentage of wall-clock time
 *  elapsed since the previous sample. */
export function calcCpuPercent(totalCpuSec: number, prevCpu: number, prevTime: number): number {
  const elapsed = (Date.now() - prevTime) / 1000;
  const cpuDelta = totalCpuSec - prevCpu;
  return elapsed > 0 ? (cpuDelta / elapsed) * 100 : 0;
}

/** Hysteresis state machine for the "RAM pressure" banner.
 *  - turns on when usagePct ≥ highWatermark
 *  - turns off when usagePct < lowWatermark
 *  - stays as-is in the dead band between watermarks */
export function nextRamBannerVisibility(
  usagePct: number,
  previousVisible: boolean,
  highWatermark = 80,
  lowWatermark = 75,
): boolean {
  if (usagePct >= highWatermark) return true;
  if (usagePct < lowWatermark) return false;
  return previousVisible;
}
