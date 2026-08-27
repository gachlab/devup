import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { render } from 'ink-testing-library';
import React from 'react';
import { StatsPanel, remoteLabel } from '../../../src/tui/StatsPanel.js';
import type { ProcessState, RemoteState } from '../../../src/process/types.js';
import type { ServiceStats } from '../../../src/tui/hooks/useProcessManager.js';

function remoteState(name: string, port: number, remote: RemoteState, health: ProcessState['health'] = 'up'): ProcessState {
  return {
    svc: { name, port, type: 'api' as const, phase: 1, cwd: '.', cmd: 'node', args: [] },
    proc: null,
    pid: null,
    status: 'running',
    health,
    errors: 0,
    restarts: 0,
    startedAt: Date.now(),
    intentionalStop: false,
    colorIdx: 0,
    crashLog: null,
    remote,
  };
}

const qa: RemoteState = { envName: 'qa', target: 'https://app-api.qa.norelian.com', readOnly: false };
const empty = new Map<string, ServiceStats>();

const panel = (states: Map<string, ProcessState>, verbose = false) => render(
  <StatsPanel
    states={states} stats={empty} sortMode="name" maxNameLen={12}
    height={20} focused={false} scrollOffset={0} resetScroll={() => {}} verbose={verbose}
  />,
).lastFrame() ?? '';

test('remoteLabel names the environment instead of repeating "running"', () => {
  // `running` is true and useless here: what matters about the row is that the
  // process is not local and the traffic leaves the machine.
  assert.equal(remoteLabel({ envName: 'qa', readOnly: false }), '→qa');
});

test('remoteLabel marks a read-only environment', () => {
  assert.equal(remoteLabel({ envName: 'qa', readOnly: true }), '→qa ro');
});

test('remoteLabel fits the status column', () => {
  // Eight characters, same as every other status. A longer one shifts every
  // column to its right and the table stops lining up.
  assert.ok(remoteLabel({ envName: 'staging-eu', readOnly: false }).length <= 8);
});

test('StatsPanel marks a remote row and names its environment', () => {
  const frame = panel(new Map([['app-api', remoteState('app-api', 3000, qa)]]));
  assert.match(frame, /app-api/);
  assert.match(frame, /→qa/);
  assert.match(frame, /◈/);
});

test('StatsPanel warns while any remote service accepts writes', () => {
  // Standing, not transient: for as long as the row is on screen a request
  // against that port changes data in a shared environment.
  const frame = panel(new Map([['app-api', remoteState('app-api', 3000, qa)]]));
  assert.match(frame, /1 remote → qa/);
});

test('the write warning fits on one line, and names the services', () => {
  // It lived in the header first and wrapped in half there. A standing notice
  // that is split across two lines is one people learn to skip.
  const frame = panel(new Map([
    ['app-api', remoteState('app-api', 3000, qa)],
    ['rules-api', remoteState('rules-api', 3007, qa)],
  ]));
  const line = frame.split('\n').find(l => l.includes('remote →'));
  assert.ok(line, 'no warning line');
  assert.match(line!, /2 remote → qa — writes reach it: app-api, rules-api/);
});

test('StatsPanel stays quiet when every remote is read-only', () => {
  const ro: RemoteState = { ...qa, readOnly: true };
  const frame = panel(new Map([['app-api', remoteState('app-api', 3000, ro)]]));
  assert.ok(!/remote →/.test(frame), frame);
});

test('StatsPanel keeps the health dot colour question answerable', () => {
  // The glyph changes, but health is still what the indicator reports: a
  // remote whose environment stopped answering must not look identical to one
  // that is fine.
  const down = panel(new Map([['app-api', remoteState('app-api', 3000, qa, 'down')]]));
  assert.match(down, /◈/);
});

test('StatsPanel shows the target instead of a command in verbose mode', () => {
  // There is no command to resolve and no extraEnv to redact; where the
  // traffic goes is the only thing verbose can usefully add.
  const frame = panel(new Map([['app-api', remoteState('app-api', 3000, qa)]]), true);
  assert.match(frame, /https:\/\/app-api\.qa\.norelian\.com/);
});

test('StatsPanel reports no CPU or memory on the row itself', () => {
  // Asserted on the row, not on the frame: the Stack totals legitimately read
  // 0.0% when nothing local is running, and matching the whole frame would
  // confuse "we sampled nothing" with "we sampled zero".
  const frame = panel(new Map([['app-api', remoteState('app-api', 3000, qa)]]));
  // Matched on the row marker, not on the name: the write warning above also
  // names the service, and it was the line this found first.
  const row = frame.split('\n').find(l => l.includes('◈'));
  assert.ok(row, 'no row for app-api');
  // CPU and Mem columns, both blank.
  assert.match(row!, /→qa\s+-\s+-\s+0/);
});
