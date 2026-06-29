import { useEffect, useRef } from 'react';

export type ScreenPerfSnapshot = {
  screen: string;
  itemCount?: number;
  renderCount?: number;
  isFetching?: boolean;
  isRefreshing?: boolean;
};

export function logScreenPerfCheck(snapshot: ScreenPerfSnapshot) {
  if (__DEV__) {
    console.log('[SCREEN_PERF_CHECK]', snapshot);
  }
}

export function useScreenPerfReporter(
  screen: string,
  metrics: Omit<ScreenPerfSnapshot, 'screen' | 'renderCount'>,
  deps: readonly unknown[]
) {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  useEffect(() => {
    logScreenPerfCheck({
      screen,
      renderCount: renderCountRef.current,
      ...metrics,
    });
    // Snapshot only — caller controls refresh cadence via deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}