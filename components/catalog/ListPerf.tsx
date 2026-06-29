import { Platform } from 'react-native';

export const CATALOG_LIST_END_REACHED_THRESHOLD = 0.75;

export const CATALOG_LIST_PROPS = Platform.OS === 'android'
  ? {
      removeClippedSubviews: true,
      initialNumToRender: 8,
      maxToRenderPerBatch: 8,
      windowSize: 5,
      updateCellsBatchingPeriod: 50,
      scrollEventThrottle: 16 as const,
    }
  : {
      initialNumToRender: 8,
      maxToRenderPerBatch: 8,
      windowSize: 5,
      updateCellsBatchingPeriod: 50,
      scrollEventThrottle: 16 as const,
    };