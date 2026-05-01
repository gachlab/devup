export interface ProcessStats {
  rss: number;        // KB
  cpuSeconds: number;
}

export interface Platform {
  getProcessStats(pids: number[]): Promise<Map<number, ProcessStats>>;
  killTree(pid: number, signal?: NodeJS.Signals): void;
  openBrowser(url: string): void;
  readonly defaultTraefikHost: string;
}
