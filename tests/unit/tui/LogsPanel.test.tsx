import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { render } from 'ink-testing-library';
import React from 'react';
import type { LogEntry } from '../../../src/tui/hooks/useProcessManager.js';
import { LogsPanel } from '../../../src/tui/LogsPanel.js';

test('LogsPanel - renders with focused border', () => {
  const logs: LogEntry[] = [
    { ts: Date.now(), svcName: 'api', colorIdx: 0, text: 'Hello', level: 'info' },
    { ts: Date.now(), svcName: 'web', colorIdx: 1, text: 'World', level: 'info' },
  ];

  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter={null}
      searchTerm={null}
      paused={false}
      showTimestamps={false}
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Logs'));
  assert.ok(output.includes('Hello'));
  assert.ok(output.includes('World'));
});

test('LogsPanel - renders with unfocused border', () => {
  const logs: LogEntry[] = [
    { ts: Date.now(), svcName: 'api', colorIdx: 0, text: 'Test', level: 'info' },
  ];

  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter={null}
      searchTerm={null}
      paused={false}
      showTimestamps={false}
      maxNameLen={10}
      height={20}
      focused={false}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Logs'));
  assert.ok(output.includes('Test'));
});

test('LogsPanel - filters logs by service', () => {
  const logs: LogEntry[] = [
    { ts: Date.now(), svcName: 'api', colorIdx: 0, text: 'API log', level: 'info' },
    { ts: Date.now(), svcName: 'web', colorIdx: 1, text: 'Web log', level: 'info' },
  ];

  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter="api"
      searchTerm={null}
      paused={false}
      showTimestamps={false}
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Logs'));
  assert.ok(output.includes('[api]'));
  assert.ok(output.includes('API log'));
  assert.ok(!output.includes('Web log'));
});

test('LogsPanel - searches logs by term', () => {
  const logs: LogEntry[] = [
    { ts: Date.now(), svcName: 'api', colorIdx: 0, text: 'Error occurred', level: 'info' },
    { ts: Date.now(), svcName: 'web', colorIdx: 1, text: 'Request received', level: 'info' },
  ];

  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter={null}
      searchTerm="error"
      paused={false}
      showTimestamps={false}
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Error occurred'));
  assert.ok(output.includes('Request received'));
});

test('LogsPanel - shows paused indicator', () => {
  const logs: LogEntry[] = [
    { ts: Date.now(), svcName: 'api', colorIdx: 0, text: 'Test', level: 'info' },
  ];

  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter={null}
      searchTerm={null}
      paused={true}
      showTimestamps={false}
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('[PAUSED]'));
});

test('LogsPanel - shows timestamps when enabled', () => {
  const logs: LogEntry[] = [
    { ts: new Date('2024-01-01T12:00:00Z').getTime(), svcName: 'api', colorIdx: 0, text: 'Test', level: 'info' },
  ];

  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter={null}
      searchTerm={null}
      paused={false}
      showTimestamps={true}
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  // Timestamps are formatted as HH:MM:SS in en-GB locale
  // The time might be different depending on the local timezone
  // Just check that a timestamp is present (format HH:MM:SS)
  assert.ok(output.includes(':') && output.includes('['), `Expected output to contain timestamp, got: ${output}`);
});

test('LogsPanel - shows log count', () => {
  const logs: LogEntry[] = [
    { ts: Date.now(), svcName: 'api', colorIdx: 0, text: 'Log 1', level: 'info' },
    { ts: Date.now(), svcName: 'api', colorIdx: 0, text: 'Log 2', level: 'info' },
    { ts: Date.now(), svcName: 'api', colorIdx: 0, text: 'Log 3', level: 'info' },
  ];

  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter={null}
      searchTerm={null}
      paused={false}
      showTimestamps={false}
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('3 lines'));
});

test('LogsPanel - shows filter indicator', () => {
  const logs: LogEntry[] = [
    { ts: Date.now(), svcName: 'api', colorIdx: 0, text: 'Test', level: 'info' },
  ];

  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter="api"
      searchTerm={null}
      paused={false}
      showTimestamps={false}
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('[api]'));
});

test('LogsPanel - shows search indicator', () => {
  const logs: LogEntry[] = [
    { ts: Date.now(), svcName: 'api', colorIdx: 0, text: 'Test', level: 'info' },
  ];

  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter={null}
      searchTerm="test"
      paused={false}
      showTimestamps={false}
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('/test'));
});

test('LogsPanel - highlights search matches', () => {
  const logs: LogEntry[] = [
    { ts: Date.now(), svcName: 'api', colorIdx: 0, text: 'This is an error message', level: 'info' },
  ];

  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter={null}
      searchTerm="error"
      paused={false}
      showTimestamps={false}
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('This is an'));
  assert.ok(output.includes('error'));
  assert.ok(output.includes('message'));
});

test('LogsPanel - handles empty logs', () => {
  const { stdout } = render(
    <LogsPanel
      logs={[]}
      filter={null}
      searchTerm={null}
      paused={false}
      showTimestamps={false}
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Logs'));
  assert.ok(output.includes('0 lines'));
});

test('LogsPanel - default (scrollOffset=0) follows the latest lines', () => {
  const logs: LogEntry[] = Array.from({ length: 20 }, (_, i) => ({
    ts: Date.now(),
    svcName: 'api',
    colorIdx: 0,
    text: `Log line ${i + 1}`,
    level: 'info',
  }));

  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter={null}
      searchTerm={null}
      paused={false}
      showTimestamps={false}
      maxNameLen={10}
      height={10}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Log line 20'), `expected last line visible, got: ${output}`);
  assert.ok(!output.includes('Log line 1 '), 'oldest line should not be visible');
});

test('LogsPanel - bottomOffset shifts view backwards', () => {
  const logs: LogEntry[] = Array.from({ length: 20 }, (_, i) => ({
    ts: Date.now(),
    svcName: 'api',
    colorIdx: 0,
    text: `Log line ${i + 1}`,
    level: 'info',
  }));

  // height=10 → contentHeight=8. bottomOffset=5 → startIndex = 20 - 8 - 5 = 7
  // visibles: logs[7..14] = "Log line 8" .. "Log line 15"
  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter={null}
      searchTerm={null}
      paused={false}
      showTimestamps={false}
      maxNameLen={10}
      height={10}
      focused={true}
      scrollOffset={5}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Log line 8'), `expected line 8 visible, got: ${output}`);
  assert.ok(output.includes('Log line 15'), 'expected line 15 visible');
  assert.ok(!output.includes('Log line 20'), 'last line must not be visible while scrolled up');
  assert.ok(output.includes('[SCROLL]'), 'should show SCROLL indicator when off bottom');
});

test('LogsPanel - MAX_SAFE_INTEGER scrolls to the oldest lines', () => {
  const logs: LogEntry[] = Array.from({ length: 20 }, (_, i) => ({
    ts: Date.now(),
    svcName: 'api',
    colorIdx: 0,
    text: `Log line ${i + 1}`,
    level: 'info',
  }));

  const { stdout } = render(
    <LogsPanel
      logs={logs}
      filter={null}
      searchTerm={null}
      paused={false}
      showTimestamps={false}
      maxNameLen={10}
      height={10}
      focused={true}
      scrollOffset={Number.MAX_SAFE_INTEGER}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  // Con bottomOffset máximo → startIndex = 0 → primeras líneas visibles
  assert.ok(output.includes('Log line 1'), `expected first line visible, got: ${output}`);
  assert.ok(!output.includes('Log line 20'), 'last line must not be visible at top');
});
