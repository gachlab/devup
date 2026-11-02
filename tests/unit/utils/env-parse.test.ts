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

describe('parseEnvFile', () => {
  it('an empty value already in the base env is kept, not replaced by the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-env-'));
    const f = join(dir, '.env');
    writeFileSync(f, 'FOO=from-file\n');
    assert.equal(parseEnvFile(f, { FOO: '' }).FOO, '');
  });
});
