import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvContent, parseEnvFile } from '../../../src/utils/env.js';

describe('parseEnvContent', () => {
  it('handles export, inline comments, quotes and empty values', () => {
    const got = Object.fromEntries(parseEnvContent([
      'export DB_URL=postgres://x',
      'PORT=3000 # the api',
      'QUOTED="a # not a comment"',
      "SINGLE='x'",
      'EMPTY=',
      '# comment',
      '',
    ].join('\n')));
    assert.deepEqual(got, { DB_URL: 'postgres://x', PORT: '3000', QUOTED: 'a # not a comment', SINGLE: 'x', EMPTY: '' });
  });
});

describe('parseEnvContent: quotes that do not close at the end', () => {
  it('keeps escaped quotes, and never cuts a value at an inner quote', () => {
    const got = Object.fromEntries(parseEnvContent([
      'JSON="{\\"a\\":1}"',
      'ARGS="--foo" "--bar"',
      "SQ='it''s'",
      'export\tTABBED=1',
      'COMMENTED="{\\"b\\":2}" # service account',
    ].join('\n')));
    assert.equal(got.COMMENTED, '{\\"b\\":2}');
    assert.equal(got.JSON, '{\\"a\\":1}');
    assert.equal(got.ARGS, '--foo" "--bar');
    assert.equal(got.SQ, "it''s");
    assert.equal(got.TABBED, '1');
  });
});

describe('parseEnvFile', () => {
  it('an empty value in the base env is filled from the file — a missing CI secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-env-'));
    const f = join(dir, '.env');
    writeFileSync(f, 'FOO=from-file\nBAR=from-file\n');
    const env = parseEnvFile(f, { FOO: '', BAR: 'shell' });
    assert.equal(env.FOO, 'from-file');
    assert.equal(env.BAR, 'shell');
  });
});
