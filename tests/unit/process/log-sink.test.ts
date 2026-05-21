import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
