import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ServiceConfig } from './config/types.js';

// ── .env parsing ──

export function parseEnvFile(filePath: string, baseEnv: Record<string, string> = {}): Record<string, string> {
  const env = { ...baseEnv };
  if (!existsSync(filePath)) return env;

  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!env[key]) env[key] = val;
  }
  return env;
}

// ── Log level detection ──

export type LogLevel = 'error' | 'warn' | 'info';

/** Detects the level of a log line by case-insensitive keyword priority:
 *  error (and synonyms) > warn > info. Used by the L-level filter. */
export function detectLogLevel(line: string): LogLevel {
  const l = line.toLowerCase();
  // Conjugations covered for fail/crash; `error` and `exception` matched as exact word.
  if (/\b(?:error|err|fail(?:ed|ure|ures|s)?|fatal|exception|crash(?:ed|es)?)\b/.test(l) || /❌|✗|⛔/.test(line)) return 'error';
  if (/\b(?:warn(?:ed|ing|s|ings)?|deprec)\b/.test(l) || /⚠/.test(line)) return 'warn';
  return 'info';
}

// ── Search pattern ──

export interface SearchMatcher {
  test: (line: string) => boolean;
  /** Set when the input was a vim-style /pattern/flags — used to drive highlighting. */
  regex?: RegExp;
  /** True when input started with `/` but produced an invalid regex; UI may show a hint. */
  invalid?: boolean;
}

/** Compiles a search term to a matcher.
 *  - `/foo/` → regex (case-insensitive by default; honors flags after the closing slash)
 *  - anything else → case-insensitive substring (existing behavior)
 *  - invalid regex → falls back to substring, sets `invalid: true` */
export function compileSearchPattern(term: string | null): SearchMatcher | null {
  if (!term) return null;
  const slashed = /^\/(.+)\/([gimsuy]*)$/.exec(term);
  if (slashed) {
    const flags = slashed[2]!.includes('i') ? slashed[2]! : slashed[2]! + 'i';
    try {
      const re = new RegExp(slashed[1]!, flags);
      return { test: (l: string) => re.test(l), regex: re };
    } catch {
      const lower = term.toLowerCase();
      return { test: (l: string) => l.toLowerCase().includes(lower), invalid: true };
    }
  }
  const lower = term.toLowerCase();
  return { test: (l: string) => l.toLowerCase().includes(lower) };
}

// ── Format helpers ──

export function fmtUptime(ms: number): string {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

// ── npm install stamps ──

export function needsInstall(fullCwd: string): boolean {
  const nm = join(fullCwd, 'node_modules');
  if (!existsSync(nm)) return true;
  try {
    const pkgHash = createHash('md5').update(readFileSync(join(fullCwd, 'package.json'))).digest('hex');
    const stampFile = join(nm, '.install-stamp');
    if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === pkgHash) return false;
  } catch { /* stamp missing or unreadable */ }
  return true;
}

export function writeInstallStamp(fullCwd: string): void {
  try {
    const pkgHash = createHash('md5').update(readFileSync(join(fullCwd, 'package.json'))).digest('hex');
    writeFileSync(join(fullCwd, 'node_modules', '.install-stamp'), pkgHash);
  } catch { /* best effort */ }
}

// ── Sort helpers ──

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

// ── Phase grouping ──

export function groupByPhase(services: ServiceConfig[]): Record<number, ServiceConfig[]> {
  const phases: Record<number, ServiceConfig[]> = {};
  for (const s of services) {
    (phases[s.phase] ??= []).push(s);
  }
  return phases;
}

// ── Process args / env builders ──

export function buildProcessArgs(svc: ServiceConfig): string[] {
  const extra = svc.nodeArgs ?? [];
  if (!svc.maxMem) return [...extra, ...svc.args];
  if (svc.cmd === 'node') return [`--max-old-space-size=${svc.maxMem}`, ...extra, ...svc.args];
  return [...extra, ...svc.args];
}

export function buildProcessEnv(svc: ServiceConfig, baseEnv: Record<string, string>): Record<string, string> {
  const env = { ...baseEnv, ...(svc.extraEnv ?? {}) };
  if (svc.maxMem && svc.cmd !== 'node') {
    const existing = env['NODE_OPTIONS'] ?? '';
    const flag = `--max-old-space-size=${svc.maxMem}`;
    if (!existing.includes('max-old-space-size')) {
      env['NODE_OPTIONS'] = existing ? `${existing} ${flag}` : flag;
    }
  }
  return env;
}

// ── CPU percent calculation ──

export function calcCpuPercent(totalCpuSec: number, prevCpu: number, prevTime: number): number {
  const elapsed = (Date.now() - prevTime) / 1000;
  const cpuDelta = totalCpuSec - prevCpu;
  return elapsed > 0 ? (cpuDelta / elapsed) * 100 : 0;
}

// ── Color palette ──

export const tagColors = [
  'cyan', 'yellow', 'green', 'magenta', 'blue',
  'red', '#5faf5f', '#d7af5f', '#5f87d7', '#af5faf',
  '#5fd7d7', '#d75f5f', 'white',
];
