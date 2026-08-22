import type { ServiceConfig } from './types.js';

export interface ServiceDiff {
  added: ServiceConfig[];
  removed: string[];
  changed: Array<{ next: ServiceConfig; prev: ServiceConfig }>;
  unchanged: string[];
}

/** Fields whose change requires a respawn. Anything else (icon, etc.) is metadata. */
const SPAWN_RELEVANT: (keyof ServiceConfig)[] = [
  'cwd', 'cmd', 'args', 'port', 'phase', 'maxMem', 'preBuild', 'watchBuild',
  'nodeArgs', 'extraEnv', 'healthCheck', 'readyPattern', 'errorPattern', 'type', 'debug',
];

function hasSpawnRelevantChange(prev: ServiceConfig, next: ServiceConfig): boolean {
  for (const k of SPAWN_RELEVANT) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) return true;
  }
  return false;
}

/** Computes the set-difference between two service lists by name.
 *  - added:   in `next` but not in `prev`
 *  - removed: in `prev` but not in `next`
 *  - changed: in both but with a spawn-relevant field change
 *  - unchanged: in both with identical spawn-relevant fields */
export function diffServices(prev: ServiceConfig[], next: ServiceConfig[]): ServiceDiff {
  const prevByName = new Map(prev.map(s => [s.name, s]));
  const nextByName = new Map(next.map(s => [s.name, s]));

  const added: ServiceConfig[] = [];
  const removed: string[] = [];
  const changed: Array<{ next: ServiceConfig; prev: ServiceConfig }> = [];
  const unchanged: string[] = [];

  for (const [name, p] of prevByName) {
    if (!nextByName.has(name)) { removed.push(name); continue; }
    const n = nextByName.get(name)!;
    if (hasSpawnRelevantChange(p, n)) changed.push({ prev: p, next: n });
    else unchanged.push(name);
  }
  for (const [name, n] of nextByName) {
    if (!prevByName.has(name)) added.push(n);
  }
  return { added, removed, changed, unchanged };
}

/** Short human-readable summary for the TUI banner. */
export function summariseDiff(d: ServiceDiff): string {
  const parts: string[] = [];
  if (d.added.length)   parts.push(`+${d.added.length} added`);
  if (d.removed.length) parts.push(`-${d.removed.length} removed`);
  if (d.changed.length) parts.push(`~${d.changed.length} changed`);
  if (!parts.length)    parts.push('no changes');
  return parts.join(', ');
}
