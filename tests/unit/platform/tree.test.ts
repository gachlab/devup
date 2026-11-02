import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { sumProcessTrees, parsePsTime } from '../../../src/platform/tree.js';
import { parsePsRows, LinuxPlatform } from '../../../src/platform/linux.js';
import { parseCimCsv } from '../../../src/platform/win32.js';

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

describe('sumProcessTrees', () => {
  it('sums a wrapper and everything under it, so `npm run dev` reports the server', () => {
    const rows = [
      { pid: 10, ppid: 1, rss: 30_000, cpuSeconds: 1 },   // npm
      { pid: 11, ppid: 10, rss: 400_000, cpuSeconds: 20 }, // node server
      { pid: 12, ppid: 11, rss: 100_000, cpuSeconds: 5 },  // its worker
      { pid: 99, ppid: 1, rss: 1, cpuSeconds: 1 },         // unrelated
    ];
    assert.deepEqual(sumProcessTrees(rows, [10]).get(10), { rss: 530_000, cpuSeconds: 26 });
  });

  it('survives a parent link that loops back (a recycled pid)', { timeout: 2000 }, () => {
    const rows = [{ pid: 5, ppid: 6, rss: 1, cpuSeconds: 0 }, { pid: 6, ppid: 5, rss: 2, cpuSeconds: 0 }];
    assert.deepEqual(sumProcessTrees(rows, [5]).get(5), { rss: 3, cpuSeconds: 0 });
  });

  it('leaves out a root it cannot see', () => {
    assert.equal(sumProcessTrees([], [42]).has(42), false);
  });
});

describe('parsePsTime', () => {
  it('reads a day prefix instead of returning NaN', () => {
    assert.equal(parsePsTime('1-02:03:04'), 86_400 + 2 * 3600 + 3 * 60 + 4);
  });
  it('reads HH:MM:SS, MM:SS and macOS M:SS.ss', () => {
    assert.equal(parsePsTime('01:00:00'), 3600);
    assert.equal(parsePsTime('02:30'), 150);
    assert.equal(parsePsTime('0:01.50'), 1.5);
  });
});

describe('row parsers', () => {
  it('parses ps -A -o pid=,ppid=,rss=,time=', () => {
    assert.deepEqual(parsePsRows('  10     1  30000 0:01.00\n  11    10 400000 1-00:00:00\n'), [
      { pid: 10, ppid: 1, rss: 30000, cpuSeconds: 1 },
      { pid: 11, ppid: 10, rss: 400000, cpuSeconds: 86400 },
    ]);
  });
  it('parses the CIM query CSV (Windows)', () => {
    const csv = '"ProcessId","ParentProcessId","WorkingSetSize","KernelModeTime","UserModeTime"\r\n"10","4","2048000","10000000","20000000"\r\n';
    assert.deepEqual(parseCimCsv(csv), [{ pid: 10, ppid: 4, rss: 2000, cpuSeconds: 3 }]);
  });
});

describe('LinuxPlatform.getProcessStats on a real tree', { skip: !isUnix }, () => {
  it('counts the memory of a child the root spawned', { timeout: 15000 }, async () => {
    const child = `const a = Buffer.alloc(80e6, 1); setInterval(() => a[0]++, 1000)`;
    const parent = spawn(process.execPath, ['-e',
      `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`,
    ], { detached: true, stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 1500));
      const tree = (await new LinuxPlatform().getProcessStats([parent.pid!])).get(parent.pid!);
      assert.ok(tree, 'root not sampled');
      // The root alone is a plain node process; the 80 MB live in the child.
      assert.ok(tree.rss > 100_000, `tree rss ${tree.rss} KB does not include the child`);
    } finally {
      try { process.kill(-parent.pid!, 'SIGKILL'); } catch { /* gone */ }
    }
  });
});
