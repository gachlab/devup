import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LAZY_PORT_OFFSET, type DevStackConfig } from './types.js';

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
}

/** Collects non-blocking warnings: things that look suspicious but don't justify
 *  refusing to start the stack. Run alongside `validateConfig` from the CLI entry
 *  point; print them and continue. */
export function collectWarnings(config: DevStackConfig): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  if (!config.services?.length) return warnings;

  for (const svc of config.services) {
    // extraEnv.PORT vs svc.port: catches the common "I set PORT in extraEnv to
    // something other than port and now nothing connects" footgun.
    const ep = svc.extraEnv?.['PORT'];
    if (ep !== undefined) {
      const expected = String(svc.port);
      if (ep !== expected) {
        warnings.push({
          field: `services[${svc.name}].extraEnv.PORT`,
          message: `extraEnv.PORT="${ep}" does not match port=${svc.port}. devup will health-check :${svc.port} but the service will probably bind to :${ep}.`,
        });
      }
    }
  }
  // An environment that can only reach part of the stack. Not an error — a
  // stack may deliberately proxy two services and run the rest — but the
  // failure mode when it is *not* deliberate is a service that is neither
  // started nor proxied, and nothing else says so until a request fails.
  for (const [envName, env] of Object.entries(config.environments ?? {})) {
    if (!env.domain) continue;
    const unreachable = config.services
      .filter(s => config.proxy?.routes?.[s.name] === undefined && env.targets?.[s.name] === undefined)
      .map(s => s.name);
    if (unreachable.length) {
      warnings.push({
        field: `environments.${envName}`,
        message: `no target for ${unreachable.join(', ')} — absent from proxy.routes and from targets. Under --remote ${envName} these stay down.`,
      });
    }
  }

  return warnings;
}

export function formatValidationWarnings(warnings: ValidationWarning[]): string {
  return warnings.map(w => `  ⚠ ${w.field}: ${w.message}`).join('\n');
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
    if (svc.debug !== undefined) {
      const d = svc.debug as unknown;
      const validPort = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 65535;
      // The object form: { port?, brk? }. A bad value here reaches
      // `--inspect=<n>`, node refuses to start, and the flag sticks to the
      // service so every later restart fails the same way.
      //
      // A plain object specifically: `[]`, `new Date()` and friends have no
      // own keys, so an `every()` over them is vacuously true and `debug: []`
      // would sail through into `--inspect=0`.
      const plainObject = !!d && typeof d === 'object' && !Array.isArray(d)
        && (Object.getPrototypeOf(d) === Object.prototype || Object.getPrototypeOf(d) === null);
      const validObject = plainObject
        && Object.keys(d as object).every(k => k === 'port' || k === 'brk')
        // 0 is the long form of "let the OS pick", the same value an omitted
        // port normalises to.
        && ((d as { port?: unknown }).port === undefined || (d as { port?: unknown }).port === 0 || validPort((d as { port?: unknown }).port))
        && ((d as { brk?: unknown }).brk === undefined || typeof (d as { brk?: unknown }).brk === 'boolean');
      if (typeof d !== 'boolean' && !validPort(d) && !validObject) {
        // `JSON.stringify` shows an object usefully but turns NaN into "null"
        // and a function into `undefined`; `String` is the opposite. Each for
        // what it is good at, so the message names the value someone has to
        // find in their config.
        const shown = typeof d === 'object' && d !== null ? (JSON.stringify(d) ?? String(d)) : String(d);
        errors.push({ field: `services[${svc.name}].debug`, message: `Invalid debug: ${shown} (must be true, false, a port, or { port?, brk? })` });
      } else if (d !== false && svc.cmd !== 'node') {
        // The inspector flag only means anything to node; silently ignoring it
        // would leave the user waiting for a debugger that never listens.
        errors.push({ field: `services[${svc.name}].debug`, message: `debug is set but cmd is "${svc.cmd}" — the Node inspector only applies to node` });
      }
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

    // errorPattern (same regex grammar as readyPattern)
    if (svc.errorPattern !== undefined) {
      if (typeof svc.errorPattern !== 'string' || !svc.errorPattern.length) {
        errors.push({ field: `services[${svc.name}].errorPattern`, message: `errorPattern must be a non-empty string` });
      } else {
        const slashed = /^\/(.+)\/([gimsuy]*)$/.exec(svc.errorPattern);
        try {
          if (slashed) new RegExp(slashed[1]!, slashed[2] || 'i');
          else new RegExp(svc.errorPattern, 'i');
        } catch (e: any) {
          errors.push({ field: `services[${svc.name}].errorPattern`, message: `Invalid regex: ${e.message}` });
        }
      }
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
      if (hc.startPeriod !== undefined && (typeof hc.startPeriod !== 'number' || hc.startPeriod < 0)) {
        errors.push({ field: `services[${svc.name}].healthCheck.startPeriod`, message: `startPeriod must be a non-negative number (seconds), got ${hc.startPeriod}` });
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

  // External services
  if (config.external) {
    const extNames = new Set<string>();
    for (const ext of config.external) {
      if (!ext.name?.trim()) {
        errors.push({ field: 'external[].name', message: 'External service name is required' });
        continue;
      }
      if (extNames.has(ext.name)) {
        errors.push({ field: `external[${ext.name}].name`, message: `Duplicate external name: ${ext.name}` });
      }
      extNames.add(ext.name);
      if (!ext.cmd?.trim()) {
        errors.push({ field: `external[${ext.name}].cmd`, message: 'cmd is required' });
      }
      if (ext.healthCheck) {
        const hc = ext.healthCheck;
        if (hc.type !== 'tcp' && hc.type !== 'http') {
          errors.push({ field: `external[${ext.name}].healthCheck.type`, message: `Invalid healthCheck.type: ${hc.type}` });
        }
        if ((hc.type === 'tcp' || hc.type === 'http') && (typeof ext.port !== 'number' || ext.port <= 0)) {
          errors.push({ field: `external[${ext.name}].port`, message: `port is required when healthCheck is set (got ${ext.port})` });
        }
        if (hc.type === 'http' && hc.path && !hc.path.startsWith('/')) {
          errors.push({ field: `external[${ext.name}].healthCheck.path`, message: `must start with "/"` });
        }
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

  // Environments
  if (config.environments) {
    for (const [envName, env] of Object.entries(config.environments)) {
      if (!env.domain && !Object.keys(env.targets ?? {}).length) {
        errors.push({
          field: `environments.${envName}`,
          message: 'needs `domain` (resolved through proxy.routes) or `targets`',
        });
      }
      for (const ref of Object.keys(env.targets ?? {})) {
        if (!names.has(ref)) {
          errors.push({ field: `environments.${envName}.targets`, message: `Unknown service: ${ref}` });
          continue;
        }
        const value = env.targets![ref]!;
        if (!isAbsoluteHttpUrl(value)) {
          errors.push({
            field: `environments.${envName}.targets.${ref}`,
            message: `must be an absolute http(s) URL, got "${value}"`,
          });
        }
      }
      if (env.origin !== undefined && !isAbsoluteHttpUrl(env.origin)) {
        errors.push({
          field: `environments.${envName}.origin`,
          message: `must be an absolute http(s) URL (scheme included), got "${env.origin}"`,
        });
      }
      if (env.healthCheck?.path !== undefined && !env.healthCheck.path.startsWith('/')) {
        errors.push({ field: `environments.${envName}.healthCheck.path`, message: 'must start with "/"' });
      }
    }
  }

  return errors;
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map(e => `  ✗ ${e.field}: ${e.message}`).join('\n');
}
