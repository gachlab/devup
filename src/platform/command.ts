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
  const resolved = findOnWindowsPath(cmd, env, opts.cwd ?? process.cwd(), opts.exists ?? existsSync);
  if (!resolved || !/^\.(cmd|bat)$/i.test(win32.extname(resolved))) return { file: cmd, args };

  const line = [escapeCommand(resolved), ...args.map(a => escapeArgument(a, true))].join(' ');
  return {
    file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

function findOnWindowsPath(
  cmd: string,
  env: Record<string, string | undefined>,
  cwd: string,
  exists: (path: string) => boolean,
): string | null {
  const pathExt = (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const exts = extname(cmd) ? [''] : pathExt;
  const hasDir = /[\\/]/.test(cmd);
  const dirs = hasDir
    ? [isAbsolute(cmd) || win32.isAbsolute(cmd) ? '' : cwd]
    : [cwd, ...(env.PATH ?? env.Path ?? '').split(';').filter(Boolean)];
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
