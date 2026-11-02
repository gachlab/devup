import { exec, execFile, spawn } from 'node:child_process';
import type { Platform, ProcessStats } from './types.js';
import { sumProcessTrees, type ProcessRow } from './tree.js';

// `Created` as a FILETIME integer: Windows never updates ParentProcessId and
// recycles pids fast, so a child is only accepted if it started after its
// parent — see `sumProcessTrees`. An integer, because a CSV'd DateTime is
// formatted by the user's culture.
const WIN_PROCESS_QUERY =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,@{n='Created';e={$_.CreationDate.ToFileTimeUtc()}} | ConvertTo-Csv -NoTypeInformation";

/** `ConvertTo-Csv` output of WIN_PROCESS_QUERY: a header line, then quoted
 *  fields in that order. Times are in 100 ns units, the working set in bytes. */
export function parseCimCsv(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.trim().split(/\r?\n/).slice(1)) {
    const cols = line.split(',').map(c => c.trim().replace(/^"(.*)"$/, '$1'));
    if (cols.length < 5) continue;
    const pid = parseInt(cols[0]!, 10);
    const ppid = parseInt(cols[1]!, 10);
    if (Number.isNaN(pid)) continue;
    const created = Number(cols[5]);
    rows.push({
      pid, ppid: Number.isNaN(ppid) ? 0 : ppid,
      rss: Math.round((parseInt(cols[2]!, 10) || 0) / 1024),
      cpuSeconds: ((parseInt(cols[3]!, 10) || 0) + (parseInt(cols[4]!, 10) || 0)) / 10_000_000,
      ...(Number.isFinite(created) && cols[5] !== undefined && cols[5] !== '' ? { started: created } : {}),
    });
  }
  return rows;
}

export class Win32Platform implements Platform {
  readonly defaultTraefikHost = 'host.docker.internal';

  /** The sample in flight. PowerShell takes 1–3 s to start and query, longer
   *  than the 3 s poll on a loaded machine, and every `stats` client asks too:
   *  overlapping samples piled up ~70 MB processes and resolved out of order,
   *  which made the CPU baseline go backwards. Callers share one. */
  private inFlight: Promise<ProcessRow[]> | null = null;

  getProcessStats(pids: number[]): Promise<Map<number, ProcessStats>> {
    if (!pids.length) return Promise.resolve(new Map());
    this.inFlight ??= this.sample().finally(() => { this.inFlight = null; });
    return this.inFlight.then(rows => sumProcessTrees(rows, pids));
  }

  private sample(): Promise<ProcessRow[]> {
    return new Promise(resolve => {
      // CIM, not `wmic`: wmic is removed from Windows 11 24H2, which left the
      // CPU and Mem columns empty. Every process, so a service's tree — the
      // server under `cmd.exe` / an npm shim — can be summed.
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', WIN_PROCESS_QUERY],
        { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) return resolve([]);
          resolve(parseCimCsv(stdout));
        },
      );
    });
  }

  killTree(pid: number): void {
    try {
      exec(`taskkill /PID ${pid} /T /F`, { timeout: 5000 });
    } catch { /* already dead */ }
  }

  openBrowser(url: string): void {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
}
