import { Platform } from 'react-native';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

/** Edge-only swipe back so horizontal content (e.g. product galleries) stays usable. */
export const EDGE_SWIPE_STACK_OPTIONS: NativeStackNavigationOptions = {
  gestureEnabled: true,
  fullScreenGestureEnabled: false,
  gestureDirection: 'horizontal',
  animation: 'slide_from_right',
  ...(Platform.OS === 'ios'
    ? {
        gestureResponseDistance: {
          start: 28,
        },
      }
    : {}),
};

export const NOOD_REFRESH_CONTROL_PROPS = {
  tintColor: '#ff6a00',
  colors: ['#ff6a00'] as string[],
  progressBackgroundColor: '#ffffff',
};