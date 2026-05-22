import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/** Returns the current terminal row count, re-rendering on resize.
 *  Falls back to 40 when stdout isn't available (non-TTY mode). */
export function useTerminalSize(): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout?.rows ?? 40);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setRows(stdout.rows ?? 40);
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  return rows;
}
