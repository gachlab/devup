import { useEffect, useRef } from 'react';
import type { ProxyConfigProvider, ProxyOpts, ServiceState } from '../../proxy-config/types.js';
import type { ProcessState } from '../../process/types.js';

export function useProxySync(
  provider: ProxyConfigProvider | null,
  opts: ProxyOpts | null,
  states: Map<string, ProcessState>,
  enabled: boolean,
) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!provider || !opts || !enabled) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    const sync = () => {
      const svcStates = new Map<string, ServiceState>();
      for (const [name, st] of states) {
        svcStates.set(name, { port: st.svc.port, health: st.health, realPort: (st.svc as any).realPort });
      }
      const content = provider.generate(svcStates, opts);
      provider.write(content, opts);
    };

    sync();
    intervalRef.current = setInterval(sync, 3000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [provider, opts, enabled, states]);
}
