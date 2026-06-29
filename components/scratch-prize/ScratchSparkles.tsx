import React, { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

type SparkleSpec = {
  id: string;
  left: `${number}%`;
  top: `${number}%`;
  size: number;
  delay: number;
};

const SPARKLES: SparkleSpec[] = [
  { id: 's1', left: '18%', top: '22%', size: 6, delay: 0 },
  { id: 's2', left: '72%', top: '18%', size: 5, delay: 60 },
  { id: 's3', left: '84%', top: '48%', size: 7, delay: 120 },
  { id: 's4', left: '12%', top: '62%', size: 5, delay: 180 },
  { id: 's5', left: '48%', top: '12%', size: 4, delay: 90 },
  { id: 's6', left: '56%', top: '74%', size: 6, delay: 150 },
];

const Sparkle = memo(function Sparkle({
  spec,
  reducedMotion,
}: {
  spec: SparkleSpec;
  reducedMotion: boolean;
}) {
  const twinkle = useSharedValue(0.4);

  useEffect(() => {
    if (reducedMotion) {
      twinkle.value = 0.8;
      return;
    }

    twinkle.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 700 + spec.delay, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.25, { duration: 700 + spec.delay, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
  }, [reducedMotion, spec.delay, twinkle]);

  const style = useAnimatedStyle(() => ({
    opacity: twinkle.value,
    transform: [{ scale: 0.8 + twinkle.value * 0.5 }, { rotate: `${twinkle.value * 18}deg` }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.sparkle,
        style,
        {
          left: spec.left,
          top: spec.top,
          width: spec.size,
          height: spec.size,
          borderRadius: spec.size / 2,
        },
      ]}
    />
  );
});

function ScratchSparkles({
  active,
  reducedMotion = false,
}: {
  active: boolean;
  reducedMotion?: boolean;
}) {
  if (!active) return null;

  return (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(160)} style={styles.layer}>
      {SPARKLES.map((spec) => (
        <Sparkle key={spec.id} spec={spec} reducedMotion={reducedMotion} />
      ))}
    </Animated.View>
  );
}

export default memo(ScratchSparkles);

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 6,
  },
  sparkle: {
    position: 'absolute',
    backgroundColor: '#FFB000',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.65)',
  },
});