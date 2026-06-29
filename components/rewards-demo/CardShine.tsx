import React, { memo, useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

function CardShine({ disabled = false }: { disabled?: boolean }) {
  const progress = useSharedValue(-1);

  useEffect(() => {
    if (disabled) {
      progress.value = -1;
      return;
    }

    progress.value = withRepeat(
      withTiming(1.4, { duration: 2800, easing: Easing.inOut(Easing.quad) }),
      -1,
      false
    );
  }, [disabled, progress]);

  const style = useAnimatedStyle(() => ({
    opacity: 0.55,
    transform: [{ translateX: progress.value * 120 }, { rotate: '18deg' }],
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.shine, style]}>
      <LinearGradient
        colors={['transparent', 'rgba(255,255,255,0.55)', 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.gradient}
      />
    </Animated.View>
  );
}

export default memo(CardShine);

const styles = StyleSheet.create({
  shine: {
    position: 'absolute',
    top: -20,
    left: '18%',
    width: 56,
    height: 140,
    zIndex: 3,
  },
  gradient: {
    flex: 1,
    borderRadius: 20,
  },
});