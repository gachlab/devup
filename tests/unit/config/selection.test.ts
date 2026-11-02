import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { managedServices } from '../../../src/config/selection.js';
import { parseCliArgs } from '../../../src/config/cli.js';
import type { DevStackConfig } from '../../../src/config/types.js';

const config: DevStackConfig = {
  name: 'S',
  services: ['api', 'web', 'worker'].map((name, i) => ({ name, cwd: '.', cmd: 'node', args: [], type: 'api' as const, port: 3000 + i, phase: 0 })),
  profiles: { front: ['web'] },
};

describe('managedServices', () => {
  it('honours --skip and --profile, the selection a reload has to keep', () => {
    assert.deepEqual(managedServices(config, parseCliArgs(['--skip', 'worker'])).map(s => s.name), ['api', 'web']);
    assert.deepEqual(managedServices(config, parseCliArgs(['--profile', 'front'])).map(s => s.name), ['web']);
  });
});
