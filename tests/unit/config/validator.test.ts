import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { validateConfig, collectWarnings, formatValidationWarnings } from '../../../src/config/validator.js';
import type { DevStackConfig } from '../../../src/config/types.js';

const tmp = tmpdir();

const minimal = (): DevStackConfig => ({
  name: 'Test',
  services: [
    { name: 'api-a', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0 },
    { name: 'web-a', cwd: '.', cmd: 'npx', args: [], type: 'web', port: 4200, phase: 4 },
  ],
});

describe('validateConfig: debug', () => {
  const withDebug = (debug: unknown, cmd = 'node'): DevStackConfig => ({
    name: 'Test',
    services: [{ name: 'api-a', cwd: '.', cmd, args: [], type: 'api', port: 3000, phase: 0, debug } as never],
  });
  const debugErrors = (cfg: DevStackConfig) =>
    validateConfig(cfg, tmp).filter(e => e.field.endsWith('.debug'));

  it('acepta las tres formas válidas', () => {
    for (const d of [true, false, 9229, {}, { port: 9229 }, { brk: true }, { port: 9229, brk: false }]) {
      assert.deepEqual(debugErrors(withDebug(d)), [], `rechazó ${JSON.stringify(d)}`);
    }
  });

  it('rechaza un puerto imposible, venga como venga', () => {
    // Un valor malo llega a `--inspect=<n>`, node se niega a arrancar, y la
    // flag se queda pegada al servicio: cada reinicio falla igual.
    for (const d of [0, -1, 70000, 1.5, '9229', { port: 0 }, { port: 70000 }, { port: '9229' }]) {
      assert.equal(debugErrors(withDebug(d)).length, 1, `aceptó ${JSON.stringify(d)}`);
    }
  });

  it('rechaza claves y tipos que no existen en la forma objeto', () => {
    assert.equal(debugErrors(withDebug({ brk: 'yes' })).length, 1);
    assert.equal(debugErrors(withDebug({ port: 9229, inspect: true })).length, 1);
    assert.equal(debugErrors(withDebug(null)).length, 1);
  });

  it('sigue rechazando el inspector fuera de node', () => {
    assert.equal(debugErrors(withDebug({ brk: true }, 'npx')).length, 1);
    assert.equal(debugErrors(withDebug(false, 'npx')).length, 0);
  });
});

