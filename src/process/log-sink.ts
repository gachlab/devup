import { existsSync, mkdirSync, openSync, renameSync, createWriteStream, statSync, type WriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB

export interface LogSinkOpts {
  projectName: string;
  rootDir?: string;
  rotateOnStart?: boolean;
  /** Max log file size in bytes before rotating. Default: 10 MB. */
  maxLogBytes?: number;
}

export class LogSink {
  private readonly dir: string;
  private readonly rotateOnStart: boolean;
  private readonly maxLogBytes: number;
  private readonly streams = new Map<string, WriteStream>();
  private readonly seen = new Set<string>();
  private readonly bytesWritten = new Map<string, number>();
  /** Set by `close()`. A late line — an external still printing after its
   *  SIGTERM — used to reopen the file: with `seen` already cleared it was
   *  rotated as if new, moving the whole session's log to `.prev`, and the
   *  next boot rotated the one-line file over it. */
  private closed = false;

  constructor(opts: LogSinkOpts) {
    const root = opts.rootDir ?? join(homedir(), '.devup', 'logs');
    this.dir = join(root, sanitize(opts.projectName));
    this.rotateOnStart = opts.rotateOnStart ?? true;
    this.maxLogBytes = opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    mkdirSync(this.dir, { recursive: true });
  }

  pathFor(svcName: string): string {
    return join(this.dir, `${sanitize(svcName)}.log`);
  }

  write(svcName: string, line: string): void {
    if (this.closed) return;
    const entry = `${new Date().toISOString()} ${line}\n`;
    const bytes = Buffer.byteLength(entry, 'utf8');
    const current = this.bytesWritten.get(svcName) ?? this.estimateCurrentSize(svcName);

    if (current + bytes > this.maxLogBytes) {
      this.rotateFile(svcName);
    }

    const stream = this.streamFor(svcName);
    stream.write(entry, err => {
      if (err && svcName !== 'devup') {
        // Surface write errors (disk full, permissions) without infinite recursion.
        this.streamFor('devup').write(
          `${new Date().toISOString()} ⚠ log write error for "${svcName}": ${err.message}\n`,
        );
      }
    });
    this.bytesWritten.set(svcName, (this.bytesWritten.get(svcName) ?? 0) + bytes);
  }

  async close(): Promise<void> {
    this.closed = true;
    const closes = [...this.streams.values()].map(s => new Promise<void>(r => s.end(() => r())));
    this.streams.clear();
    this.seen.clear();
    this.bytesWritten.clear();
    await Promise.all(closes);
  }

  private rotateFile(svcName: string): void {
    // `end()`, not `destroy()`: destroy drops whatever is still buffered, and
    // a burst that crosses the size limit is exactly when there is a lot of
    // it — it vanished from both files, and every dropped write logged its own
    // "write after a stream was destroyed" error. The buffered lines still go
    // to the old descriptor, which is the file being renamed to `.prev`.
    const existing = this.streams.get(svcName);
    if (existing) { existing.end(); this.streams.delete(svcName); }
    const file = this.pathFor(svcName);
    if (existsSync(file)) {
      try { renameSync(file, file + '.prev'); } catch { /* best effort */ }
    }
    this.bytesWritten.set(svcName, 0);
  }

  private estimateCurrentSize(svcName: string): number {
    try { return statSync(this.pathFor(svcName)).size; } catch { return 0; }
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
    // Opened here, synchronously, rather than by the stream later: rotation
    // renames the file on the next write, and a stream that has not opened it
    // yet left nothing to rename — every rotation of a burst then reopened the
    // same path and `.prev` was never written. With the descriptor in hand,
    // what is still buffered follows the file to `.prev`.
    let fd: number | undefined;
    try { fd = openSync(file, 'a'); } catch { /* the stream reports it */ }
    s = fd === undefined ? createWriteStream(file, { flags: 'a' }) : createWriteStream(file, { fd, flags: 'a' });
    s.on('error', () => { /* handled in write() callback */ });
    this.streams.set(svcName, s);
    return s;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'devup';
}
