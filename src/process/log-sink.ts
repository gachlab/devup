import { existsSync, mkdirSync, renameSync, createWriteStream, statSync, type WriteStream } from 'node:fs';
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
    const closes = [...this.streams.values()].map(s => new Promise<void>(r => s.end(() => r())));
    this.streams.clear();
    this.seen.clear();
    this.bytesWritten.clear();
    await Promise.all(closes);
  }

  private rotateFile(svcName: string): void {
    const existing = this.streams.get(svcName);
    if (existing) { existing.destroy(); this.streams.delete(svcName); }
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
    s = createWriteStream(file, { flags: 'a' });
    s.on('error', () => { /* handled in write() callback */ });
    this.streams.set(svcName, s);
    return s;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'devup';
}
