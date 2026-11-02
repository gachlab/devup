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
      await sleep(20);
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
