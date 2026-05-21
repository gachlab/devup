import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickTip, type TipState } from '../../../src/tui/tips.js';

function baseState(over: Partial<TipState> = {}): TipState {
  return {
    totalLogs: 0,
    hasSearch: false,
    hasFilter: false,
    crashLoopedCount: 0,
    shown: new Set(),
    ...over,
  };
}

describe('pickTip', () => {
  it('returns null when nothing applies', () => {
    assert.equal(pickTip(baseState({ totalLogs: 100 })), null);
  });

  it('returns crashed tip when at least one service is looped', () => {
    const t = pickTip(baseState({ crashLoopedCount: 1 }));
    assert.equal(t?.id, 'crashed');
    assert.ok(t?.message.includes('restart'));
  });

  it('returns search tip when logs > 1000 and no search active', () => {
    const t = pickTip(baseState({ totalLogs: 1001 }));
    assert.equal(t?.id, 'search');
  });

  it('returns filter tip when 500 < logs <= 1000 and no filter active', () => {
    const t = pickTip(baseState({ totalLogs: 600 }));
    assert.equal(t?.id, 'filter');
  });

  it('search tip suppressed when hasSearch', () => {
    const t = pickTip(baseState({ totalLogs: 1500, hasSearch: true }));
    assert.equal(t?.id, 'filter');  // falls through to filter
  });

  it('does not repeat a tip already shown', () => {
    const shown = new Set(['search']);
    const t = pickTip(baseState({ totalLogs: 1500, shown }));
    assert.equal(t?.id, 'filter');
  });

  it('does not repeat any tip when all relevant ones are shown', () => {
    const shown = new Set(['crashed', 'search', 'filter']);
    const t = pickTip(baseState({ totalLogs: 1500, crashLoopedCount: 1, shown }));
    assert.equal(t, null);
  });

  it('crashed tip takes priority over search/filter', () => {
    const t = pickTip(baseState({ totalLogs: 1500, crashLoopedCount: 1 }));
    assert.equal(t?.id, 'crashed');
  });
});
