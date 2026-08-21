import { loadavg } from 'node:os';

export interface SystemLoad {
  /** 1-minute load average, rounded to 2 decimals. */
  loadAvg1?: number;
  /** That load as a percentage of available cores — comparable between a
   *  4-core laptop and a 32-core workstation, and the figure to show as "CPU". */
  cpuPercent?: number;
}

/** Host CPU load for the stats snapshot.
 *
 *  Reports nothing on Windows: `os.loadavg()` is hardcoded to `[0, 0, 0]` there,
 *  and a zero would be rendered by clients as a genuinely idle machine. Absent
 *  fields let them fall back or hide the figure instead of showing a lie. */
export function systemLoad(
  cores: number,
  opts: { platform?: NodeJS.Platform; raw?: readonly number[] } = {},
): SystemLoad {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return {};

  const one = (opts.raw ?? loadavg())[0];
  if (typeof one !== 'number' || !Number.isFinite(one) || one < 0) return {};

  const out: SystemLoad = { loadAvg1: Math.round(one * 100) / 100 };
  if (cores > 0) out.cpuPercent = Math.round((one / cores) * 1000) / 10;
  return out;
}
