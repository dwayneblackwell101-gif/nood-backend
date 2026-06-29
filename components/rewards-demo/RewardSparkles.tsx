import React, { memo, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

type SparkleSpec = {
  id: string;
  left: `${number}%`;
  top: number;
  kind: 'coin' | 'sparkle';
  delay: number;
  drift: number;
  size: number;
};

const SPECS: SparkleSpec[] = [
  { id: 'a', left: '6%', top: 28, kind: 'coin', delay: 0, drift: 10, size: 28 },
  { id: 'b', left: '82%', top: 18, kind: 'sparkle', delay: 200, drift: 8, size: 16 },
  { id: 'c', left: '88%', top: 62, kind: 'coin', delay: 400, drift: 12, size: 24 },
  { id: 'd', left: '4%', top: 72, kind: 'sparkle', delay: 120, drift: 9, size: 14 },
  { id: 'e', left: '46%', top: 4, kind: 'sparkle', delay: 300, drift: 7, size: 18 },
  { id: 'f', left: '72%', top: 84, kind: 'coin', delay: 500, drift: 11, size: 22 },
];

const SparkleItem = memo(function SparkleItem({
  spec,
  active,
  reducedMotion,
}: {
  spec: SparkleSpec;
  active: boolean;
  reducedMotion: boolean;
}) {
  const progress = useSharedValue(0);
  const twinkle = useSharedValue(0.6);

  useEffect(() => {
    if (!active || reducedMotion) {
      progress.value = 0;
      twinkle.value = 0.7;
      return;
    }

    progress.value = withDelay(
      spec.delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.sin) }),
          withTiming(0, { duration: 1800, easing: Easing.inOut(Easing.sin) })
        ),
        -1,
        false
      )
    );

    twinkle.value = withDelay(
      spec.delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }),
          withTiming(0.45, { duration: 900, easing: Easing.inOut(Easing.quad) })
        ),
        -1,
        false
      )
    );
  }, [active, progress, reducedMotion, spec.delay, twinkle]);

  const style = useAnimatedStyle(() => ({
    opacity: 0.35 + twinkle.value * 0.55,
    transform: [
      { translateY: (progress.value - 0.5) * spec.drift },
      { scale: 0.88 + progress.value * 0.14 },
      { rotate: `${progress.value * 24}deg` },
    ],
  }));

  if (!active) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.item,
        style,
        { left: spec.left, top: spec.top, width: spec.size, height: spec.size },
      ]}
    >
      {spec.kind === 'coin' ? (
        <LinearGradient colors={['#ffb400', '#ff6a00']} style={styles.coin}>
          <Text style={[styles.coinText, { fontSize: spec.size * 0.38 }]}>$</Text>
        </LinearGradient>
      ) : (
        <View style={styles.sparkle}>
          <Ionicons name="sparkles" size={spec.size} color="rgba(255,255,255,0.92)" />
        </View>
      )}
    </Animated.View>
  );
});

type RewardSparklesProps = {
  active: boolean;
  reducedMotion?: boolean;
};

function RewardSparkles({ active, reducedMotion = false }: RewardSparklesProps) {
  if (!active) {
    return null;
  }

  return (
    <View pointerEvents="none" style={styles.layer}>
      {SPECS.map((spec) => (
        <SparkleItem key={spec.id} spec={spec} active={active} reducedMotion={reducedMotion} />
      ))}
    </View>
  );
}

export default memo(RewardSparkles);

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
  },
  item: {
    position: 'absolute',
  },
  coin: {
    flex: 1,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.55)',
  },
  sparkle: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coinText: {
    color: '#fff',
    fontWeight: '900',
  },
});