describe('validateConfig', () => {
  it('passes valid config', () => {
    const errors = validateConfig(minimal(), tmp);
    // cwd '.' resolves to /tmp which exists
    assert.equal(errors.length, 0);
  });

  it('catches missing name', () => {
    const cfg = { ...minimal(), name: '' };
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.field === 'name'));
  });

  it('catches empty services', () => {
    const cfg = { ...minimal(), services: [] };
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.field === 'services'));
  });

  it('catches duplicate names', () => {
    const cfg = minimal();
    cfg.services[1]!.name = 'api-a';
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.message.includes('Duplicate service name')));
  });

  it('catches duplicate ports', () => {
    const cfg = minimal();
    cfg.services[1]!.port = 3000;
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.message.includes('Port 3000')));
  });

  it('catches invalid type', () => {
    const cfg = minimal();
    (cfg.services[0] as any).type = 'worker';
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.message.includes('Invalid type')));
  });

  it('catches negative phase', () => {
    const cfg = minimal();
    cfg.services[0]!.phase = -1;
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.message.includes('Invalid phase')));
  });

  it('catches invalid lazy.alwaysOn ref', () => {
    const cfg = { ...minimal(), lazy: { alwaysOn: ['nonexistent'] } };
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.message.includes('Unknown service: nonexistent')));
  });

  it('catches invalid traefik.routes ref', () => {
    const cfg = { ...minimal(), proxy: { provider: 'traefik', routes: { 'nonexistent': 'sub' } } };
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.message.includes('Unknown service: nonexistent')));
  });

  it('catches nonexistent cwd', () => {
    const cfg = minimal();
    cfg.services[0]!.cwd = 'this/does/not/exist';
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.message.includes('Directory not found')));
  });

  it('accepts valid http healthCheck', () => {
    const cfg = minimal();
    cfg.services[0]!.healthCheck = { type: 'http', path: '/healthz' };
    const errors = validateConfig(cfg, tmp);
    assert.equal(errors.filter(e => e.field.includes('healthCheck')).length, 0);
  });

  it('rejects invalid healthCheck.type', () => {
    const cfg = minimal();
    (cfg.services[0] as any).healthCheck = { type: 'grpc' };
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.message.includes('Invalid healthCheck.type')));
  });

  it('rejects healthCheck.path without leading slash', () => {
    const cfg = minimal();
    cfg.services[0]!.healthCheck = { type: 'http', path: 'healthz' };
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.message.includes('must start with "/"')));
  });

  it('accepts healthCheck.startPeriod as a non-negative number', () => {
    const cfg = minimal();
    cfg.services[0]!.healthCheck = { type: 'tcp', startPeriod: 30 };
    const errors = validateConfig(cfg, tmp);
    assert.equal(errors.filter(e => e.field.includes('startPeriod')).length, 0);
  });

  it('rejects negative healthCheck.startPeriod', () => {
    const cfg = minimal();
    cfg.services[0]!.healthCheck = { type: 'tcp', startPeriod: -1 };
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.message.includes('startPeriod must be a non-negative')));
  });

  it('accepts a valid errorPattern', () => {
    const cfg = minimal();
    cfg.services[0]!.errorPattern = '^error:';
    const errors = validateConfig(cfg, tmp);
    assert.equal(errors.filter(e => e.field.includes('errorPattern')).length, 0);
  });

  it('rejects invalid errorPattern regex', () => {
    const cfg = minimal();
    cfg.services[0]!.errorPattern = '(unclosed';
    const errors = validateConfig(cfg, tmp);
    assert.ok(errors.some(e => e.field.endsWith('errorPattern') && e.message.includes('Invalid regex')));
  });

  describe('profiles', () => {
    it('accepts valid profile referencing real services', () => {
      const cfg = minimal();
      cfg.profiles = { 'core': ['api-a', 'web-a'] };
      const errors = validateConfig(cfg, tmp);
      assert.equal(errors.filter(e => e.field.startsWith('profiles')).length, 0);
    });

    it('rejects profile pointing at unknown service', () => {
      const cfg = minimal();
      cfg.profiles = { 'core': ['nonexistent'] };
      const errors = validateConfig(cfg, tmp);
      assert.ok(errors.some(e => e.message.includes('Unknown service: nonexistent')));
    });

    it('rejects empty profile array', () => {
      const cfg = minimal();
      cfg.profiles = { 'core': [] };
      const errors = validateConfig(cfg, tmp);
      assert.ok(errors.some(e => e.message.includes('non-empty array')));
    });
  });

  describe('readyPattern', () => {
    it('accepts plain string pattern', () => {
      const cfg = minimal();
      cfg.services[0]!.readyPattern = 'ready in';
      const errors = validateConfig(cfg, tmp);
      assert.equal(errors.filter(e => e.field.includes('readyPattern')).length, 0);
    });

    it('accepts vim-style /pattern/flags', () => {
      const cfg = minimal();
      cfg.services[0]!.readyPattern = '/^api: \\d+$/i';
      const errors = validateConfig(cfg, tmp);
      assert.equal(errors.filter(e => e.field.includes('readyPattern')).length, 0);
    });

    it('rejects invalid regex', () => {
      const cfg = minimal();
      cfg.services[0]!.readyPattern = '(unclosed';
      const errors = validateConfig(cfg, tmp);
      assert.ok(errors.some(e => e.message.includes('Invalid regex')));
    });

    it('rejects empty string', () => {
      const cfg = minimal();
      cfg.services[0]!.readyPattern = '';
      const errors = validateConfig(cfg, tmp);
      assert.ok(errors.some(e => e.message.includes('non-empty string')));
    });
  });

  describe('preBuild / watchBuild', () => {
    it('accepts valid preBuild and watchBuild', () => {
      const cfg = minimal();
      cfg.services[0]!.preBuild = 'npm run build';
      cfg.services[0]!.watchBuild = 'npx tsup --watch';
      const errors = validateConfig(cfg, tmp);
      assert.equal(errors.filter(e => /preBuild|watchBuild/.test(e.field)).length, 0);
    });

    it('rejects empty preBuild', () => {
      const cfg = minimal();
      cfg.services[0]!.preBuild = '   ';
      const errors = validateConfig(cfg, tmp);
      assert.ok(errors.some(e => e.field.endsWith('preBuild') && e.message.includes('non-empty')));
    });

    it('rejects empty watchBuild', () => {
      const cfg = minimal();
      cfg.services[0]!.watchBuild = '';
      const errors = validateConfig(cfg, tmp);
      assert.ok(errors.some(e => e.field.endsWith('watchBuild') && e.message.includes('non-empty')));
    });
  });

  describe('external services', () => {
    it('accepts valid external with no healthCheck', () => {
      const cfg = minimal();
      cfg.external = [{ name: 'mongo', cmd: 'docker compose up -d' }];
      const errors = validateConfig(cfg, tmp);
      assert.equal(errors.filter(e => e.field.startsWith('external')).length, 0);
    });

    it('accepts valid external with tcp healthCheck and port', () => {
      const cfg = minimal();
      cfg.external = [{ name: 'redis', cmd: 'redis-server', port: 6379, healthCheck: { type: 'tcp' } }];
      const errors = validateConfig(cfg, tmp);
      assert.equal(errors.filter(e => e.field.startsWith('external')).length, 0);
    });

    it('rejects external with missing cmd', () => {
      const cfg = minimal();
      cfg.external = [{ name: 'bad', cmd: '' }];
      const errors = validateConfig(cfg, tmp);
      assert.ok(errors.some(e => e.field === 'external[bad].cmd'));
    });

    it('rejects duplicate external names', () => {
      const cfg = minimal();
      cfg.external = [
        { name: 'a', cmd: 'echo' },
        { name: 'a', cmd: 'echo' },
      ];
      const errors = validateConfig(cfg, tmp);
      assert.ok(errors.some(e => e.message.includes('Duplicate external')));
    });

    it('rejects healthCheck without port', () => {
      const cfg = minimal();
      cfg.external = [{ name: 'noport', cmd: 'foo', healthCheck: { type: 'tcp' } }];
      const errors = validateConfig(cfg, tmp);
      assert.ok(errors.some(e => e.message.includes('port is required')));
    });

    it('rejects http healthCheck.path without leading slash', () => {
      const cfg = minimal();
      cfg.external = [{ name: 'svc', cmd: 'foo', port: 9, healthCheck: { type: 'http', path: 'health' } }];
      const errors = validateConfig(cfg, tmp);
      assert.ok(errors.some(e => e.message.includes('must start with "/"')));
    });
  });
});

