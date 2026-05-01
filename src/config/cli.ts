import type { ServiceConfig } from './types.js';

export interface CliArgs {
  configPath?: string;
  only?: string;
  skip: string[];
  services?: string[];
  lazy: boolean;
  lazyTimeout: number;
  proxy: boolean;
  proxyHost?: string;
  proxyConf?: string;
  proxyTls: boolean;
  proxyEntrypoint: string;
}

const DEFAULT_LAZY_TIMEOUT = 10;

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    skip: [],
    lazy: true,
    lazyTimeout: DEFAULT_LAZY_TIMEOUT,
    proxy: false,
    proxyTls: true,
    proxyEntrypoint: 'websecure',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];

    switch (arg) {
      case '--config':     args.configPath = next; i++; break;
      case '--only':       args.only = next; i++; break;
      case '--skip':       args.skip = next?.split(',') ?? []; i++; break;
      case '--services':   args.services = next?.split(','); i++; break;
      case '--lazy':       args.lazy = true; break;
      case '--no-lazy':    args.lazy = false; break;
      case '--timeout':    args.lazyTimeout = parseInt(next ?? '', 10) || DEFAULT_LAZY_TIMEOUT; i++; break;
      case '--proxy':      args.proxy = true; break;
      case '--proxy-host':       args.proxyHost = next; i++; break;
      case '--proxy-conf':       args.proxyConf = next; i++; break;
      case '--proxy-tls':        args.proxyTls = true; break;
      case '--no-proxy-tls':     args.proxyTls = false; break;
      case '--proxy-entrypoint': args.proxyEntrypoint = next ?? 'websecure'; i++; break;
    }
  }

  return args;
}

export function filterServices(services: ServiceConfig[], args: CliArgs): ServiceConfig[] {
  let result = services;

  if (args.services) {
    const explicit = new Set(args.services);
    result = result.filter(s => explicit.has(s.name));
  } else if (args.only) {
    switch (args.only) {
      case 'apis': result = result.filter(s => s.type === 'api'); break;
      case 'webs': result = result.filter(s => s.type === 'web'); break;
      default:     result = result.filter(s => s.name.startsWith(args.only!)); break;
    }
  }

  if (args.skip.length) {
    const skipSet = new Set(args.skip);
    result = result.filter(s => !skipSet.has(s.name));
  }

  return result;
}
