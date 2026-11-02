import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogSink } from '../../../src/process/log-sink.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'devup-logs-'));
}

describe('LogSink', () => {
  it('creates project subdirectory and writes per-service files', async () => {
    const root = freshDir();
    try {
      const sink = new LogSink({ projectName: 'MyApp', rootDir: root });
      sink.write('api', 'hello');
      sink.write('api', 'world');
      sink.write('web', 'starting');
      await sink.close();
      const apiFile = join(root, 'MyApp', 'api.log');
      const webFile = join(root, 'MyApp', 'web.log');
      assert.ok(existsSync(apiFile));
      assert.ok(existsSync(webFile));
      assert.ok(readFileSync(apiFile, 'utf8').includes('hello'));
      assert.ok(readFileSync(apiFile, 'utf8').includes('world'));
      assert.ok(readFileSync(webFile, 'utf8').includes('starting'));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('prefixes each line with an ISO timestamp', async () => {
    const root = freshDir();
    try {
      const sink = new LogSink({ projectName: 'P', rootDir: root });
      sink.write('a', 'line');
      await sink.close();
      const content = readFileSync(join(root, 'P', 'a.log'), 'utf8');
      assert.match(content, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('rotates previous run to <svc>.log.prev on first write', async () => {
    const root = freshDir();
    try {
      // Pre-existente
      const projDir = join(root, 'P');
      const file = join(projDir, 'api.log');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(file, 'old content\n');

      const sink = new LogSink({ projectName: 'P', rootDir: root });
      sink.write('api', 'new line');
      await sink.close();

      const prev = readFileSync(file + '.prev', 'utf8');
      const current = readFileSync(file, 'utf8');
      assert.equal(prev, 'old content\n');
      assert.ok(current.includes('new line'));
      assert.ok(!current.includes('old content'));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('sanitizes unsafe characters in project/service names', async () => {
    const root = freshDir();
    try {
      const sink = new LogSink({ projectName: 'My/Weird Name!', rootDir: root });
      sink.write('foo bar', 'x');
      await sink.close();
      assert.ok(existsSync(join(root, 'My_Weird_Name', 'foo_bar.log')));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it('exposes pathFor()', () => {
    const root = freshDir();
    try {
      const sink = new LogSink({ projectName: 'P', rootDir: root });
      assert.equal(sink.pathFor('api'), join(root, 'P', 'api.log'));
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe('LogSink: review of #141', () => {
  // POSIX only: Windows cannot rename over a `.prev` whose handle the previous
  // rotation is still flushing, so a burst rotates once and the rest stays in
  // `.log` — nothing is lost, but `.prev` is not the window this checks.
  it('rotation keeps the buffered lines and logs no write errors', { skip: process.platform === 'win32' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'devup-sink-'));
    const sink = new LogSink({ projectName: 'rot', rootDir: root, maxLogBytes: 2000 });
    for (let i = 0; i < 200; i++) sink.write('svc', `line ${i}`);
    await sink.close();
    const dir = join(root, 'rot');
    const cur = readFileSync(join(dir, 'svc.log'), 'utf8').trim().split('\n');
    const prev = readFileSync(join(dir, 'svc.log.prev'), 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(prev.length > 0, 'the burst crossing the limit vanished from .prev');
    assert.match(cur.at(-1)!, /line 199$/);
    // Contiguous: the last line of .prev is the one right before the first of .log.
    const n = (l: string) => Number(/line (\d+)$/.exec(l)![1]);
    assert.equal(n(prev.at(-1)!), n(cur[0]!) - 1);
    assert.equal(existsSync(join(dir, 'devup.log')), false, 'write errors were logged');
  });

  it('a write after close() is dropped, not a reopen that rotates the session away', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devup-sink-'));
    const sink = new LogSink({ projectName: 'late', rootDir: root });
    sink.write('ext:db', 'session line');
    await sink.close();
    sink.write('ext:db', 'late line');
    await new Promise(r => setTimeout(r, 50));
    const dir = join(root, 'late');
    assert.match(readFileSync(join(dir, 'ext_db.log'), 'utf8'), /session line/);
    assert.equal(existsSync(join(dir, 'ext_db.log.prev')), false);
  });
});

describe('LogSink: a write that fails while closing', () => {
  // The failing path is a dangling symlink, which needs a privilege on Windows.
  it('is not reported into a reopened devup.log, which would rotate the session away', { skip: process.platform === 'win32' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'devup-sink-'));
    const sink = new LogSink({ projectName: 'p', rootDir: root });
    sink.write('devup', 'session line');
    const dir = join(root, 'p');
    // A log path that cannot be opened: its write fails asynchronously.
    symlinkSync('/nonexistent-devup-dir/x', join(dir, 'bad.log'));
    sink.write('bad', 'hello');
    await sink.close();
    await new Promise(r => setTimeout(r, 200));
    assert.match(readFileSync(join(dir, 'devup.log'), 'utf8'), /session line/);
    assert.equal(existsSync(join(dir, 'devup.log.prev')), false);
  });
});
