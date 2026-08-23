import type { DevStackConfig, ServiceConfig } from './types.js';

/** The flag is `--env`, **not** `--env-file`, and that is not a style choice.
 *
 *  Node claims `--env-file` for itself and takes it from *anywhere* in argv,
 *  script arguments included — so `devup --env-file .env.e2e` never reaches
 *  devup's parser at all. When the file exists node quietly loads it and moves
 *  on; when it does not, node exits with `node: .env.e2e: not found` before a
 *  line of devup runs, and devup's own message is unreachable. Verified on
 *  Node 26 with both `--env-file x` and `--env-file=x`.
 *
 *  Do not "fix" this back to the obvious name. */
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
  envFile?: string;
  onceJson: boolean;
  /** Name of a parallel instance — see `qualifyInstance`. */
  instance?: string;
  watchConfig: boolean;
  killPortConflicts: boolean;
}

const DEFAULT_LAZY_TIMEOUT = 10;
// 120, not 90: `--once` waits for web services too now, and a cold `ng serve`
// is the slowest thing in a typical stack by a wide margin.
const DEFAULT_ONCE_TIMEOUT = 120;

export const USAGE = `devup — terminal UI dev stack runner

Usage: devup [options]

Service selection:
  --only apis | webs       Start only APIs or only webs
  --services a,b,c         Start only the named services
  --profile <name>         Start the services in a named profile (see docs/profiles.md)
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
  --once                   Boot, wait for every service to be ready, exit 0/1
  --once-timeout <s>       Max seconds to wait in --once mode. Default: 120
  --json                   With --once, print a machine-readable summary
                           instead of progress lines

  devup exec -- <cmd>      Boot if needed, wait until ready, run <cmd>, and
                           stop only what this invocation started. See
                           "devup help exec".
  devup ctl wait [svc...]  Block until services are ready. See "devup help ctl".

Environment:
  --env <path>             Read this .env instead of config.envFile / .env.
                           For one run against a test database, without
                           editing a versioned config file. Must exist:
                           a mistyped path silently running against your
                           development database is not worth the convenience.
                           (Not --env-file: node takes that one itself)

Log files:
  --no-log-file            Disable persistent log files
  --log-dir <path>         Override log root (default: ~/.devup/logs)

Hot reload:
  --watch-config           Watch devup.config.* and apply add/remove/restart
                           service changes without exiting the TUI

Port conflicts:
  --kill-port-conflicts    Kill any processes already holding a configured
                           port before boot. Interactive prompt without it;
                           required for non-TTY (daemon, --once, CI)

Instances:
  --instance <name>        Run a second stack for this project alongside the
                           first: its own socket, pid file and logs, so an
                           e2e run does not disturb the one you work in.
                           Ports are NOT shifted, so two instances cannot
                           serve at once — devup says which one has them.
                           Pass it to every command that talks to it, after
                           the subcommand — which always comes first:
                           devup up -d --instance e2e
                           devup ctl status --instance e2e
                           devup down --instance e2e

Other:
  -h, --help               Show this help and exit
  -v, --version            Show version and exit

See https://github.com/gachlab/devup for the full documentation.`;

/** The value of `--flag value` or `--flag=value`, or `undefined` if the flag
 *  is absent.
 *
 *  Both spellings, because only handling the spaced one means `--wait-timeout=45`
 *  falls through to the default without a word — the exact silent fallback the
 *  strict parsing exists to prevent. An empty string is returned for a flag
 *  with no value, so the caller can reject it rather than read the next flag
 *  as the value. */
export function flagValue(argv: string[], flag: string): string | undefined {
  const eq = argv.find(a => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  const next = argv[idx + 1];
  return next === undefined || next.startsWith('-') ? '' : next;
}

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
    onceJson: false,
    watchConfig: false,
    killPortConflicts: false,
  };

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let next = argv[i + 1];
    // `--env=path`, because `--env-file=path` is the spelling node users have
    // in their fingers and the near-miss must not be swallowed. Only for the
    // flag where silence is dangerous; the rest keep the spaced form they have
    // always had.
    if (arg.startsWith('--env=')) { next = arg.slice('--env='.length); arg = '--env'; i--; }

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
      // Same shape as `--env`, and for a sharper reason: a bare
      // `--instance` — value forgotten, or eaten by an empty shell variable —
      // used to fall through to the default stack, so `devup down --instance`
      // stopped the daemon you were working in. index.ts rejects the empty
      // string.
      case '--instance': {
        const named = next !== undefined && !next.startsWith('-');
        args.instance = named ? next : '';
        if (named) i++;
        break;
      }
      // Empty string, not `undefined`, when there is no value: a bare `--env`
      // has to be distinguishable from no flag at all, or it falls back to
      // `.env` in silence — which for a per-run override pointing at a test
      // database means running the suite against the development one.
      // index.ts rejects the empty string.
      //
      // And a following *flag* is not a value: `--env --json` used to set the
      // path to "--json" and swallow the flag with it.
      case '--env': {
        const hasValue = next !== undefined && !next.startsWith('-');
        args.envFile = hasValue ? next : '';
        if (hasValue) i++;
        break;
      }
      case '--json':             args.onceJson = true; break;
      case '--watch-config':     args.watchConfig = true; break;
      case '--kill-port-conflicts': args.killPortConflicts = true; break;
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
