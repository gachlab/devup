import type { ServiceConfig } from '../config/types.js';

/** Groups a flat list of services by their `phase` field. */
export function groupByPhase(services: ServiceConfig[]): Record<number, ServiceConfig[]> {
  const phases: Record<number, ServiceConfig[]> = {};
  for (const s of services) {
    (phases[s.phase] ??= []).push(s);
  }
  return phases;
}
