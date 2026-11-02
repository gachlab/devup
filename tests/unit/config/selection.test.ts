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

describe('managedServices with services served from a remote', () => {
  it('leaves out what was remote at boot, even when the selection includes it', () => {
    // `--remote qa:api`: api is in the selection and served from qa.
    const got = managedServices(config, parseCliArgs(['--remote', 'qa:api']), new Set(['api']));
    assert.deepEqual(got.map(s => s.name), ['web', 'worker']);
  });
});
