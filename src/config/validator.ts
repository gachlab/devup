import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DevStackConfig } from './types.js';

export interface ValidationError {
  field: string;
  message: string;
}

export function validateConfig(config: DevStackConfig, cwd: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!config.name?.trim()) {
    errors.push({ field: 'name', message: 'Project name is required' });
  }

  if (!config.services?.length) {
    errors.push({ field: 'services', message: 'At least one service is required' });
    return errors;
  }

  // Unique names
  const names = new Set<string>();
  for (const svc of config.services) {
    if (names.has(svc.name)) {
      errors.push({ field: `services[${svc.name}].name`, message: `Duplicate service name: ${svc.name}` });
    }
    names.add(svc.name);
  }

  // Unique ports
  const ports = new Map<number, string>();
  for (const svc of config.services) {
    const existing = ports.get(svc.port);
    if (existing) {
      errors.push({ field: `services[${svc.name}].port`, message: `Port ${svc.port} already used by ${existing}` });
    }
    ports.set(svc.port, svc.name);
  }

  // Valid fields per service
  for (const svc of config.services) {
    if (!svc.name?.trim()) errors.push({ field: 'services[].name', message: 'Service name is required' });
    if (!svc.cwd?.trim()) errors.push({ field: `services[${svc.name}].cwd`, message: 'cwd is required' });
    if (!svc.cmd?.trim()) errors.push({ field: `services[${svc.name}].cmd`, message: 'cmd is required' });
    if (!svc.type || !['api', 'web'].includes(svc.type)) {
      errors.push({ field: `services[${svc.name}].type`, message: `Invalid type: ${svc.type} (must be "api" or "web")` });
    }
    if (typeof svc.port !== 'number' || svc.port <= 0) {
      errors.push({ field: `services[${svc.name}].port`, message: `Invalid port: ${svc.port}` });
    }
    if (typeof svc.phase !== 'number' || svc.phase < 0) {
      errors.push({ field: `services[${svc.name}].phase`, message: `Invalid phase: ${svc.phase}` });
    }

    // cwd exists
    if (svc.cwd && !existsSync(resolve(cwd, svc.cwd))) {
      errors.push({ field: `services[${svc.name}].cwd`, message: `Directory not found: ${svc.cwd}` });
    }
  }

  // Lazy refs
  if (config.lazy?.alwaysOn) {
    for (const ref of config.lazy.alwaysOn) {
      if (!names.has(ref)) {
        errors.push({ field: `lazy.alwaysOn`, message: `Unknown service: ${ref}` });
      }
    }
  }

  // Proxy route refs
  if (config.proxy?.routes) {
    for (const ref of Object.keys(config.proxy.routes)) {
      if (!names.has(ref)) {
        errors.push({ field: `proxy.routes`, message: `Unknown service: ${ref}` });
      }
    }
  }

  return errors;
}

export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map(e => `  ✗ ${e.field}: ${e.message}`).join('\n');
}
