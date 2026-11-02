import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, '..', '..', 'src', 'index.ts');

/** Run the real CLI with `--dry-run`, which resolves config, env and flags and
 *  prints what it would start without starting anything. */
function dryRun(cwd: string, args: string[]): { code: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete env.DEVUP_TEST_DB;
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), entry, '--dry-run', ...args], {
    cwd, env, encoding: 'utf8', timeout: 30_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'devup-precedence-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe('--env against the config envFile', () => {
  // A .js config, so the value is read at import time, exactly the way
  // `process.env.DB_URL` in a real config is.
  const config = `export default {
    name: 'env-precedence', envFile: '.env',
    services: [{ name: 'api', cwd: '.', cmd: 'node', args: ['server.js', process.env.DEVUP_TEST_DB ?? 'unset'], type: 'api', port: 41001, phase: 0 }],
  };`;

  it('--env wins over a key the config envFile also defines', () => {
    // The config's envFile used to be loaded into process.env first, and an env
    // file never overrides what is set: the suite ran against the dev database.
    const dir = project({
      'devup.config.js': config, 'package.json': '{"type":"module"}',
      '.env': 'DEVUP_TEST_DB=dev-db\n', '.env.test': 'DEVUP_TEST_DB=test-db\n',
    });
    const r = dryRun(dir, ['--env', '.env.test']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /server\.js test-db/);
    assert.doesNotMatch(r.out, /dev-db/);
  });

  it('without --env the config envFile is used', () => {
    const dir = project({
      'devup.config.js': config, 'package.json': '{"type":"module"}',
      '.env': 'DEVUP_TEST_DB=dev-db\n',
    });
    const r = dryRun(dir, []);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /server\.js dev-db/);
  });
});

describe('config settings that a flag can also set', () => {
  const lazyConfig = JSON.stringify({
    name: 'lazy-timeout', lazy: { alwaysOn: [], timeout: 25 },
    services: [{ name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api', port: 41002, phase: 0 }],
  });

  it('lazy.timeout from the config is used when --timeout is not given', () => {
    const r = dryRun(project({ 'devup.config.json': lazyConfig }), []);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /idle timeout 25m/);
  });

  it('--timeout beats lazy.timeout', () => {
    const r = dryRun(project({ 'devup.config.json': lazyConfig }), ['--timeout', '3']);
    assert.match(r.out, /idle timeout 3m/);
  });

  const proxyConfig = JSON.stringify({
    name: 'proxy-tls',
    proxy: { provider: 'traefik', routes: { api: 'api' }, tls: false, entrypoint: 'web' },
    services: [{ name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api', port: 41003, phase: 0 }],
  });

  it('proxy.tls: false and proxy.entrypoint from the config are honoured', () => {
    const r = dryRun(project({ 'devup.config.json': proxyConfig }), ['--proxy', '--no-lazy']);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /certResolver/);
    assert.match(r.out, /- web\b/);
  });

  it('--proxy-tls and --proxy-entrypoint beat the config', () => {
    const r = dryRun(project({ 'devup.config.json': proxyConfig }), ['--proxy', '--no-lazy', '--proxy-tls', '--proxy-entrypoint', 'websecure']);
    assert.match(r.out, /certResolver/);
    assert.match(r.out, /- websecure\b/);
  });
});

describe('--config from another directory', () => {
  it('resolves service cwd against the config, not the shell', () => {
    const dir = project({
      'stack/devup.config.json': JSON.stringify({
        name: 'elsewhere',
        services: [{ name: 'api', cwd: 'apps/api', cmd: 'node', args: [], type: 'api', port: 41004, phase: 0 }],
      }),
      'stack/apps/api/.keep': '',
    });
    const r = dryRun(dir, ['--config', 'stack/devup.config.json']);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Directory not found/);
  });
});

describe('CLI hygiene', () => {
  const ok = JSON.stringify({ name: 'h', services: [{ name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api', port: 41020, phase: 0 }] });

  it('an unknown option on the boot path is an error, not ignored', () => {
    const r = dryRun(project({ 'devup.config.json': ok }), ['--watch-confg']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /unknown option: --watch-confg/);
  });

  it('`config validate --json` answers in JSON even when the config does not load', () => {
    const dir = project({ 'devup.config.js': 'export default {', 'package.json': '{"type":"module"}' });
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), entry, 'config', 'validate', '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.valid, false);
    assert.match(parsed.errors[0], /failed to load config/);
  });
});
