import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LinuxPlatform } from '../../../src/platform/linux.js';

describe('LinuxPlatform', () => {
  const platform = new LinuxPlatform();

  it('implements Platform interface', () => {
    assert.equal(typeof platform.getProcessStats, 'function');
    assert.equal(typeof platform.killTree, 'function');
    assert.equal(typeof platform.openBrowser, 'function');
    assert.equal(platform.defaultTraefikHost, '172.17.0.1');
  });

  it('getProcessStats returns empty map for empty pids', async () => {
    const result = await platform.getProcessStats([]);
    assert.equal(result.size, 0);
  });

  it('getProcessStats returns map for current process', async () => {
    if (process.platform !== 'linux') return; // skip on other OS
    const result = await platform.getProcessStats([process.pid]);
    // Our own process should be found
    assert.ok(result.has(process.pid));
    const stats = result.get(process.pid)!;
    assert.ok(stats.rss > 0);
    assert.ok(stats.cpuSeconds >= 0);
  });

  it('getProcessStats handles nonexistent pids gracefully', async () => {
    if (process.platform !== 'linux') return;
    const result = await platform.getProcessStats([999999]);
    // Should not throw, just return empty or missing entry
    assert.ok(result.size === 0 || !result.has(999999));
  });
});
