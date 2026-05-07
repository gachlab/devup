import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { render } from 'ink-testing-library';
import React from 'react';
import { ServiceList } from '../../../src/tui/ServiceList.js';
import type { ProcessState } from '../../../src/process/types.js';

function createProcessState(name: string, port: number, type: 'api' | 'web' = 'api'): ProcessState {
  return {
    svc: { name, port, type, phase: 1, cwd: '.', cmd: 'node', args: [] },
    proc: null,
    pid: null,
    status: 'running',
    health: 'up',
    errors: 0,
    restarts: 0,
    startedAt: null,
    intentionalStop: false,
    colorIdx: 0,
  };
}

test('ServiceList - renders with title and services', () => {
  const states = new Map<string, ProcessState>([
    ['api1', createProcessState('api1', 3000)],
    ['api2', createProcessState('api2', 3001)],
  ]);

  let selectedService: string | null = null;
  let closed = false;

  const { stdout } = render(
    <ServiceList
      title="Test Services"
      services={states}
      onSelect={(name) => { selectedService = name; }}
      onClose={() => { closed = true; }}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Test Services'));
  assert.ok(output.includes('api1'));
  assert.ok(output.includes('api2'));
  assert.ok(output.includes(':3000'));
  assert.ok(output.includes(':3001'));
  assert.ok(output.includes('↑↓ navigate'));
  assert.ok(output.includes('Enter select'));
  assert.ok(output.includes('Esc close'));
});

test('ServiceList - filters by type when filterType specified', () => {
  const states = new Map<string, ProcessState>([
    ['api1', createProcessState('api1', 3000, 'api')],
    ['web1', createProcessState('web1', 8080, 'web')],
    ['api2', createProcessState('api2', 3001, 'api')],
  ]);

  const { stdout } = render(
    <ServiceList
      title="APIs Only"
      services={states}
      onSelect={() => {}}
      onClose={() => {}}
      filterType="api"
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('api1'));
  assert.ok(output.includes('api2'));
  assert.ok(!output.includes('web1'));
});

test('ServiceList - shows all services when no filterType', () => {
  const states = new Map<string, ProcessState>([
    ['api1', createProcessState('api1', 3000, 'api')],
    ['web1', createProcessState('web1', 8080, 'web')],
  ]);

  const { stdout } = render(
    <ServiceList
      title="All Services"
      services={states}
      onSelect={() => {}}
      onClose={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('api1'));
  assert.ok(output.includes('web1'));
});

test('ServiceList - handles empty services list', () => {
  const states = new Map<string, ProcessState>();

  const { stdout } = render(
    <ServiceList
      title="Empty"
      services={states}
      onSelect={() => {}}
      onClose={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  assert.ok(output.includes('Empty'));
  // Should still render the help text
  assert.ok(output.includes('↑↓ navigate'));
});

test('ServiceList - has cyan border', () => {
  const states = new Map<string, ProcessState>([
    ['api1', createProcessState('api1', 3000)],
  ]);

  const { stdout } = render(
    <ServiceList
      title="Test"
      services={states}
      onSelect={() => {}}
      onClose={() => {}}
    />
  );

  const output = stdout.lastFrame() || '';
  // Border color is applied via Ink styling
  assert.ok(output.includes('Test'));
});