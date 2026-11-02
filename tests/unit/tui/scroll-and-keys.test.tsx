import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { render } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { Text } from 'ink';
import { useKeyBindings } from '../../../src/tui/hooks/useKeyBindings.js';
import { detectLogLevel } from '../../../src/utils.js';
import { LogsPanel } from '../../../src/tui/LogsPanel.js';
import type { LogEntry } from '../../../src/tui/hooks/useProcessManager.js';

process.stdin.isTTY = true;

const UP = '\u001B[A', DOWN = '\u001B[B', PGUP = '\u001B[5~';
const CTRL_A = '\u0001', CTRL_C = '\u0003';
const tick = () => new Promise(r => setTimeout(r, 30));

/** Reports a logs limit the way LogsPanel does, and prints the offset. */
function Harness({ max, onQuit = () => {} }: { max: number; onQuit?: () => void }) {
  const kb = useKeyBindings({ onQuit, onClearLogs: () => {}, onToggleProxy: () => {} });
  useEffect(() => { kb.setLogsMaxOffset(max); }, [max, kb.setLogsMaxOffset]);
  return <Text>offset={kb.logsScrollOffset} modal={kb.modal}</Text>;
}
const offsetOf = (frame: string | undefined) => Number(/offset=(\d+)/.exec(frame ?? '')![1]);

describe('logs scroll offset', () => {
  it('never runs past what the panel can show', async () => {
    // One ↑ with fewer lines than fit used to set offset 1: the logs paused on
    // the raw value while the panel, clamping, showed no [SCROLL].
    const r = render(<Harness max={0} />);
    await tick();
    r.stdin.write(UP); await tick();
    assert.equal(offsetOf(r.lastFrame()), 0);
    r.unmount();
  });

  it('↓ moves again after Home: the top is a real offset, not a sentinel', async () => {
    const r = render(<Harness max={50} />);
    await tick();
    r.stdin.write(CTRL_A); await tick();
    assert.equal(offsetOf(r.lastFrame()), 50);
    r.stdin.write(DOWN); await tick();
    assert.equal(offsetOf(r.lastFrame()), 49);
    r.unmount();
  });

  it('clamps the stored offset when the content shrinks under it', async () => {
    const r = render(<Harness max={50} />);
    await tick();
    r.stdin.write(PGUP); r.stdin.write(PGUP); await tick();
    assert.equal(offsetOf(r.lastFrame()), 20, 'PgUp scrolls by 10');
    r.rerender(<Harness max={5} />); await tick();
    assert.equal(offsetOf(r.lastFrame()), 5);
    r.unmount();
  });
});

describe('Ctrl+C', () => {
  it('quits with a modal open', async () => {
    let quit = 0;
    const r = render(<Harness max={0} onQuit={() => { quit++; }} />);
    await tick();
    r.stdin.write('/'); await tick();
    assert.match(r.lastFrame() ?? '', /modal=search/);
    r.stdin.write(CTRL_C); await tick();
    assert.equal(quit, 1);
    r.unmount();
  });
});

describe('detectLogLevel and Node deprecations', () => {
  it('classes a DeprecationWarning as a warning, so the L filter shows it', () => {
    assert.equal(detectLogLevel('(node:123) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.'), 'warn');
    assert.equal(detectLogLevel('this API is deprecated'), 'warn');
  });
});

describe('LogsPanel reports its limit to the key handler', () => {
  it('one ↑ with fewer lines than fit leaves the offset at 0 (so the logs do not pause)', async () => {
    // The real wiring, as App has it: the panel measures, the hook clamps.
    const logs: LogEntry[] = ['a', 'b', 'c'].map((text, i) => ({ svcName: 'svc', text, colorIdx: 0, ts: i, level: 'info' }));
    function App() {
      const kb = useKeyBindings({ onQuit: () => {}, onClearLogs: () => {}, onToggleProxy: () => {} });
      return (
        <>
          <Text>offset={kb.logsScrollOffset}</Text>
          <LogsPanel logs={logs} filter={null} searchTerm={null} paused={false} showTimestamps={false}
            maxNameLen={5} height={20} focused scrollOffset={kb.logsScrollOffset}
            resetScroll={kb.resetLogsScroll} onMaxOffset={kb.setLogsMaxOffset} />
        </>
      );
    }
    const r = render(<App />);
    await tick();
    r.stdin.write(UP); await tick();
    assert.equal(offsetOf(r.lastFrame()), 0);
    r.unmount();
  });
});
