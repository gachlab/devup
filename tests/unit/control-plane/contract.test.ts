import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeState } from '../../../src/control-plane/socket-server.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

/** Golden fixture for the `status` wire shape.
 *
 *  The snapshot is defined twice — here, and again by hand in
 *  gachlab/devup-vscode, which deliberately does not depend on this package at
 *  runtime. Nothing else keeps the two honest: `docs/control-plane.md` once
 *  described `port` as "from config", the extension believed it, and shipped a
 *  release forwarding the wrong port.
 *
 *  This file is generated from `serializeState` itself, so renaming a field
 *  fails here rather than in someone's editor. Regenerate deliberately:
 *
 *      UPDATE_CONTRACT=1 npm run test:unit
 *
 *  and treat the diff as an API change.
 */
const FIXTURE = join(process.cwd(), 'contract', 'status-snapshot.json');

const alwaysOn: ServiceConfig = {
  name: 'configurations-api', cwd: 'configurations/api', cmd: 'node',
  args: ['--watch-path', 'src', 'src/index.js'], type: 'api', port: 2999, phase: 0,
};
// As the orchestrator holds a lazy service: rewriteServicePort has already
// moved `port` to port + 10000 and kept the configured one as originalPort.
const lazy = {
  name: 'authorization-api', cwd: 'authorization/api', cmd: 'node',
  args: ['app.js'], type: 'api', port: 13002, phase: 1, originalPort: 3002,
} as ServiceConfig;

function mkState(svc: ServiceConfig, over: Partial<ProcessState> = {}): ProcessState {
  return {
    svc, proc: null, pid: 4242, status: 'running', health: 'up',
    errors: 0, restarts: 1, startedAt: 1755800000000,
    intentionalStop: false, colorIdx: 3, crashLog: null,
    ...over,
  };
}

function build(): unknown {
  return {
    services: [
      serializeState('configurations-api', mkState(alwaysOn)),
      serializeState('authorization-api', mkState(lazy, { status: 'idle', health: 'idle', pid: null })),
    ],
  };
}

describe('control-plane contract', () => {
  it('matches contract/status-snapshot.json', () => {
    const current = build();
    if (process.env['UPDATE_CONTRACT']) {
      writeFileSync(FIXTURE, JSON.stringify(current, null, 2) + '\n');
    }
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    assert.deepEqual(
      current, golden,
      'the status wire shape changed — update the fixture with UPDATE_CONTRACT=1, ' +
      'then update docs/control-plane.md and gachlab/devup-vscode to match',
    );
  });

  it('keeps the two ports distinguishable', () => {
    // The whole reason the fixture exists: `port` is where the process listens,
    // `originalPort` is where the proxy does and what clients must connect to.
    const [, auth] = (build() as { services: Array<Record<string, unknown>> }).services;
    assert.equal(auth!['port'], 13002);
    assert.equal(auth!['originalPort'], 3002);
  });

  it('reports both ports identically for an always-on service', () => {
    const [cfg] = (build() as { services: Array<Record<string, unknown>> }).services;
    assert.equal(cfg!['port'], cfg!['originalPort'], 'clients rely on this to avoid a version check');
  });
});
