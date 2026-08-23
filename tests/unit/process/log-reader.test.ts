import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLogWindow, lineTimestamp, parseSince } from '../../../src/process/log-reader.js';

const T0 = Date.parse('2026-08-23T12:00:00.000Z');
/** A line as LogSink writes it: ISO timestamp, a space, then the text. */
const at = (offsetMs: number, text: string) => `${new Date(T0 + offsetMs).toISOString()} ${text}`;

function withLog(
  files: Record<string, string[]>,
  fn: (file: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'devup-logrd-'));
  const file = join(dir, 'api.log');
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(dir, name), lines.length ? lines.join('\n') + '\n' : '');
  }
  return fn(file).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('lineTimestamp', () => {
  it('reads the prefix LogSink writes', () => {
    assert.equal(lineTimestamp(at(0, '[api] listening')), T0);
  });

  it('returns null for a line with no timestamp of its own', () => {
    assert.equal(lineTimestamp('    at Server.setupListenHandle'), null);
    assert.equal(lineTimestamp(''), null);
  });

  it('does not accept a timestamp-shaped string that is not one', () => {
    assert.equal(lineTimestamp('2026-13-45T99:99:99.999Z nope'), null);
  });

  it('does not let a line that merely starts with a number be dated', () => {
    // `Date.parse('2026')` is a valid date — 2026-01-01 — so a loose prefix
    // match would read `2026 units processed` as a timestamp and file the line
    // seven months before it was written. Only LogSink's exact shape counts.
    assert.equal(lineTimestamp('2026 units processed'), null);
    assert.equal(lineTimestamp('2026-08 partial'), null);
    assert.equal(lineTimestamp('2026-08-23 no time part'), null);
    assert.equal(lineTimestamp('2026-08-23T12:00:00Z missing millis'), null);
    // And the real thing still is.
    assert.equal(lineTimestamp(at(0, 'real')), T0);
  });
});

describe('readLogWindow', () => {
  it('tails the last N lines when no window is asked for', async () => {
    await withLog({ 'api.log': [at(0, 'a'), at(1, 'b'), at(2, 'c')] }, async file => {
      const res = await readLogWindow(file, { lines: 2 });
      assert.deepEqual(res.lines, [at(1, 'b'), at(2, 'c')]);
    });
  });

  it('returns nothing, not an error, when the service has never written', async () => {
    await withLog({}, async file => {
      const res = await readLogWindow(file, { lines: 100 });
      assert.deepEqual(res.lines, []);
      assert.equal(res.oldestRetained, null);
    });
  });

  it('keeps only what was written at or after `since`', async () => {
    await withLog({ 'api.log': [at(0, 'before'), at(5_000, 'boundary'), at(9_000, 'after')] }, async file => {
      const res = await readLogWindow(file, { lines: 100, since: T0 + 5_000 });
      assert.deepEqual(res.lines, [at(5_000, 'boundary'), at(9_000, 'after')]);
    });
  });

  it('keeps a stack trace attached to the line that dates it', async () => {
    // The log holds whatever a service printed. A continuation line carries no
    // timestamp of its own, and cutting it away from its header would hand
    // back an error with no stack — the half that matters.
    await withLog({
      'api.log': [
        at(0, 'old'),
        at(9_000, 'Error: boom'),
        '    at handler (app.js:12)',
        '    at Server.emit',
      ],
    }, async file => {
      const res = await readLogWindow(file, { lines: 100, since: T0 + 5_000 });
      assert.deepEqual(res.lines, [at(9_000, 'Error: boom'), '    at handler (app.js:12)', '    at Server.emit']);
    });
  });

  it('drops an undated line that precedes every dated one', async () => {
    // It cannot be placed in time, and keeping it would put the head of an old
    // file inside a window it may well predate.
    await withLog({ 'api.log': ['orphan with no timestamp', at(9_000, 'real')] }, async file => {
      const res = await readLogWindow(file, { lines: 100, since: T0 + 5_000 });
      assert.deepEqual(res.lines, [at(9_000, 'real')]);
    });
  });

  it('reads across a rotation, so a window that spans one stays whole', async () => {
    // The file rotates on every launch and at 10 MB. Without the .prev the
    // window silently starts wherever the current file happens to begin.
    await withLog({
      'api.log.prev': [at(0, 'older'), at(6_000, 'just before the rotation')],
      'api.log': [at(7_000, 'just after'), at(8_000, 'newest')],
    }, async file => {
      const res = await readLogWindow(file, { lines: 100, since: T0 + 5_000 });
      assert.deepEqual(res.lines, [at(6_000, 'just before the rotation'), at(7_000, 'just after'), at(8_000, 'newest')]);
    });
  });

  it('does not drag in the rotated file for a plain tail', async () => {
    // "the last N lines" has always meant the current file, and a tail that
    // silently reached back a launch would change what `devup ctl logs` shows.
    await withLog({
      'api.log.prev': [at(0, 'previous run')],
      'api.log': [at(7_000, 'this run')],
    }, async file => {
      const res = await readLogWindow(file, { lines: 100 });
      assert.deepEqual(res.lines, [at(7_000, 'this run')]);
    });
  });

  it('reports the oldest line it still holds, so a caller can see what was rotated away', async () => {
    await withLog({
      'api.log.prev': [at(1_000, 'oldest surviving')],
      'api.log': [at(7_000, 'current')],
    }, async file => {
      const res = await readLogWindow(file, { lines: 100, since: T0 });
      assert.equal(res.oldestRetained, T0 + 1_000);
      // Asked for T0, oldest is later → the start of the window is gone.
      assert.ok(res.oldestRetained! > T0);
    });
  });

  it('does not answer "the oldest devup holds" from a partial view', async () => {
    // A plain tail only opens the current file, so it cannot say what the
    // oldest line on disk is — and a client comparing a half-answer with a
    // timestamp would conclude data was lost that devup still has.
    await withLog({
      'api.log.prev': [at(0, 'older')],
      'api.log': [at(7_000, 'current')],
    }, async file => {
      assert.equal((await readLogWindow(file, { lines: 100 })).oldestRetained, null);
      assert.equal((await readLogWindow(file, { lines: 100, since: T0 })).oldestRetained, T0);
    });
  });

  it('takes the most recent N across both files, not N from each', async () => {
    await withLog({
      'api.log.prev': [at(1, 'p1'), at(2, 'p2')],
      'api.log': [at(3, 'c1'), at(4, 'c2')],
    }, async file => {
      const res = await readLogWindow(file, { lines: 3, since: T0 });
      assert.deepEqual(res.lines, [at(2, 'p2'), at(3, 'c1'), at(4, 'c2')]);
    });
  });

  it('caps the window at `lines`, keeping the most recent', async () => {
    await withLog({ 'api.log': [at(1, 'a'), at(2, 'b'), at(3, 'c'), at(4, 'd')] }, async file => {
      const res = await readLogWindow(file, { lines: 2, since: T0 });
      assert.deepEqual(res.lines, [at(3, 'c'), at(4, 'd')]);
    });
  });
});

