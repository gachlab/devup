import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { LinuxPlatform } from '../../../src/platform/linux.js';
import { DarwinPlatform } from '../../../src/platform/darwin.js';
import { Win32Platform } from '../../../src/platform/win32.js';

// Node throws any spawn errno outside EACCES/EAGAIN/EMFILE/ENFILE/ENOENT
// synchronously out of `exec()` / `execFile()` instead of handing it to the
// callback. That rejection was unhandled in the TUI's stats poll and killed
// devup (#156).
function ebadf(): never {
  throw Object.assign(new Error('spawn EBADF'), { code: 'EBADF', errno: -9, syscall: 'spawn' });
}

/** Replace a `child_process` function for the src modules' named imports too. */
function stub(name: 'exec' | 'execFile' | 'spawn', impl: () => never): void {
  mock.method(childProcess, name, impl);
  syncBuiltinESMExports();
}

describe('platform calls when the spawn itself throws', () => {
  afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });

  for (const [name, mk] of [
    ['LinuxPlatform', () => new LinuxPlatform()],
    ['DarwinPlatform', () => new DarwinPlatform()],
    ['Win32Platform', () => new Win32Platform()],
  ] as const) {
    it(`${name}.getProcessStats resolves an empty map`, async () => {
      stub('exec', ebadf);
      stub('execFile', ebadf);
      const result = await mk().getProcessStats([process.pid]);
      assert.equal(result.size, 0);
    });

    it(`${name}.openBrowser does not throw`, () => {
      stub('spawn', ebadf);
      assert.doesNotThrow(() => mk().openBrowser('http://localhost'));
    });
  }

  for (const [name, mk] of [
    ['LinuxPlatform', () => new LinuxPlatform()],
    ['DarwinPlatform', () => new DarwinPlatform()],
    ['Win32Platform', () => new Win32Platform()],
  ] as const) {
    it(`${name}.openBrowser survives the deferred ENOENT of a missing opener`, () => {
      // The other half: a missing xdg-open/open is not thrown but emitted as
      // 'error' a tick later, and an EventEmitter with no 'error' listener
      // throws it — an uncaught exception.
      const fake = Object.assign(new EventEmitter(), { unref: () => {} });
      let calls = 0;
      mock.method(childProcess, 'spawn', () => { calls++; return fake; });
      syncBuiltinESMExports();
      mk().openBrowser('http://localhost');
      assert.equal(calls, 1, 'the stub did not reach the src module');
      assert.doesNotThrow(() => fake.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })));
    });
  }

  it('the stub really reaches the src module (guards the test itself)', async () => {
    let calls = 0;
    stub('exec', (() => { calls++; ebadf(); }) as () => never);
    await new LinuxPlatform().getProcessStats([process.pid]);
    assert.equal(calls, 1);
  });
});
