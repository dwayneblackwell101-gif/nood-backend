import React, { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { SCRATCH_BG, SCRATCH_BG_DEEP, SCRATCH_BG_MID } from './theme';

type OrbSpec = {
  id: string;
  size: number;
  left: `${number}%`;
  top: `${number}%`;
  color: string;
  drift: number;
  duration: number;
};

const ORBS: OrbSpec[] = [
  { id: 'o1', size: 180, left: '72%', top: '8%', color: 'rgba(255, 106, 0, 0.14)', drift: 12, duration: 5200 },
  { id: 'o2', size: 120, left: '4%', top: '18%', color: 'rgba(255, 176, 0, 0.1)', drift: 10, duration: 4600 },
  { id: 'o3', size: 90, left: '82%', top: '58%', color: 'rgba(255, 61, 0, 0.12)', drift: 14, duration: 5000 },
  { id: 'o4', size: 140, left: '10%', top: '72%', color: 'rgba(255, 106, 0, 0.08)', drift: 8, duration: 5400 },
];

const FloatingOrb = memo(function FloatingOrb({
  spec,
  reducedMotion,
}: {
  spec: OrbSpec;
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
      { scale: 0.92 + progress.value * 0.1 },
    ],
    opacity: 0.35 + progress.value * 0.4,
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.orb,
        style,
        {
          width: spec.size,
          height: spec.size,
          borderRadius: spec.size / 2,
          left: spec.left,
          top: spec.top,
          backgroundColor: spec.color,
        },
      ]}
    />
  );
});

function ScratchPrizeBackground({
  reducedMotion = false,
}: {
  reducedMotion?: boolean;
}) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        colors={[SCRATCH_BG, SCRATCH_BG_MID, SCRATCH_BG_DEEP]}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />
      {ORBS.map((spec) => (
        <FloatingOrb key={spec.id} spec={spec} reducedMotion={reducedMotion} />
      ))}
      <View style={styles.vignetteTop} />
      <View style={styles.vignetteBottom} />
    </View>
  );
}

export default memo(ScratchPrizeBackground);

const styles = StyleSheet.create({
  orb: {
    position: 'absolute',
  },
  vignetteTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '24%',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  vignetteBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '18%',
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
});