import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs, filterServices, USAGE, nothingToRun } from '../../../src/config/cli.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const svc = (name: string, type: 'api' | 'web' = 'api'): ServiceConfig => ({
  name, cwd: '.', cmd: 'node', args: [], type, port: 3000, phase: 0,
});

describe('parseCliArgs', () => {
  it('defaults', () => {
    const args = parseCliArgs([]);
    assert.equal(args.lazy, true);
    assert.equal(args.lazyTimeout, 10);
    assert.equal(args.proxy, false);
    assert.equal(args.proxyTls, true);
    assert.equal(args.proxyEntrypoint, 'websecure');
  });

  it('--config', () => assert.equal(parseCliArgs(['--config', 'my.ts']).configPath, 'my.ts'));
  it('--only', () => assert.equal(parseCliArgs(['--only', 'apis']).only, 'apis'));
  it('--skip', () => assert.deepEqual(parseCliArgs(['--skip', 'a,b']).skip, ['a', 'b']));
  it('--services', () => assert.deepEqual(parseCliArgs(['--services', 'x,y']).services, ['x', 'y']));
  it('--no-lazy', () => assert.equal(parseCliArgs(['--no-lazy']).lazy, false));
  it('--timeout', () => assert.equal(parseCliArgs(['--timeout', '20']).lazyTimeout, 20));
  it('--proxy flags', () => {
    const args = parseCliArgs(['--proxy', '--proxy-host', '127.0.0.1', '--no-proxy-tls', '--proxy-entrypoint', 'web']);
    assert.equal(args.proxy, true);
    assert.equal(args.proxyHost, '127.0.0.1');
    assert.equal(args.proxyTls, false);
    assert.equal(args.proxyEntrypoint, 'web');
  });

  it('USAGE includes service-selection, lazy, proxy, CI, and log-file sections', () => {
    assert.ok(USAGE.includes('Service selection'));
    assert.ok(USAGE.includes('Lazy mode'));
    assert.ok(USAGE.includes('Reverse proxy'));
    assert.ok(USAGE.includes('CI / scripting'));
    assert.ok(USAGE.includes('Log files'));
    assert.ok(USAGE.includes('--version'));
    assert.ok(USAGE.includes('--help'));
  });

  it('--dry-run', () => assert.equal(parseCliArgs(['--dry-run']).dryRun, true));
  it('--once + --once-timeout', () => {
    const a = parseCliArgs(['--once', '--once-timeout', '30']);
    assert.equal(a.once, true);
    assert.equal(a.onceTimeout, 30);
  });
  // 120, not 90: --once waits for web services too now, and a cold `ng serve`
  // is the slowest thing in a typical stack by a wide margin.
  it('--once default timeout is 120s', () => assert.equal(parseCliArgs(['--once']).onceTimeout, 120));
  it('--no-log-file disables log file', () => assert.equal(parseCliArgs(['--no-log-file']).logFile, false));
  it('--log-dir sets custom path', () => assert.equal(parseCliArgs(['--log-dir', '/tmp/devup-logs']).logDir, '/tmp/devup-logs'));
  it('log file enabled by default', () => assert.equal(parseCliArgs([]).logFile, true));

  it('--watch-config opts into hot reload', () => {
    assert.equal(parseCliArgs(['--watch-config']).watchConfig, true);
    assert.equal(parseCliArgs([]).watchConfig, false);
  });

  it('--kill-port-conflicts opts into auto-kill', () => {
    assert.equal(parseCliArgs(['--kill-port-conflicts']).killPortConflicts, true);
    assert.equal(parseCliArgs([]).killPortConflicts, false);
  });
});

describe('filterServices', () => {
  const all = [svc('app-api'), svc('app-web', 'web'), svc('tasks-api'), svc('staff-web', 'web')];

  it('returns all with no filters', () => {
    const result = filterServices(all, parseCliArgs([]));
    assert.equal(result.length, 4);
  });

  it('--only apis', () => {
    const result = filterServices(all, parseCliArgs(['--only', 'apis']));
    assert.ok(result.every(s => s.type === 'api'));
  });

  it('--only webs', () => {
    const result = filterServices(all, parseCliArgs(['--only', 'webs']));
    assert.ok(result.every(s => s.type === 'web'));
  });

  it('--skip', () => {
    const result = filterServices(all, parseCliArgs(['--skip', 'tasks-api']));
    assert.equal(result.length, 3);
    assert.ok(!result.find(s => s.name === 'tasks-api'));
  });

  it('--services explicit', () => {
    const result = filterServices(all, parseCliArgs(['--services', 'app-api,app-web']));
    assert.equal(result.length, 2);
  });

  describe('--profile', () => {
    const profiles = { 'check-in': ['app-api', 'app-web'] };

    it('parses --profile flag', () => {
      assert.equal(parseCliArgs(['--profile', 'check-in']).profile, 'check-in');
    });

    it('filters by profile members', () => {
      const result = filterServices(all, parseCliArgs(['--profile', 'check-in']), { profiles });
      assert.equal(result.length, 2);
      assert.deepEqual(result.map(s => s.name).sort(), ['app-api', 'app-web']);
    });

    it('composes with --skip', () => {
      const result = filterServices(all, parseCliArgs(['--profile', 'check-in', '--skip', 'app-web']), { profiles });
      assert.equal(result.length, 1);
      assert.equal(result[0]!.name, 'app-api');
    });

    it('throws on unknown profile name with helpful hint', () => {
      assert.throws(
        () => filterServices(all, parseCliArgs(['--profile', 'mystery']), { profiles }),
        /Unknown profile: "mystery".*Available: check-in/,
      );
    });

    it('throws when no profiles defined and one is requested', () => {
      assert.throws(
        () => filterServices(all, parseCliArgs(['--profile', 'mystery']), {}),
        /No profiles defined/,
      );
    });

    it('takes precedence over --services when both passed', () => {
      const result = filterServices(all, parseCliArgs(['--profile', 'check-in', '--services', 'tasks-api']), { profiles });
      assert.deepEqual(result.map(s => s.name).sort(), ['app-api', 'app-web']);
    });
  });
});

