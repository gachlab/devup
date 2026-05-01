import { spawn } from 'node:child_process';
import { LinuxPlatform } from './linux.js';

export class DarwinPlatform extends LinuxPlatform {
  override readonly defaultTraefikHost = 'host.docker.internal';

  override openBrowser(url: string): void {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}
