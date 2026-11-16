import { LinuxPlatform } from './linux.js';
import { spawnDetached } from './safe-spawn.js';

export class DarwinPlatform extends LinuxPlatform {
  override readonly defaultTraefikHost = 'host.docker.internal';

  override openBrowser(url: string): void {
    spawnDetached('open', [url]);
  }
}
