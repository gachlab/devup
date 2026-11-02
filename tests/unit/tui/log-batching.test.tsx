import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { render } from 'ink-testing-library';
import React, { useEffect, useRef } from 'react';
import { Text } from 'ink';
import { useProcessManager, LOG_FLUSH_MS } from '../../../src/tui/hooks/useProcessManager.js';
import type { Platform } from '../../../src/platform/types.js';

const platform: Platform = {
  getProcessStats: async () => new Map(), killTree: () => {}, openBrowser: () => {}, defaultTraefikHost: '127.0.0.1',
};
const env = {};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Polls until `get()` matches or `ms` passes; returns the last value. */
async function waitFor(get: () => string, want: RegExp, ms: number): Promise<string> {
  const end = Date.now() + ms;
  let v = get();
  while (!want.test(v) && Date.now() < end) { await sleep(5); v = get(); }
  return v;
}

describe('useProcessManager', () => {
  it('exposes the manager after mount without waiting for an unrelated update', async () => {
    // It was read from a ref during render: `null` until something else
    // happened to re-render, so the boot effect waiting for it ran late.
    let seen: unknown = null;
    function Probe() {
      const pm = useProcessManager(platform, process.cwd(), env);
      seen = pm.manager;
      return <Text>x</Text>;
    }
    const r = render(<Probe />);
    try {
      // Polled, not a fixed sleep: a loaded CI runner takes longer than 20 ms
      // to run the effect. Without the fix it never appears at all.
      const end = Date.now() + 2000;
      while (!seen && Date.now() < end) await sleep(10);
      assert.ok(seen, 'manager still null after mount');
    } finally {
      r.unmount();
    }
  });

  it('renders lines in batches, not once per line', async () => {
    // One line per macrotask, the way a child's stdout arrives: React only
    // batches within a tick, so without our own batching each line is a render.
    let renders = 0;
    let lines = 0;
    function Burst() {
      const pm = useProcessManager(platform, process.cwd(), env);
      renders++;
      lines = pm.logs.length;
      const done = useRef(false);
      useEffect(() => {
        if (done.current) return;
        done.current = true;
        let i = 0;
        const next = () => { pm.pushLog('svc', `line ${i}`); if (++i < 200) setTimeout(next, 1); };
        next();
      }, [pm.pushLog]);
      return <Text>{pm.logs.length}</Text>;
    }
    const r = render(<Burst />);
    try {
      const end = Date.now() + 5000;
      while (lines < 200 && Date.now() < end) await sleep(LOG_FLUSH_MS);
      assert.equal(lines, 200);
      assert.ok(renders < 60, `rendered ${renders} times for 200 lines`);
    } finally {
      r.unmount();
    }
  });
});

describe('pause and the flush queue', () => {
  it('keeps order across pause/resume and flushes what was queued before the pause', async () => {
    // Queued lines used to stay on their 50 ms timer: they landed after a
    // resume's backlog (B before A), or after the pause (moving the view under
    // someone who had just scrolled up).
    let api: ReturnType<typeof useProcessManager> | null = null;
    function Probe() {
      api = useProcessManager(platform, process.cwd(), env);
      return <Text>{api.logs.map(l => l.text).join(',')}</Text>;
    }
    const r = render(<Probe />);
    try {
      const end = Date.now() + 2000;
      while (!api && Date.now() < end) await sleep(10);
      api!.pushLog('svc', 'A');
      api!.setPaused(true);
      // Bounded below the flush interval: without the synchronous flush, A
      // would only show up once its own timer fired.
      const frame = () => r.lastFrame() ?? '';
      assert.match(await waitFor(frame, /^A$/, LOG_FLUSH_MS - 10), /^A$/,
        'A was queued before the pause and must be on screen');
      api!.pushLog('svc', 'B');
      await sleep(LOG_FLUSH_MS * 2);
      assert.match(r.lastFrame() ?? '', /^A$/, 'nothing lands while paused');
      api!.setPaused(false);
      api!.pushLog('svc', 'C');
      // Polled: C rides the flush timer, which a loaded runner can delay well
      // past two intervals.
      assert.equal(await waitFor(frame, /^A,B,C$/, 2000), 'A,B,C');
    } finally {
      r.unmount();
    }
  });
});
