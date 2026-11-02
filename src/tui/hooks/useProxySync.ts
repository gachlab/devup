import { useEffect, useRef } from 'react';
import type { ProxyConfigProvider, ProxyOpts } from '../../proxy-config/types.js';
import type { ProcessState } from '../../process/types.js';
import { ProxySync } from '../../proxy-config/sync.js';

/** Keeps the proxy config file in step while sync is enabled, and clears it
 *  when sync is turned off, so the proxy does not keep routing to a stack
 *  nobody is maintaining routes for. Clearing on exit is the App's teardown —
 *  `process.exit` does not run effect cleanups. */
export function useProxySync(
  provider: ProxyConfigProvider | null,
  opts: ProxyOpts | null,
  states: Map<string, ProcessState>,
  enabled: boolean,
  log?: (msg: string) => void,
): void {
  const statesRef = useRef(states);
  statesRef.current = states;
  const logRef = useRef(log);
  logRef.current = log;

  useEffect(() => {
    if (!provider || !opts || !enabled) return;
    const sync = new ProxySync(provider, opts, () => statesRef.current, msg => logRef.current?.(msg));
    sync.sync();
    const id = setInterval(() => sync.sync(), 3000);
    return () => {
      clearInterval(id);
      sync.clear();
    };
  }, [provider, opts, enabled]);
}
