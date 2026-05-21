import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DevStackConfig } from './types.js';
import { LAZY_PORT_OFFSET } from '../lazy/classifier.js';

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

    // readyPattern
    if (svc.readyPattern !== undefined) {
      if (typeof svc.readyPattern !== 'string' || !svc.readyPattern.length) {
        errors.push({ field: `services[${svc.name}].readyPattern`, message: `readyPattern must be a non-empty string` });
      } else {
        const slashed = /^\/(.+)\/([gimsuy]*)$/.exec(svc.readyPattern);
        try {
          if (slashed) new RegExp(slashed[1]!, slashed[2] || 'i');
          else new RegExp(svc.readyPattern, 'i');
        } catch (e: any) {
          errors.push({ field: `services[${svc.name}].readyPattern`, message: `Invalid regex: ${e.message}` });
        }
      }
    }

    // preBuild / watchBuild
    if (svc.preBuild !== undefined && (typeof svc.preBuild !== 'string' || !svc.preBuild.trim())) {
      errors.push({ field: `services[${svc.name}].preBuild`, message: `preBuild must be a non-empty string` });
    }
    if (svc.watchBuild !== undefined && (typeof svc.watchBuild !== 'string' || !svc.watchBuild.trim())) {
      errors.push({ field: `services[${svc.name}].watchBuild`, message: `watchBuild must be a non-empty string` });
    }

    // healthCheck
    if (svc.healthCheck) {
      const hc = svc.healthCheck;
      if (hc.type !== 'tcp' && hc.type !== 'http') {
        errors.push({ field: `services[${svc.name}].healthCheck.type`, message: `Invalid healthCheck.type: ${hc.type} (must be "tcp" or "http")` });
      }
      if (hc.type === 'http' && hc.path && !hc.path.startsWith('/')) {
        errors.push({ field: `services[${svc.name}].healthCheck.path`, message: `healthCheck.path must start with "/": got "${hc.path}"` });
      }
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

  // Lazy port collisions: in lazy mode each non-always-on service also listens on port + LAZY_PORT_OFFSET
  if (config.lazy) {
    const alwaysOn = new Set(config.lazy.alwaysOn ?? []);
    const portToSvc = new Map<number, string>();
    for (const svc of config.services) portToSvc.set(svc.port, svc.name);
    for (const svc of config.services) {
      if (alwaysOn.has(svc.name)) continue;
      const realPort = svc.port + LAZY_PORT_OFFSET;
      const conflict = portToSvc.get(realPort);
      if (conflict && conflict !== svc.name) {
        errors.push({
          field: `services[${svc.name}].port`,
          message: `Lazy real port ${realPort} (= ${svc.port}+${LAZY_PORT_OFFSET}) collides with service ${conflict}`,
        });
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

  // Profiles
  if (config.profiles) {
    for (const [profile, svcNames] of Object.entries(config.profiles)) {
      if (!Array.isArray(svcNames) || !svcNames.length) {
        errors.push({ field: `profiles.${profile}`, message: `Profile "${profile}" must be a non-empty array of service names` });
        continue;
      }
      for (const ref of svcNames) {
        if (!names.has(ref)) {
          errors.push({ field: `profiles.${profile}`, message: `Unknown service: ${ref}` });
        }
      }
    }
  }

  return errors;
}

export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map(e => `  ✗ ${e.field}: ${e.message}`).join('\n');
}