describe('collectWarnings', () => {
  it('returns empty when no services', () => {
    assert.deepEqual(collectWarnings({ name: 'X', services: [] }), []);
  });

  it('warns when extraEnv.PORT does not match svc.port', () => {
    const cfg = {
      name: 'X',
      services: [{
        name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api' as const,
        port: 3000, phase: 0,
        extraEnv: { PORT: '3001' },
      }],
    };
    const w = collectWarnings(cfg);
    assert.equal(w.length, 1);
    assert.equal(w[0]!.field, 'services[api].extraEnv.PORT');
    assert.ok(w[0]!.message.includes('does not match port=3000'));
  });

  it('does not warn when extraEnv.PORT matches port', () => {
    const cfg = {
      name: 'X',
      services: [{
        name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api' as const,
        port: 3000, phase: 0,
        extraEnv: { PORT: '3000' },
      }],
    };
    assert.deepEqual(collectWarnings(cfg), []);
  });

  it('does not warn when extraEnv.PORT is absent', () => {
    const cfg = {
      name: 'X',
      services: [{
        name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api' as const,
        port: 3000, phase: 0,
        extraEnv: { FOO: 'bar' },
      }],
    };
    assert.deepEqual(collectWarnings(cfg), []);
  });

  it('formatValidationWarnings renders the bullet style', () => {
    const out = formatValidationWarnings([
      { field: 'a', message: 'x' },
      { field: 'b', message: 'y' },
    ]);
    assert.ok(out.includes('⚠ a: x'));
    assert.ok(out.includes('⚠ b: y'));
  });
});
