import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveSpawnCommand, escapeArgument } from '../../../src/platform/command.js';

const BIN = '/bin-dir';
const winEnv = { PATH: BIN, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
const existsOnly = (...files: string[]) => (p: string) => files.includes(p);

describe('resolveSpawnCommand', () => {
  it('en POSIX no toca nada', () => {
    assert.deepEqual(
      resolveSpawnCommand('npx', ['vite', '--port', '4200'], { platform: 'linux' }),
      { file: 'npx', args: ['vite', '--port', '4200'] },
    );
  });

  it('en Windows un shim .cmd pasa por cmd.exe (CVE-2024-27980)', () => {
    const r = resolveSpawnCommand('npm', ['install'], {
      platform: 'win32', env: winEnv, cwd: '/proj', exists: existsOnly(join(BIN, 'npm.CMD')),
    });
    assert.equal(r.file, winEnv.ComSpec);
    assert.equal(r.windowsVerbatimArguments, true);
    assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(r.args[3], `"${join(BIN, 'npm.CMD')} ^^^"install^^^""`);
  });

  it('en Windows un .exe se lanza directo', () => {
    const r = resolveSpawnCommand('node', ['-e', 'console.log(1)'], {
      platform: 'win32', env: winEnv, cwd: '/proj', exists: existsOnly(join(BIN, 'node.EXE')),
    });
    assert.deepEqual(r, { file: 'node', args: ['-e', 'console.log(1)'] });
  });

  it('en Windows un comando que no existe se lanza directo, para que llegue el ENOENT', () => {
    const r = resolveSpawnCommand('nope', ['x'], { platform: 'win32', env: winEnv, cwd: '/proj', exists: () => false });
    assert.deepEqual(r, { file: 'nope', args: ['x'] });
  });

  it('un .cmd del cwd gana al del PATH, como en cmd.exe', () => {
    const local = join('/proj', 'run.CMD');
    const r = resolveSpawnCommand('run', [], {
      platform: 'win32', env: winEnv, cwd: '/proj', exists: existsOnly(local, join(BIN, 'run.CMD')),
    });
    assert.ok(r.args[3]!.startsWith(`"${local} `) || r.args[3] === `"${local}"`, r.args[3]);
  });
});

describe('escapeArgument', () => {
  it('cita y escapa metacaracteres de cmd.exe', () => {
    assert.equal(escapeArgument('a b', false), '^"a^ b^"');
    assert.equal(escapeArgument('a&b', false), '^"a^&b^"');
  });

  it('escapa dos veces para un shim, que vuelve a expandir %*', () => {
    assert.equal(escapeArgument('50%', true), '^^^"50^^^%^^^"');
  });

  it('dobla las barras que preceden a una comilla y las finales', () => {
    assert.equal(escapeArgument('say "hi"', false), '^"say^ \\^"hi\\^"^"');
    assert.equal(escapeArgument('C:\\dir\\', false), '^"C:\\dir\\\\^"');
  });
});
