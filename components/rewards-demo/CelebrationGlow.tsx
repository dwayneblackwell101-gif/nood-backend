import React, { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

function CelebrationGlow({ active, reducedMotion = false }: { active: boolean; reducedMotion?: boolean }) {
  const pulse = useSharedValue(0.85);
  const opacity = useSharedValue(0.35);

  useEffect(() => {
    if (!active || reducedMotion) {
      pulse.value = 1;
      opacity.value = active ? 0.28 : 0;
      return;
    }

    pulse.value = withRepeat(
      withSequence(
        withTiming(1.08, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.92, { duration: 1400, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.5, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.28, { duration: 1400, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
  }, [active, opacity, pulse, reducedMotion]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: pulse.value }],
  }));

  if (!active) {
    return null;
  }

  return (
    <View pointerEvents="none" style={styles.layer}>
      <Animated.View style={[styles.glowOuter, style]} />
      <Animated.View style={[styles.glowInner, style]} />
    </View>
  );
}

export default memo(CelebrationGlow);

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  glowOuter: {
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: 'rgba(255, 180, 0, 0.22)',
  },
  glowInner: {
    position: 'absolute',
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: 'rgba(255, 106, 0, 0.18)',
  },
});