import React, { memo, useEffect } from 'react';
import { StyleSheet, ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

type SlideTransitionProps = {
  stepKey: string | number;
  children: React.ReactNode;
  style?: ViewStyle;
  reducedMotion?: boolean;
};

function SlideTransition({ stepKey, children, style, reducedMotion = false }: SlideTransitionProps) {
  const opacity = useSharedValue(1);
  const translateX = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) {
      opacity.value = 1;
      translateX.value = 0;
      return;
    }

    opacity.value = 0;
    translateX.value = 28;
    opacity.value = withTiming(1, { duration: 340, easing: Easing.out(Easing.cubic) });
    translateX.value = withTiming(0, { duration: 380, easing: Easing.out(Easing.cubic) });
  }, [opacity, reducedMotion, stepKey, translateX]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: translateX.value }],
  }));

  return <Animated.View style={[styles.container, style, animatedStyle]}>{children}</Animated.View>;
}

export default memo(SlideTransition);

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});