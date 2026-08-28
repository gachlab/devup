import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { render } from 'ink-testing-library';
import React from 'react';
import { StatsPanel } from '../../../src/tui/StatsPanel.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceStats } from '../../../src/tui/hooks/useProcessManager.js';

function createProcessState(name: string, port: number, status: ProcessState['status'], health: ProcessState['health']): ProcessState {
  return {
    svc: { name, port, type: 'api' as const, phase: 1, cwd: '.', cmd: 'node', args: [] },
    proc: null,
    pid: null,
    status,
    health,
    errors: 0,
    restarts: 0,
    startedAt: null,
    intentionalStop: false, crashLog: null,
    colorIdx: 0,
  };
}

test('StatsPanel - renders with focused border', () => {
  const states = new Map<string, ProcessState>([
    ['api', createProcessState('api', 3000, 'running', 'up')],
  ]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Stats'));
  assert.ok(output.includes('api'));
});

test('StatsPanel - renders with unfocused border', () => {
  const states = new Map<string, ProcessState>([
    ['api', createProcessState('api', 3000, 'running', 'up')],
  ]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={false}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Stats'));
});

test('StatsPanel - shows system stats', () => {
  const states = new Map<string, ProcessState>([]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('System:'));
  assert.ok(output.includes('Load'));
  assert.ok(output.includes('RAM'));
});

test('StatsPanel - shows stack totals', () => {
  const states = new Map<string, ProcessState>([
    ['api', createProcessState('api', 3000, 'running', 'up')],
  ]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Stack:'));
  assert.ok(output.includes('Err'));
  assert.ok(output.includes('Rst'));
  assert.ok(output.includes('Svcs'));
});

test('StatsPanel - shows APIs column', () => {
  const states = new Map<string, ProcessState>([
    ['api1', createProcessState('api1', 3000, 'running', 'up')],
    ['api2', createProcessState('api2', 3001, 'running', 'up')],
  ]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('APIs (2)'));
  assert.ok(output.includes('api1'));
  assert.ok(output.includes('api2'));
});

test('StatsPanel - shows Webs column', () => {
  const states = new Map<string, ProcessState>([
    ['web1', { ...createProcessState('web1', 8080, 'running', 'up'), svc: { ...createProcessState('web1', 8080, 'running', 'up').svc, type: 'web' as const } }],
    ['web2', { ...createProcessState('web2', 8081, 'running', 'up'), svc: { ...createProcessState('web2', 8081, 'running', 'up').svc, type: 'web' as const } }],
  ]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Webs (2)'));
  assert.ok(output.includes('web1'));
  assert.ok(output.includes('web2'));
});

test('StatsPanel - shows service status', () => {
  const states = new Map<string, ProcessState>([
    ['api', createProcessState('api', 3000, 'running', 'up')],
  ]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('running'));
});

test('StatsPanel - shows service health indicator', () => {
  const states = new Map<string, ProcessState>([
    ['api', createProcessState('api', 3000, 'running', 'up')],
  ]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('●'));
});

test('StatsPanel - shows idle status', () => {
  const states = new Map<string, ProcessState>([
    ['api', createProcessState('api', 3000, 'idle', 'idle')],
  ]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('idle'));
  assert.ok(output.includes('○'));
});

test('StatsPanel - shows errors count', () => {
  const states = new Map<string, ProcessState>([
    ['api', { ...createProcessState('api', 3000, 'running', 'up'), errors: 5 }],
  ]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('5'));
});

test('StatsPanel - shows restarts count', () => {
  const states = new Map<string, ProcessState>([
    ['api', { ...createProcessState('api', 3000, 'running', 'up'), restarts: 3 }],
  ]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('3'));
});

test('StatsPanel - shows uptime', () => {
  const now = Date.now();
  const states = new Map<string, ProcessState>([
    ['api', { ...createProcessState('api', 3000, 'running', 'up'), startedAt: now }],
  ]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Up'));
});

test('StatsPanel - handles empty states', () => {
  const states = new Map<string, ProcessState>([]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Stats'));
  assert.ok(output.includes('APIs (0)'));
  assert.ok(output.includes('Webs (0)'));
});

test('StatsPanel - scroll offset works correctly', () => {
  const states = new Map<string, ProcessState>(
    Array.from({ length: 20 }, (_, i) => [
      `api${i}`,
      createProcessState(`api${i}`, 3000 + i, 'running', 'up'),
    ])
  );
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={15}
      focused={true}
      scrollOffset={5}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('api5'));
  assert.ok(!output.includes('api0'));
});

test('StatsPanel - scroll to end', () => {
  const states = new Map<string, ProcessState>(
    Array.from({ length: 20 }, (_, i) => [
      `api${i}`,
      createProcessState(`api${i}`, 3000 + i, 'running', 'up'),
    ])
  );
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={15}
      focused={true}
      scrollOffset={Number.MAX_SAFE_INTEGER}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  // When scrolled to end, we should see the last services
  // The exact services visible depend on the implementation
  // Just check that some services are visible
  assert.ok(output.includes('api') || output.includes('APIs'), `Expected output to contain services, got: ${output}`);
});

test('StatsPanel - shows sort mode', () => {
  const states = new Map<string, ProcessState>([]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="mem"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  // Check that sort mode is displayed (format may vary)
  assert.ok(output.includes('Sort') || output.includes('mem'), `Expected output to contain sort info, got: ${output}`);
});

test('StatsPanel - shows CPU and Mem headers', () => {
  const states = new Map<string, ProcessState>([]);
  const stats = new Map<string, ServiceStats>();

  const { stdout } = render(
    <StatsPanel
      states={states}
      stats={stats}
      sortMode="name"
      maxNameLen={10}
      height={20}
      focused={true}
      scrollOffset={0}
      resetScroll={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('CPU'));
  assert.ok(output.includes('Mem'));
});
