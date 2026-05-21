import { useEffect, useRef } from 'react';
import type { ProxyConfigProvider, ProxyOpts, ServiceState } from '../../proxy-config/types.js';
import type { ProcessState } from '../../process/types.js';

export function useProxySync(
  provider: ProxyConfigProvider | null,
  opts: ProxyOpts | null,
  states: Map<string, ProcessState>,
  enabled: boolean,
) {
  const statesRef = useRef(states);
  const lastContentRef = useRef<string | null>(null);
  statesRef.current = states;

  useEffect(() => {
    if (!provider || !opts || !enabled) return;

    const sync = () => {
      const svcStates = new Map<string, ServiceState>();
      for (const [name, st] of statesRef.current) {
        svcStates.set(name, { port: st.svc.port, health: st.health, realPort: (st.svc as any).realPort });
      }
      const content = provider.generate(svcStates, opts);
      if (content === lastContentRef.current) return;
      lastContentRef.current = content;
      provider.write(content, opts);
    };

    sync();
    const id = setInterval(sync, 3000);
    return () => {
      clearInterval(id);
      lastContentRef.current = null;
    };
  }, [provider, opts, enabled]);
}
