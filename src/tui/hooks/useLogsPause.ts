import { useEffect } from 'react';

/** Couples the keyboard pause state (explicit `p` toggle OR auto-pause when
 *  scrolled up) with the process manager's logs sink. */
export function useLogsPause(
  setPaused: (paused: boolean) => void,
  logsPaused: boolean,
  logsScrollOffset: number,
): void {
  useEffect(() => {
    setPaused(logsPaused || logsScrollOffset > 0);
  }, [logsPaused, logsScrollOffset, setPaused]);
}
