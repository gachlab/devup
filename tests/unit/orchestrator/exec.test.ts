import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseExecArgs, crashedDuring, execOwnArgs, ownArgsFor, daemonChildArgs } from '../../../src/orchestrator/exec.js';
import { parseCliArgs } from '../../../src/config/cli.js';
import type { ServiceSnapshot } from '../../../src/control-plane/types.js';

function svc(over: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    name: 'app-api', status: 'running', health: 'up', port: 3000, originalPort: 3000,
    type: 'api', phase: 0, cmd: 'node', cwd: 'app/api', errors: 0, restarts: 0, crashes: 0,
    pid: 1, startedAt: 1, crashLog: null, debugPort: null, ...over,
  };
}

describe('parseExecArgs', () => {
  it('takes everything after -- as the command, flags included', () => {
    const f = parseExecArgs(['--start', '--', 'npx', 'playwright', 'test', '--workers', '4']);
    assert.deepEqual(f.command, ['npx', 'playwright', 'test', '--workers', '4']);
    assert.equal(f.start, true);
  });

  it('does not read the command\'s flags as its own', () => {
    // `--fail-on-crash` after `--` belongs to the command, not to devup.
    const f = parseExecArgs(['--', 'sh', '-c', 'echo hi', '--start', '--fail-on-crash']);
    assert.equal(f.start, false);
    assert.equal(f.failOnCrash, false);
    assert.deepEqual(f.command, ['sh', '-c', 'echo hi', '--start', '--fail-on-crash']);
  });

  it('reports no command when there is no --', () => {
    assert.deepEqual(parseExecArgs(['--start']).command, []);
  });

  it('reads --wait-timeout in seconds', () => {
    assert.equal(parseExecArgs(['--wait-timeout', '45', '--', 'true']).waitTimeoutMs, 45_000);
  });

  it('rejects a bad --wait-timeout rather than falling back to the default', () => {
    // Silently using 120 s is how someone spends an afternoon wondering why
    // their budget was ignored.
    assert.throws(() => parseExecArgs(['--wait-timeout', 'soon', '--', 'true']), /invalid --wait-timeout: soon/);
    assert.throws(() => parseExecArgs(['--wait-timeout', '0', '--', 'true']), /invalid --wait-timeout: 0/);
    assert.throws(() => parseExecArgs(['--wait-timeout', '--', 'true']), /invalid --wait-timeout/);
  });

  it('refuses --once, which would leave the daemon child booting and exiting', () => {
    // The child gets it through daemonChildArgs, runs runOnce, tears
    // everything down and exits — and runDetached waits out its full 90 s for
    // a pid file nobody is going to write.
    assert.throws(() => parseExecArgs(['--once', '--', 'true']), /--once cannot be combined with exec/);
  });

  it('defaults to 120s', () => {
    assert.equal(parseExecArgs(['--', 'true']).waitTimeoutMs, 120_000);
  });
});