describe('readLogWindow truncation', () => {
  it('says when the window lost its beginning to the cap', async () => {
    // The cap keeps the most recent, so what a window loses is its *head* —
    // and `oldestRetained` cannot show it: for a service that started before
    // the window it reads as "complete" either way.
    await withLog({ 'api.log': [at(1, 'a'), at(2, 'b'), at(3, 'c'), at(4, 'd')] }, async file => {
      const res = await readLogWindow(file, { lines: 2, since: T0 });
      assert.equal(res.truncated, true);
      assert.deepEqual(res.lines, [at(3, 'c'), at(4, 'd')]);
      // And the field that cannot see it still says the log is complete.
      assert.ok(res.oldestRetained! <= T0 + 1);
    });
  });

  it('says nothing was dropped when nothing was', async () => {
    await withLog({ 'api.log': [at(1, 'a'), at(2, 'b')] }, async file => {
      assert.equal((await readLogWindow(file, { lines: 2, since: T0 })).truncated, false);
      assert.equal((await readLogWindow(file, { lines: 100 })).truncated, false);
    });
  });

  it('does not open the rotated file when the current one already covers the window', async () => {
    // Every `--since 5s` scanning a 10 MB rotated file for nothing is a real
    // cost, and it is also what keeps the rotation race rare.
    await withLog({
      // If this were read, its line would appear.
      'api.log.prev': [at(-9_000, 'should not be read')],
      'api.log': [at(0, 'covers the window already')],
    }, async file => {
      const res = await readLogWindow(file, { lines: 100, since: T0 + 1_000 });
      assert.deepEqual(res.lines, []);
      assert.equal(res.oldestRetained, T0, 'from the current file, without opening .prev');
    });
  });

  it('does not double a file that was rotated between the two reads', async () => {
    // Reading current-then-prev means a rotation in between makes us read the
    // same file twice. That is the right trade — the other order loses it —
    // but the seam has to be trimmed.
    const shared = [at(6_000, 'x'), at(6_500, 'y')];
    await withLog({ 'api.log.prev': shared, 'api.log': shared }, async file => {
      const res = await readLogWindow(file, { lines: 100, since: T0 + 5_000 });
      assert.deepEqual(res.lines, shared, 'each line once, in order');
    });
  });
});

describe('parseSince', () => {
  const now = Date.parse('2026-08-23T12:00:00.000Z');

  it('reads durations', () => {
    assert.equal(parseSince('30s', now), now - 30_000);
    assert.equal(parseSince('5m', now), now - 300_000);
    assert.equal(parseSince('2h', now), now - 7_200_000);
    assert.equal(parseSince('1d', now), now - 86_400_000);
    assert.equal(parseSince('500ms', now), now - 500);
  });

  it('reads an ISO timestamp', () => {
    assert.equal(parseSince('2026-08-23T11:30:00.000Z', now), Date.parse('2026-08-23T11:30:00.000Z'));
  });

  it('reads a bare integer as epoch milliseconds, not as a duration', () => {
    // `--since 500` cannot mean both "500 ms ago" and "epoch 500". A unit is
    // cheap to type; a silently misread window is not.
    assert.equal(parseSince('1755800000000', now), 1755800000000);
    assert.equal(parseSince('500', now), 500);
  });

  it('refuses anything else rather than quietly meaning "from the beginning"', () => {
    // A harness that mistypes its window and gets the whole log attaches the
    // wrong evidence to a failure, which is worse than no evidence.
    for (const bad of ['yesterday', '5 minutes', '', '   ', '5x', 'm5', '-5m']) {
      assert.throws(() => parseSince(bad, now), /--since/, `accepted ${JSON.stringify(bad)}`);
    }
  });
});
