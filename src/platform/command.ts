import { existsSync } from 'node:fs';
import { extname, isAbsolute, join, resolve, win32 } from 'node:path';

export interface SpawnCommand {
  file: string;
  args: string[];
  /** Set when `args` is already a quoted cmd.exe command line. */
  windowsVerbatimArguments?: boolean;
}

// cmd.exe metacharacters, escaped with `^`. Same set cross-spawn uses.
const META = /([()\][%!^"`<>&|;, *?])/g;

/** A shell command line (`preBuild`, `watchBuild`, an external's `cmd`): `sh -c`
 *  on POSIX, `%ComSpec% /d /c` on Windows — the same interpreter
 *  `resolveSpawnCommand` uses, so a custom ComSpec applies to every path. */
export function shellCommand(
  script: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): SpawnCommand {
  if (platform !== 'win32') return { file: 'sh', args: ['-c', script] };
  return { file: comSpec(env), args: ['/d', '/c', script] };
}

function comSpec(env: Record<string, string | undefined>): string {
  return env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
}

/** How to spawn `cmd` with `args` on this platform.
 *
 *  On POSIX it is the identity. On Windows, `npm`, `npx`, `pnpm` and most of
 *  what a monorepo puts in `cmd` are `.cmd` shims, not executables, and Node
 *  refuses to run those without a shell since 18.20.2 / 20.12.2
 *  (CVE-2024-27980): `spawn('npm.cmd')` throws EINVAL and `spawn('npx')` fails
 *  with ENOENT. So a shim found on PATH goes through `cmd.exe /d /s /c` with
 *  its arguments quoted — and escaped **twice**, because a batch file expands
 *  `%` and `^` once more when it re-parses `%*`. Anything else, including a
 *  command that cannot be found, is spawned directly so a missing binary
 *  still surfaces as the ENOENT the caller reports. */
export function resolveSpawnCommand(
  cmd: string,
  args: string[],
  opts: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    cwd?: string;
    exists?: (path: string) => boolean;
  } = {},
): SpawnCommand {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { file: cmd, args };

  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const resolved = opts.exists
    ? findOnWindowsPath(cmd, env, cwd, opts.exists)
    : cachedLookup(cmd, env, cwd);
  if (!resolved || !/^\.(cmd|bat)$/i.test(win32.extname(resolved))) return { file: cmd, args };

  const line = [escapeCommand(resolved), ...args.map(a => escapeArgument(a, true))].join(' ');
  return {
    file: comSpec(env),
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

// One lookup per (cmd, cwd, PATH, PATHEXT): it is |PATH| × |PATHEXT| blocking
// stats, and a 30-service boot would repeat it for every spawn and restart. Only
// hits are kept, so a binary installed mid-session is still found.
const lookupCache = new Map<string, string>();
function cachedLookup(cmd: string, env: Record<string, string | undefined>, cwd: string): string | null {
  const key = [cmd, cwd, pathOf(env), pathExtOf(env)].join('\0');
  const hit = lookupCache.get(key);
  if (hit) return hit;
  const found = findOnWindowsPath(cmd, env, cwd, existsSync);
  if (found) lookupCache.set(key, found);
  return found;
}

const pathOf = (env: Record<string, string | undefined>) => env.PATH ?? env.Path ?? env.path ?? '';
const pathExtOf = (env: Record<string, string | undefined>) => env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD';

function findOnWindowsPath(
  cmd: string,
  env: Record<string, string | undefined>,
  cwd: string,
  exists: (path: string) => boolean,
): string | null {
  const pathExt = pathExtOf(env).split(';').filter(Boolean);
  // Only an extension Windows would run counts: `my.tool` still means
  // `my.tool.cmd`. And never the bare name — Node's own install puts an
  // extensionless `npm` (a sh script) right next to `npm.cmd`.
  const ext = extname(cmd).toLowerCase();
  const exts = ext && pathExt.some(e => e.toLowerCase() === ext) ? [''] : pathExt;
  const hasDir = /[\\/]/.test(cmd);
  const dirs = hasDir
    ? [isAbsolute(cmd) || win32.isAbsolute(cmd) ? '' : cwd]
    // Entries may be quoted (`"C:\Program Files\nodejs"`) — cmd.exe accepts that.
    : [cwd, ...pathOf(env).split(';').map(d => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? join(dir, cmd + ext) : resolve(cmd + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function escapeCommand(cmd: string): string {
  return cmd.replace(META, '^$1');
}

/** Quote for CommandLineToArgvW, then escape for cmd.exe. Mirrors cross-spawn. */
export function escapeArgument(arg: string, doubleEscape: boolean): string {
  let out = arg
    // Double the backslashes that precede a quote, then escape the quote.
    .replace(/(\\*)"/g, '$1$1\\"')
    // Double trailing backslashes: the closing quote added below follows them.
    .replace(/(\\*)$/, '$1$1');
  out = `"${out}"`.replace(META, '^$1');
  if (doubleEscape) out = out.replace(META, '^$1');
  return out;
}
