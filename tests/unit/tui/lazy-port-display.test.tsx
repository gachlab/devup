import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { render } from 'ink-testing-library';
import React from 'react';
import { StatsPanel } from '../../../src/tui/StatsPanel.js';
import { ServiceList } from '../../../src/tui/ServiceList.js';
import { rewriteServicePort } from '../../../src/lazy/classifier.js';
import type { ProcessState } from '../../../src/process/types.js';

process.stdin.isTTY = true;

/** A lazy service as the boot registers it: `svc` is the rewritten config. */
function lazyState(): ProcessState {
  const base: ProcessState = {
    svc: rewriteServicePort({ name: 'app-api', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3002, phase: 0 }),
    proc: null, pid: null, status: 'idle', health: 'idle',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 0, crashLog: null,
  };
  return base;
}

describe('a lazy service shows its public port (hazard §3)', () => {
  it('in the stats panel', () => {
    const { lastFrame } = render(
      <StatsPanel states={new Map([['app-api', lazyState()]])} stats={new Map()} sortMode="name"
        maxNameLen={10} height={20} focused scrollOffset={0} resetScroll={() => {}} />,
    );
    const out = lastFrame() ?? '';
    assert.match(out, /\b3002\b/);
    assert.doesNotMatch(out, /\b13002\b/, 'the internal port refuses connections while the service sleeps');
  });

  it('in the picker behind r and o', () => {
    const { lastFrame } = render(
      <ServiceList title="Open" services={new Map([['app-api', lazyState()]])} onSelect={() => {}} onClose={() => {}} />,
    );
    assert.match(lastFrame() ?? '', /:3002\b/);
  });
});
