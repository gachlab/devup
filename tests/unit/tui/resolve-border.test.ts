import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBorder } from '../../../src/tui/LogsPanel.js';
import { tagColors } from '../../../src/utils.js';

describe('resolveBorder (LogsPanel)', () => {
  it('focus always wins, regardless of filter', () => {
    assert.equal(resolveBorder(true, null, null), 'cyan');
    assert.equal(resolveBorder(true, 'api', 0), 'cyan');
  });

  it('returns gray when no filter and not focused', () => {
    assert.equal(resolveBorder(false, null, null), 'gray');
  });

  it('returns gray when filter is set but colorIdx is unknown', () => {
    assert.equal(resolveBorder(false, 'api', null), 'gray');
  });

  it('returns the tagColor for the filtered service when known and not focused', () => {
    for (let i = 0; i < tagColors.length; i++) {
      assert.equal(resolveBorder(false, 'svc', i), tagColors[i]);
    }
  });

  it('wraps colorIdx modulo tagColors.length', () => {
    assert.equal(resolveBorder(false, 'svc', tagColors.length), tagColors[0]);
    assert.equal(resolveBorder(false, 'svc', tagColors.length + 3), tagColors[3]);
  });
});
