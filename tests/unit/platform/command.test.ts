import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveSpawnCommand, escapeArgument, shellCommand } from '../../../src/platform/command.js';

const BIN = '/bin-dir';
const winEnv = { PATH: BIN, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
const existsOnly = (...files: string[]) => (p: string) => files.includes(p);

describe('resolveSpawnCommand', () => {
  it('is the identity on POSIX', () => {
    assert.deepEqual(
      resolveSpawnCommand('npx', ['vite', '--port', '4200'], { platform: 'linux' }),
      { file: 'npx', args: ['vite', '--port', '4200'] },
    );
  });

  it('routes a .cmd shim through cmd.exe on Windows (CVE-2024-27980)', () => {
    const r = resolveSpawnCommand('npm', ['install'], {
      platform: 'win32', env: winEnv, cwd: '/proj', exists: existsOnly(join(BIN, 'npm.CMD')),
    });
    assert.equal(r.file, winEnv.ComSpec);
    assert.equal(r.windowsVerbatimArguments, true);
    assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(r.args[3], `"${join(BIN, 'npm.CMD')} ^^^"install^^^""`);
  });

  it('spawns a .exe directly on Windows', () => {
    const r = resolveSpawnCommand('node', ['-e', 'console.log(1)'], {
      platform: 'win32', env: winEnv, cwd: '/proj', exists: existsOnly(join(BIN, 'node.EXE')),
    });
    assert.deepEqual(r, { file: 'node', args: ['-e', 'console.log(1)'] });
  });

  it('spawns a missing command directly on Windows, so the ENOENT still surfaces', () => {
    const r = resolveSpawnCommand('nope', ['x'], { platform: 'win32', env: winEnv, cwd: '/proj', exists: () => false });
    assert.deepEqual(r, { file: 'nope', args: ['x'] });
  });

  it('prefers a .cmd in cwd over one on PATH, like cmd.exe', () => {
    const local = join('/proj', 'run.CMD');
    const r = resolveSpawnCommand('run', [], {
      platform: 'win32', env: winEnv, cwd: '/proj', exists: existsOnly(local, join(BIN, 'run.CMD')),
    });
    assert.ok(r.args[3]!.startsWith(`"${local} `) || r.args[3] === `"${local}"`, r.args[3]);
  });
});

describe('escapeArgument', () => {
  it('quotes and escapes cmd.exe metacharacters', () => {
    assert.equal(escapeArgument('a b', false), '^"a^ b^"');
    assert.equal(escapeArgument('a&b', false), '^"a^&b^"');
  });

  it('escapes twice for a shim, which expands %* again', () => {
    assert.equal(escapeArgument('50%', true), '^^^"50^^^%^^^"');
  });

  it('doubles backslashes before a quote and trailing ones', () => {
    assert.equal(escapeArgument('say "hi"', false), '^"say^ \\^"hi\\^"^"');
    assert.equal(escapeArgument('C:\\dir\\', false), '^"C:\\dir\\\\^"');
  });
});

describe('resolveSpawnCommand: real-world PATH', () => {
  it('strips quotes from a PATH entry', () => {
    const dir = 'C:/Program Files/nodejs';
    const r = resolveSpawnCommand('npm', ['-v'], {
      platform: 'win32', env: { ...winEnv, PATH: `"${dir}";${BIN}` }, cwd: '/proj',
      exists: existsOnly(join(dir, 'npm.CMD')),
    });
    assert.equal(r.windowsVerbatimArguments, true, 'without stripping the quotes the shim is not found');
  });

  it('never picks the extensionless `npm` Node installs next to npm.cmd', () => {
    const r = resolveSpawnCommand('npm', [], {
      platform: 'win32', env: winEnv, cwd: '/proj',
      exists: existsOnly(join(BIN, 'npm'), join(BIN, 'npm.CMD')),
    });
    assert.equal(r.windowsVerbatimArguments, true);
  });

  it('a dot in the name is not an extension: my.tool finds my.tool.cmd', () => {
    const r = resolveSpawnCommand('my.tool', [], {
      platform: 'win32', env: winEnv, cwd: '/proj', exists: existsOnly(join(BIN, 'my.tool.CMD')),
    });
    assert.equal(r.windowsVerbatimArguments, true);
  });
});

describe('shellCommand', () => {
  it('uses sh -c on POSIX', () => {
    assert.deepEqual(shellCommand('a && b', {}, 'linux'), { file: 'sh', args: ['-c', 'a && b'] });
  });
  it('uses the env ComSpec on Windows, like services do', () => {
    assert.deepEqual(shellCommand('a && b', { ComSpec: 'D:/cmd.exe' }, 'win32'), { file: 'D:/cmd.exe', args: ['/d', '/c', 'a && b'] });
  });
});
