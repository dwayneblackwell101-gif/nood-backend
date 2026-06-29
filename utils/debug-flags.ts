function isDebugFlagEnabled(value: string | undefined) {
  return value === 'true' || value === '1';
}

export const HOME_PERF_DEBUG = isDebugFlagEnabled(process.env.EXPO_PUBLIC_HOME_PERF_DEBUG);
export const LACE_VIDEO_DEBUG = isDebugFlagEnabled(process.env.EXPO_PUBLIC_LACE_VIDEO_DEBUG);
export const CATALOG_CACHE_DEBUG = isDebugFlagEnabled(process.env.EXPO_PUBLIC_CATALOG_CACHE_DEBUG);
export const PRODUCT_LOAD_DEBUG = isDebugFlagEnabled(process.env.EXPO_PUBLIC_PRODUCT_LOAD_DEBUG);
export const MEMORY_PRESSURE_DEBUG = isDebugFlagEnabled(process.env.EXPO_PUBLIC_MEMORY_PRESSURE_DEBUG);