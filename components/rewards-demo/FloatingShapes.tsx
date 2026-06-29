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

type ShapeSpec = {
  id: string;
  size: number;
  left: `${number}%`;
  top: `${number}%`;
  color: string;
  drift: number;
  duration: number;
  delay: number;
  ring?: boolean;
};

const SHAPES: ShapeSpec[] = [
  { id: 'a', size: 140, left: '6%', top: '10%', color: 'rgba(159, 121, 255, 0.2)', drift: 14, duration: 5200, delay: 0 },
  { id: 'b', size: 96, left: '74%', top: '6%', color: 'rgba(255, 106, 0, 0.16)', drift: 10, duration: 4600, delay: 200 },
  { id: 'c', size: 72, left: '80%', top: '56%', color: 'rgba(255, 180, 0, 0.14)', drift: 12, duration: 5000, delay: 400 },
  { id: 'd', size: 52, left: '12%', top: '70%', color: 'rgba(92, 49, 255, 0.18)', drift: 8, duration: 4200, delay: 100 },
  { id: 'e', size: 38, left: '46%', top: '16%', color: 'rgba(255, 255, 255, 0.07)', drift: 6, duration: 3800, delay: 300 },
  { id: 'f', size: 180, left: '58%', top: '72%', color: 'rgba(255, 106, 0, 0.08)', drift: 10, duration: 5600, delay: 150, ring: true },
  { id: 'g', size: 110, left: '2%', top: '42%', color: 'rgba(92, 49, 255, 0.1)', drift: 8, duration: 4800, delay: 250, ring: true },
];

const FloatingOrb = memo(function FloatingOrb({
  spec,
  reducedMotion,
}: {
  spec: ShapeSpec;
  reducedMotion: boolean;
}) {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) {
      progress.value = 0.5;
      return;
    }

    progress.value = withRepeat(
      withSequence(
        withTiming(1, { duration: spec.duration, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: spec.duration, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
  }, [progress, reducedMotion, spec.duration]);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateY: (progress.value - 0.5) * spec.drift * 2 },
      { scale: 0.94 + progress.value * 0.08 },
    ],
    opacity: 0.45 + progress.value * 0.35,
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.orb,
        spec.ring && styles.ring,
        style,
        {
          width: spec.size,
          height: spec.size,
          borderRadius: spec.size / 2,
          left: spec.left,
          top: spec.top,
          backgroundColor: spec.ring ? 'transparent' : spec.color,
          borderColor: spec.ring ? spec.color : undefined,
        },
      ]}
    />
  );
});

function FloatingShapes({ reducedMotion = false }: { reducedMotion?: boolean }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.vignetteTop} />
      <View style={styles.vignetteBottom} />
      {SHAPES.map((spec) => (
        <FloatingOrb key={spec.id} spec={spec} reducedMotion={reducedMotion} />
      ))}
    </View>
  );
}

export default memo(FloatingShapes);

const styles = StyleSheet.create({
  orb: {
    position: 'absolute',
  },
  ring: {
    borderWidth: 1.5,
  },
  vignetteTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '28%',
    backgroundColor: 'rgba(42, 21, 120, 0.18)',
  },
  vignetteBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '22%',
    backgroundColor: 'rgba(42, 21, 120, 0.22)',
  },
});