import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectSubcommand, runHelp, runLogs, runStatus, misplacedSubcommand, positionalArgs } from '../../../src/orchestrator/subcommands.js';
import type { DevStackConfig } from '../../../src/config/types.js';

function mkConfig(over: Partial<DevStackConfig> = {}): DevStackConfig {
  return {
    name: 'Test',
    services: [
      { name: 'api', cwd: 'api', cmd: 'node', args: [], type: 'api', port: 19990, phase: 0 },
      { name: 'web', cwd: 'web', cmd: 'node', args: [], type: 'web', port: 19991, phase: 1 },
    ],
    ...over,
  };
}

describe('detectSubcommand', () => {
  it('returns the name when known', () => {
    assert.equal(detectSubcommand(['logs', 'api']), 'logs');
    assert.equal(detectSubcommand(['install']), 'install');
    assert.equal(detectSubcommand(['status']), 'status');
    assert.equal(detectSubcommand(['help']), 'help');
  });

  it('returns null when first arg is a flag', () => {
    assert.equal(detectSubcommand(['--dry-run']), null);
    assert.equal(detectSubcommand(['--config', 'x.ts']), null);
  });

  it('returns null when empty or unknown', () => {
    assert.equal(detectSubcommand([]), null);
    assert.equal(detectSubcommand(['mystery']), null);
  });
});

describe('runHelp', () => {
  it('lists all subcommands when called with no arg', () => {
    const lines: string[] = [];
    const code = runHelp([], { out: l => lines.push(l) });
    assert.equal(code, 0);
    const out = lines.join('\n');
    assert.ok(out.includes('devup logs'));
    assert.ok(out.includes('devup install'));
    assert.ok(out.includes('devup status'));
  });

  it('shows detailed help for logs', () => {
    const lines: string[] = [];
    runHelp(['logs'], { out: l => lines.push(l) });
    const out = lines.join('\n');
    assert.ok(out.includes('logs <service>'));
    assert.ok(out.includes('--follow'));
  });
});

describe('runStatus', () => {
  it('prints a table for every service', async () => {
    const lines: string[] = [];
    const config = mkConfig();
    const code = await runStatus({
      config, baseCwd: process.cwd(), env: {}, out: l => lines.push(l),
    });
    assert.equal(code, 0);
    const out = lines.join('\n');
    assert.ok(out.includes('api'));
    assert.ok(out.includes('web'));
    assert.ok(out.includes('Health'));
    // Both services should report down (nothing listening on those ports)
    assert.ok(out.includes('down'));
  });
});

describe('runLogs', () => {
  it('errors on unknown service', async () => {
    const lines: string[] = [];
    const code = await runLogs(['mystery'], {
      config: mkConfig(), baseCwd: process.cwd(), env: {}, out: l => lines.push(l),
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('Unknown service')));
  });

  it('errors when no service argument', async () => {
    const lines: string[] = [];
    const code = await runLogs([], {
      config: mkConfig(), baseCwd: process.cwd(), env: {}, out: l => lines.push(l),
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('usage:')));
  });

  it('reads an existing log file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devup-logs-cmd-'));
    try {
      const dir = join(root, 'Test');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'api.log'), '2026-01-01T00:00:00Z hello\n2026-01-01T00:00:01Z world\n');
      const lines: string[] = [];
      const code = await runLogs(['api'], {
        config: mkConfig(), baseCwd: process.cwd(), env: {},
        logDir: root,
        out: l => lines.push(l),
      });
      assert.equal(code, 0);
      assert.ok(lines.some(l => l.includes('hello')));
      assert.ok(lines.some(l => l.includes('world')));
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe('misplacedSubcommand', () => {
  it('says nothing when the subcommand is where it belongs', () => {
    assert.equal(misplacedSubcommand(['up', '-d', '--instance', 'e2e']), null);
    assert.equal(misplacedSubcommand(['ctl', 'status']), null);
  });

  it('catches a subcommand written after the flags', () => {
    // This used to be ignored in silence and the TUI rendered instead, so
    // `devup --instance e2e up -d` sat there while its user waited for a
    // daemon that was never coming.
    assert.equal(misplacedSubcommand(['--instance', 'e2e', 'up', '-d']), 'up');
    assert.equal(misplacedSubcommand(['--config', './x.ts', 'down']), 'down');
  });

  it('does not mistake a flag\'s value for a subcommand', () => {
    // `--profile status` names a profile; `--services logs` names services.
    assert.equal(misplacedSubcommand(['--profile', 'status']), null);
    assert.equal(misplacedSubcommand(['--services', 'logs']), null);
    assert.equal(misplacedSubcommand(['--instance', 'up']), null);
  });

  it('stops at --, so exec\'s command is never scanned', () => {
    // `devup exec -- npm run status` must not be read as a misplaced `status`.
    assert.equal(misplacedSubcommand(['exec', '--', 'npm', 'run', 'status']), null);
    assert.equal(misplacedSubcommand(['--instance', 'e2e', '--', 'up']), null);
  });

  it('says nothing about a plain TUI invocation', () => {
    assert.equal(misplacedSubcommand(['--no-lazy', '--proxy']), null);
    assert.equal(misplacedSubcommand([]), null);
  });
});

describe('positionalArgs', () => {
  it('skips a flag and the value it takes', () => {
    // One bug, over and over: a flag's value read as a positional. It has been
    // `--profile status` taken for the status command, `--config ./x.ts api`
    // taken for a service, and `--instance e2e api` taken for one — which
    // broke every ctl command against a named instance at once.
    assert.deepEqual(positionalArgs(['start', '--instance', 'e2e', 'api'], 1), ['api']);
    assert.deepEqual(positionalArgs(['start', '--config', './devup.config.ts', 'api'], 1), ['api']);
    assert.deepEqual(positionalArgs(['logs', '--since', '5m', 'api'], 1), ['api']);
    assert.deepEqual(positionalArgs(['debug', '--port', '9230', 'api'], 1), ['api']);
  });

  it('is unbothered by a value-taking flag with no value', () => {
    assert.deepEqual(positionalArgs(['wait', '--timeout', '--json', 'api'], 1), ['api']);
    assert.deepEqual(positionalArgs(['start', 'api', '--profile'], 1), ['api']);
  });

  it('drops bare flags', () => {
    assert.deepEqual(positionalArgs(['start', '--all', '--json', 'api'], 1), ['api']);
    assert.deepEqual(positionalArgs(['debug', '--off', 'api'], 1), ['api']);
  });

  it('keeps every positional, in order', () => {
    assert.deepEqual(positionalArgs(['start', 'a', 'b', 'c'], 1), ['a', 'b', 'c']);
  });

  it('stops at --, so exec\'s command is never scanned', () => {
    assert.deepEqual(positionalArgs(['exec', '--instance', 'e2e', '--', 'npm', 'run', 'x'], 1), []);
  });

  it('honours the start index', () => {
    assert.deepEqual(positionalArgs(['ctl', 'start', 'api'], 1), ['start', 'api']);
    assert.deepEqual(positionalArgs(['ctl', 'start', 'api'], 2), ['api']);
  });
});