describe('--env and --json', () => {
  it('reads --env', () => {
    assert.equal(parseCliArgs(['--env', '.env.e2e']).envFile, '.env.e2e');
    assert.equal(parseCliArgs([]).envFile, undefined);
  });

  it('reads the --env=path form, which is the likely typo', () => {
    // `--env-file=x` is the spelling node users have in their fingers, so the
    // near-miss must not be swallowed: falling back to `.env` in silence means
    // running the suite against the development database.
    assert.equal(parseCliArgs(['--once', '--env=.env.e2e']).envFile, '.env.e2e');
  });

  it('does not swallow a following flag as the path', () => {
    // `--env --json` used to set the path to "--json" and consume the flag
    // with it, so the run both lost its JSON output and died on a file called
    // "--json".
    const r = parseCliArgs(['--once', '--env', '--json']);
    assert.equal(r.envFile, '');
    assert.equal(r.onceJson, true, 'the flag it ate must survive');
  });

  it('distinguishes a bare --env from no flag at all', () => {
    // Both used to come out `undefined`, so a bare `--env` fell back to `.env`
    // without a word. index.ts rejects the empty string.
    assert.equal(parseCliArgs(['--once', '--env']).envFile, '');
    assert.equal(parseCliArgs(['--once']).envFile, undefined);
  });

  it('is not spelled --env-file, which node takes for itself', () => {
    // Node claims `--env-file` from anywhere in argv, script arguments
    // included: with the file present it loads it and moves on, and with it
    // absent it exits `node: X: not found` before devup runs at all. The
    // obvious name is unusable, so the test says so out loud.
    assert.equal(parseCliArgs(['--env-file', '.env.e2e']).envFile, undefined);
  });

  it('reads --json for the --once summary', () => {
    assert.equal(parseCliArgs(['--once', '--json']).onceJson, true);
    assert.equal(parseCliArgs(['--once']).onceJson, false);
  });
});

describe('--instance', () => {
  it('reads a name', () => {
    assert.equal(parseCliArgs(['down', '--instance', 'e2e']).instance, 'e2e');
    assert.equal(parseCliArgs(['down']).instance, undefined);
  });

  it('reads the --instance=name form', () => {
    // Silently dropped, it stopped the default daemon — the same silent
    // wrong-stack failure the bare-flag guard below exists to prevent.
    assert.equal(parseCliArgs(['down', '--instance=e2e']).instance, 'e2e');
    assert.equal(parseCliArgs(['down', '--instance=']).instance, '');
  });

  it('distinguishes a bare --instance from no flag at all', () => {
    // The sharp one: a value forgotten, or eaten by an empty shell variable,
    // used to fall through to the default stack — so `devup down --instance`
    // stopped the daemon you were working in.
    assert.equal(parseCliArgs(['down', '--instance']).instance, '');
    assert.equal(parseCliArgs(['down', '--instance', '--json']).instance, '');
    assert.equal(parseCliArgs(['down', '--instance', '--json']).onceJson, true, 'the flag it would have eaten survives');
  });
});

describe('--remote', () => {
  it('reads the blanket form', () => {
    assert.equal(parseCliArgs(['--remote', 'qa']).remote, 'qa');
  });

  it('reads the =value form', () => {
    assert.equal(parseCliArgs(['--remote=qa']).remote, 'qa');
  });

  it('reads the explicit service list', () => {
    assert.equal(parseCliArgs(['--remote', 'qa:app-api,rules-api']).remote, 'qa:app-api,rules-api');
  });

  it('reports a bare --remote as the empty string, not as absent', () => {
    // index.ts rejects the empty string. Falling through to `undefined` would
    // be an ordinary local boot with the services it was meant to cover simply
    // missing — a frontend failing to connect, minutes from the cause.
    assert.equal(parseCliArgs(['--remote']).remote, '');
  });

  it('does not swallow the following flag as its value', () => {
    const args = parseCliArgs(['--remote', '--profile', 'app']);
    assert.equal(args.remote, '');
    assert.equal(args.profile, 'app');
  });

  it('is absent when the flag is not given', () => {
    assert.equal(parseCliArgs(['--profile', 'app']).remote, undefined);
  });
});

describe('nothingToRun', () => {
  it('is true for a plain local boot with nothing selected', () => {
    assert.equal(nothingToRun([], { remote: undefined }), true);
  });

  it('is false when something was selected', () => {
    assert.equal(nothingToRun([{}], { remote: undefined }), false);
  });

  it('is false with --remote, where an empty local selection is the point', () => {
    // The whole stack served from the environment, no processes here — the
    // first thing anyone tries to check whether an environment answers, and
    // the guard used to reject it.
    assert.equal(nothingToRun([], { remote: 'qa' }), false);
    assert.equal(nothingToRun([], { remote: 'qa:app-api' }), false);
  });

  it('still rejects a bare --remote with nothing selected', () => {
    // index.ts rejects the empty string separately, but this must not be the
    // thing that lets it through: `--remote` with no value is a mistake, and
    // treating it as "remote mode" would boot an empty stack in silence.
    assert.equal(nothingToRun([], { remote: '' }), true);
  });
});
