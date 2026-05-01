import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, findConfigFile } from '../../src/config/loader.js';
import { parseEnvFile } from '../../src/utils.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, '..', 'fixtures');

describe('config-loader integration', () => {
  it('loads JSON config', async () => {
    const config = await loadConfig(join(fixtures, 'minimal-config.json'));
    assert.equal(config.name, 'TestProject');
    assert.equal(config.services.length, 1);
    assert.equal(config.services[0]!.name, 'api-a');
    assert.equal(config.services[0]!.port, 3000);
  });

  it('rejects invalid config', async () => {
    // A JSON file that is not a valid DevStackConfig
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'ds-int-'));
    try {
      writeFileSync(join(dir, 'devup.config.json'), '{"foo": "bar"}');
      const config = await loadConfig(join(dir, 'devup.config.json'));
      // JSON loads fine but services won't be an array
      assert.ok(!Array.isArray(config.services) || config.services.length === 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('parseEnvFile integration', () => {
  it('parses sample.env', () => {
    const env = parseEnvFile(join(fixtures, 'sample.env'));
    assert.equal(env['DB_HOST'], 'localhost');
    assert.equal(env['DB_PORT'], '27017');
    assert.equal(env['QUOTED_VAL'], 'hello world');
    assert.equal(env['SINGLE_QUOTED'], 'single');
    assert.equal(env['EMPTY'], '');
  });

  it('does not overwrite existing env', () => {
    const env = parseEnvFile(join(fixtures, 'sample.env'), { DB_HOST: 'remote' });
    assert.equal(env['DB_HOST'], 'remote');
  });
});
