import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform } from '../../../src/platform/detect.js';

describe('detectPlatform', () => {
  it('returns a platform for current OS', async () => {
    const platform = await detectPlatform();
    assert.ok(platform);
    assert.equal(typeof platform.getProcessStats, 'function');
    assert.equal(typeof platform.killTree, 'function');
    assert.equal(typeof platform.openBrowser, 'function');
    assert.equal(typeof platform.defaultTraefikHost, 'string');
  });

  it('has correct traefik host for current platform', async () => {
    const platform = await detectPlatform();
    if (process.platform === 'linux') {
      assert.equal(platform.defaultTraefikHost, '172.17.0.1');
    } else if (process.platform === 'darwin') {
      assert.equal(platform.defaultTraefikHost, 'host.docker.internal');
    } else if (process.platform === 'win32') {
      assert.equal(platform.defaultTraefikHost, 'host.docker.internal');
    }
  });
});
