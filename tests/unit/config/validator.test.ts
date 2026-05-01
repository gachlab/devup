import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../../../src/config/validator.js';
import type { DevStackConfig } from '../../../src/config/types.js';

const minimal = (): DevStackConfig => ({
  name: 'Test',
  services: [
    { name: 'api-a', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0 },
    { name: 'web-a', cwd: '.', cmd: 'npx', args: [], type: 'web', port: 4200, phase: 4 },
  ],
});

describe('validateConfig', () => {
  it('passes valid config', () => {
    const errors = validateConfig(minimal(), '/tmp');
    // cwd '.' resolves to /tmp which exists
    assert.equal(errors.length, 0);
  });

  it('catches missing name', () => {
    const cfg = { ...minimal(), name: '' };
    const errors = validateConfig(cfg, '/tmp');
    assert.ok(errors.some(e => e.field === 'name'));
  });

  it('catches empty services', () => {
    const cfg = { ...minimal(), services: [] };
    const errors = validateConfig(cfg, '/tmp');
    assert.ok(errors.some(e => e.field === 'services'));
  });

  it('catches duplicate names', () => {
    const cfg = minimal();
    cfg.services[1]!.name = 'api-a';
    const errors = validateConfig(cfg, '/tmp');
    assert.ok(errors.some(e => e.message.includes('Duplicate service name')));
  });

  it('catches duplicate ports', () => {
    const cfg = minimal();
    cfg.services[1]!.port = 3000;
    const errors = validateConfig(cfg, '/tmp');
    assert.ok(errors.some(e => e.message.includes('Port 3000')));
  });

  it('catches invalid type', () => {
    const cfg = minimal();
    (cfg.services[0] as any).type = 'worker';
    const errors = validateConfig(cfg, '/tmp');
    assert.ok(errors.some(e => e.message.includes('Invalid type')));
  });

  it('catches negative phase', () => {
    const cfg = minimal();
    cfg.services[0]!.phase = -1;
    const errors = validateConfig(cfg, '/tmp');
    assert.ok(errors.some(e => e.message.includes('Invalid phase')));
  });

  it('catches invalid lazy.alwaysOn ref', () => {
    const cfg = { ...minimal(), lazy: { alwaysOn: ['nonexistent'] } };
    const errors = validateConfig(cfg, '/tmp');
    assert.ok(errors.some(e => e.message.includes('Unknown service: nonexistent')));
  });

  it('catches invalid traefik.routes ref', () => {
    const cfg = { ...minimal(), proxy: { provider: 'traefik', routes: { 'nonexistent': 'sub' } } };
    const errors = validateConfig(cfg, '/tmp');
    assert.ok(errors.some(e => e.message.includes('Unknown service: nonexistent')));
  });

  it('catches nonexistent cwd', () => {
    const cfg = minimal();
    cfg.services[0]!.cwd = 'this/does/not/exist';
    const errors = validateConfig(cfg, '/tmp');
    assert.ok(errors.some(e => e.message.includes('Directory not found')));
  });
});
