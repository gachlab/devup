import type { Platform } from './types.js';

export async function detectPlatform(): Promise<Platform> {
  switch (process.platform) {
    case 'linux': {
      const { LinuxPlatform } = await import('./linux.js');
      return new LinuxPlatform();
    }
    case 'darwin': {
      const { DarwinPlatform } = await import('./darwin.js');
      return new DarwinPlatform();
    }
    case 'win32': {
      const { Win32Platform } = await import('./win32.js');
      return new Win32Platform();
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}
