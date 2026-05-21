import { existsSync, mkdirSync, renameSync, createWriteStream, type WriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface LogSinkOpts {
  /** Project name used as a subdirectory under the log root. */
  projectName: string;
  /** Root directory (default: ~/.devup/logs). */
  rootDir?: string;
  /** Rotate the previous run's file to <svc>.log.prev on first write. Default: true. */
  rotateOnStart?: boolean;
}

/** Persist service logs to disk, one file per service, append-only.
 *  On the first write for a service, rotates any previous <svc>.log to <svc>.log.prev. */
export class LogSink {
  private readonly dir: string;
  private readonly rotateOnStart: boolean;
  private readonly streams = new Map<string, WriteStream>();
  private readonly seen = new Set<string>();

  constructor(opts: LogSinkOpts) {
    const root = opts.rootDir ?? join(homedir(), '.devup', 'logs');
    this.dir = join(root, sanitize(opts.projectName));
    this.rotateOnStart = opts.rotateOnStart ?? true;
    mkdirSync(this.dir, { recursive: true });
  }

  /** Returns the file path for a service log (useful for tests / UI). */
  pathFor(svcName: string): string {
    return join(this.dir, `${sanitize(svcName)}.log`);
  }

  write(svcName: string, line: string): void {
    const stream = this.streamFor(svcName);
    stream.write(`${new Date().toISOString()} ${line}\n`);
  }

  async close(): Promise<void> {
    const closes = [...this.streams.values()].map(
      s => new Promise<void>(r => s.end(() => r())),
    );
    this.streams.clear();
    this.seen.clear();
    await Promise.all(closes);
  }

  private streamFor(svcName: string): WriteStream {
    let s = this.streams.get(svcName);
    if (s) return s;
    const file = this.pathFor(svcName);
    if (this.rotateOnStart && !this.seen.has(svcName) && existsSync(file)) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        renameSync(file, file + '.prev');
      } catch { /* best effort */ }
    }
    this.seen.add(svcName);
    s = createWriteStream(file, { flags: 'a' });
    s.on('error', () => { /* swallow — disk full / permission, etc. */ });
    this.streams.set(svcName, s);
    return s;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'devup';
}