describe('exec argv', () => {
  const raw = ['exec', '--profile', 'e2e', '--', 'npx', 'playwright', 'test', '--config', 'pw.ts', '--timeout', '30'];

  it('keeps the command\'s flags out of devup\'s own', () => {
    // The trap: parseCliArgs reads the whole argv, so without this
    // `--timeout 30` from Playwright becomes a 30-minute lazy idle timeout and
    // `--config pw.ts` a devup config path. Both silent.
    const naive = parseCliArgs(raw);
    assert.equal(naive.lazyTimeout, 30, 'precondition: the whole argv really does leak');
    assert.equal(naive.configPath, 'pw.ts');

    const own = parseCliArgs(execOwnArgs(raw));
    assert.equal(own.lazyTimeout, 10, 'devup keeps its own default');
    assert.equal(own.configPath, undefined);
    assert.equal(own.profile, 'e2e', 'devup still sees its own flags');
  });

  it('leaves argv alone when there is no --', () => {
    assert.deepEqual(execOwnArgs(['exec', '--start']), ['exec', '--start']);
  });

  it('drops the subcommand from the daemon child\'s argv', () => {
    // Otherwise the child is handed `exec -- npx playwright test` and
    // re-enters exec instead of becoming the daemon.
    assert.deepEqual(daemonChildArgs(raw), ['--profile', 'e2e']);
    assert.ok(!daemonChildArgs(raw).includes('exec'));
    assert.ok(!daemonChildArgs(raw).includes('playwright'));
  });

  it('keeps the command\'s --help and -v out of devup\'s short-circuit', () => {
    // devup scans for -h/-v before anything else and exits 0. Scanning the
    // whole argv made `devup exec -- npx playwright test --help` print devup's
    // usage and exit 0 without booting or running anything — which in CI reads
    // as a pass. `ownArgsFor` is what both that scan and parseCliArgs use, so
    // they cannot disagree.
    for (const flag of ['--help', '-h', '--version', '-v']) {
      const own = ownArgsFor(['exec', '--profile', 'e2e', '--', 'mytool', 'run', flag], 'exec');
      assert.ok(!own.includes(flag), `${flag} after -- belongs to the command`);
    }
    // devup's own still work.
    assert.ok(ownArgsFor(['exec', '--help'], 'exec').includes('--help'));
  });

  it('only stops at -- for exec; every other subcommand keeps its argv', () => {
    // `devup logs api -- whatever` has no command to protect, and truncating
    // there would silently drop flags from subcommands that legitimately use
    // `--`.
    const raw = ['ctl', 'restart', 'api', '--', '--timeout', '9'];
    assert.deepEqual(ownArgsFor(raw, 'ctl'), raw);
    assert.deepEqual(ownArgsFor(raw, null), raw);
    assert.deepEqual(ownArgsFor(raw, 'exec'), ['ctl', 'restart', 'api']);
  });

  it('passes the boot flags on to the child, and only those', () => {
    const args = daemonChildArgs(['exec', '--no-lazy', '--proxy', '--start', '--wait-timeout', '30', '--', 'true']);
    assert.deepEqual(args, ['--no-lazy', '--proxy', '--start', '--wait-timeout', '30']);
    // exec's own flags reaching the child is harmless — parseCliArgs ignores
    // what it does not know — but the command must never get there.
    assert.ok(!args.includes('true'));
  });
});

describe('crashedDuring', () => {
  it('catches a service that died and came back inside the window', () => {
    // It reads healthy at both ends; the counter is the only trace left.
    const before = new Map([['app-api', { status: 'running', crashes: 0 }]]);
    assert.deepEqual(crashedDuring(before, [svc({ crashes: 1, restarts: 1 })]), ['app-api']);
  });

  it('still catches it when a manual restart reset the restart budget', () => {
    // The reason the signal cannot be `restarts`: Restarter.restart and
    // startService both zero it, so a suite whose own setup calls
    // `devup ctl restart` would hide every crash that followed.
    const before = new Map([['app-api', { status: 'running', crashes: 2 }]]);
    const after = [svc({ crashes: 3, restarts: 0 })];
    assert.deepEqual(crashedDuring(before, after), ['app-api']);
  });

  it('catches one that crashed and stayed down', () => {
    const before = new Map([['app-api', { status: 'running', crashes: 3 }]]);
    const after = [svc({ status: 'crashed', health: 'down', crashes: 3, pid: null, startedAt: null })];
    assert.deepEqual(crashedDuring(before, after), ['app-api']);
  });

  it('does not re-blame one that was already crashed before the command ran', () => {
    const before = new Map([['app-api', { status: 'crashed', crashes: 3 }]]);
    const after = [svc({ status: 'crashed', health: 'down', crashes: 3, pid: null, startedAt: null })];
    assert.deepEqual(crashedDuring(before, after), []);
  });

  it('says nothing about a healthy run', () => {
    const before = new Map([['app-api', { status: 'running', crashes: 2 }]]);
    assert.deepEqual(crashedDuring(before, [svc({ crashes: 2 })]), []);
  });

  it('ignores stderr chatter — errors is not a crash signal', () => {
    // Plenty of healthy tools write to stderr; the Angular CLI does it
    // constantly. Counting it would make --fail-on-crash fire on nothing.
    const before = new Map([['app-api', { status: 'running', crashes: 0 }]]);
    assert.deepEqual(crashedDuring(before, [svc({ errors: 412 })]), []);
  });

  it('ignores a service that only appeared mid-run', () => {
    // A config reload added it; it was never in our window.
    const before = new Map([['app-api', { status: 'running', crashes: 0 }]]);
    const after = [svc(), svc({ name: 'newcomer', status: 'crashed', health: 'down', crashes: 1 })];
    assert.deepEqual(crashedDuring(before, after), []);
  });
});
