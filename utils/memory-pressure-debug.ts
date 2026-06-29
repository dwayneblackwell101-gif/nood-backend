import { MEMORY_PRESSURE_DEBUG } from './debug-flags';

export type MemoryPressureDebugPayload = {
  screen: string;
  homeProductCount?: number;
  visibleProductCount?: number;
  cachedPageCount?: number;
  mountedVideoCount?: number;
  mountedImageCardCount?: number;
  isAuthLoading?: boolean;
};

export function logMemoryPressureDebug(payload: MemoryPressureDebugPayload) {
  if (!MEMORY_PRESSURE_DEBUG) return;

  console.log('[MEMORY_PRESSURE_DEBUG]', {
    screen: payload.screen,
    homeProductCount: payload.homeProductCount ?? 0,
    visibleProductCount: payload.visibleProductCount ?? 0,
    cachedPageCount: payload.cachedPageCount ?? 0,
    mountedVideoCount: payload.mountedVideoCount ?? 0,
    mountedImageCardCount: payload.mountedImageCardCount ?? 0,
    isAuthLoading: Boolean(payload.isAuthLoading),
  });
}