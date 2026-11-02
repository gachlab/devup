import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lineBuffer } from '../../../src/process/internals.js';

describe('lineBuffer', () => {
  it('keeps a multi-byte character that a chunk boundary splits in two', () => {
    const lines: string[] = [];
    const lb = lineBuffer(l => lines.push(l));
    const bytes = Buffer.from('ñandú ✓\n', 'utf8');
    lb.push(bytes.subarray(0, 1)); // first byte of ñ
    lb.push(bytes.subarray(1, 9)); // ...splitting ✓ too
    lb.push(bytes.subarray(9));
    assert.deepEqual(lines, ['ñandú ✓']);
  });
});
