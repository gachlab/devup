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

// ── Format helpers ──

export function fmtUptime(ms: number): string {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

// ── Search / highlight ──

export function highlightSearch(text: string, term: string | null, escapeFn?: (s: string) => string): string {
  const escaped = escapeFn ? escapeFn(text) : text;
  if (!term) return escaped;
  const idx = escaped.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return escaped;
  return `${escaped.slice(0, idx)}{black-fg}{yellow-bg}${escaped.slice(idx, idx + term.length)}{/yellow-bg}{/black-fg}${escaped.slice(idx + term.length)}`;
}

export function findSearchMatch(
  lines: string[], term: string, currentScroll: number,
  direction: 'next' | 'prev', stripTagsFn?: (s: string) => string,
): number {
  if (!term || !lines.length) return -1;
  const lower = term.toLowerCase();
  const len = lines.length;
  const start = direction === 'next' ? currentScroll + 1 : currentScroll - 1;
  for (let i = 0; i < len; i++) {
    const idx = direction === 'next' ? (start + i) % len : (start - i + len) % len;
    const raw = stripTagsFn ? stripTagsFn(lines[idx] ?? '') : (lines[idx] ?? '');
    if (raw.toLowerCase().includes(lower)) return idx;
  }
  return -1;
}

// ── Log formatting ──

export function formatLogLine(
  svcName: string, line: string, colorTag: string, maxNameLen: number,
  showTimestamps: boolean, searchTerm: string | null, escapeFn?: (s: string) => string,
): string {
  const padded = svcName.padEnd(maxNameLen);
  const ts = showTimestamps ? `{#666666-fg}[${new Date().toLocaleTimeString('en-GB')}]{/#666666-fg} ` : '';
  const highlighted = highlightSearch(line, searchTerm, escapeFn);
  return `${ts}{${colorTag}-fg}[${padded}]{/${colorTag}-fg} ${highlighted}`;
}

export function shouldLogLine(svcName: string, filter: string | null): boolean {
  return !filter || filter === svcName;
}

export function buildLogsLabel(filter: string | null, searchTerm: string | null, paused: boolean): string {
  const parts = [' {bold}Logs{/bold}'];
  if (filter) parts.push(`[${filter}]`);
  if (searchTerm) parts.push(`{yellow-fg}/${searchTerm}{/yellow-fg}`);
  if (paused) parts.push('{red-fg}[PAUSED]{/red-fg}');
  return parts.join(' ') + ' ';
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
