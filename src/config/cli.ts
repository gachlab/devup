import type { DevStackConfig, ServiceConfig } from './types.js';

export interface CliArgs {
  configPath?: string;
  only?: string;
  skip: string[];
  services?: string[];
  profile?: string;
  lazy: boolean;
  lazyTimeout: number;
  proxy: boolean;
  proxyHost?: string;
  proxyConf?: string;
  proxyTls: boolean;
  proxyEntrypoint: string;
  dryRun: boolean;
  once: boolean;
  onceTimeout: number;
  logFile: boolean;
  logDir?: string;
}

const DEFAULT_LAZY_TIMEOUT = 10;
const DEFAULT_ONCE_TIMEOUT = 90;

export const USAGE = `devup — terminal UI dev stack runner

Usage: devup [options]

Service selection:
  --only apis | webs       Start only APIs or only webs
  --services a,b,c         Start only the named services
  --profile <name>         Start the services in a named profile (see ROADMAP)
  --skip a,b,c             Start everything except these
  --config <path>          Use a custom config file

Lazy mode:
  --lazy                   Enable lazy mode (default)
  --no-lazy                Start every service immediately
  --timeout <minutes>      Idle timeout for lazy services. Default: 10

Reverse proxy:
  --proxy                  Enable proxy config generation
  --proxy-host <host>      Override the target host (Docker/local)
  --proxy-conf <path>      Override the generated config file path
  --proxy-tls              Enable TLS in the generated config (default)
  --no-proxy-tls           Disable TLS
  --proxy-entrypoint <n>   Override entrypoint name (Traefik only)

CI / scripting:
  --dry-run                Print the resolved boot plan and exit
  --once                   Boot, wait for readiness, exit 0/1 (no TUI)
  --once-timeout <s>       Max seconds to wait in --once mode. Default: 90

Log files:
  --no-log-file            Disable persistent log files
  --log-dir <path>         Override log root (default: ~/.devup/logs)

Other:
  -h, --help               Show this help and exit
  -v, --version            Show version and exit

See https://github.com/gachlab/devup for the full documentation.`;

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    skip: [],
    lazy: true,
    lazyTimeout: DEFAULT_LAZY_TIMEOUT,
    proxy: false,
    proxyTls: true,
    proxyEntrypoint: 'websecure',
    dryRun: false,
    once: false,
    onceTimeout: DEFAULT_ONCE_TIMEOUT,
    logFile: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];

    switch (arg) {
      case '--config':     args.configPath = next; i++; break;
      case '--only':       args.only = next; i++; break;
      case '--skip':       args.skip = next?.split(',') ?? []; i++; break;
      case '--services':   args.services = next?.split(','); i++; break;
      case '--profile':    args.profile = next; i++; break;
      case '--lazy':       args.lazy = true; break;
      case '--no-lazy':    args.lazy = false; break;
      case '--timeout':    args.lazyTimeout = parseInt(next ?? '', 10) || DEFAULT_LAZY_TIMEOUT; i++; break;
      case '--proxy':      args.proxy = true; break;
      case '--proxy-host':       args.proxyHost = next; i++; break;
      case '--proxy-conf':       args.proxyConf = next; i++; break;
      case '--proxy-tls':        args.proxyTls = true; break;
      case '--no-proxy-tls':     args.proxyTls = false; break;
      case '--proxy-entrypoint': args.proxyEntrypoint = next ?? 'websecure'; i++; break;
      case '--dry-run':          args.dryRun = true; break;
      case '--once':             args.once = true; break;
      case '--once-timeout':     args.onceTimeout = parseInt(next ?? '', 10) || DEFAULT_ONCE_TIMEOUT; i++; break;
      case '--no-log-file':      args.logFile = false; break;
      case '--log-dir':          args.logDir = next; i++; break;
    }
  }

  return args;
}

export function filterServices(
  services: ServiceConfig[],
  args: CliArgs,
  config?: Pick<DevStackConfig, 'profiles'>,
): ServiceConfig[] {
  let result = services;

  if (args.profile) {
    const profileNames = config?.profiles?.[args.profile];
    if (!profileNames) {
      const available = Object.keys(config?.profiles ?? {});
      const hint = available.length ? `Available: ${available.join(', ')}` : 'No profiles defined in config.';
      throw new Error(`Unknown profile: "${args.profile}". ${hint}`);
    }
    const set = new Set(profileNames);
    result = result.filter(s => set.has(s.name));
  } else if (args.services) {
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
