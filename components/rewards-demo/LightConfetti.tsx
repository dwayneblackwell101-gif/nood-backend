import React, { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

const COLORS = ['#ffb400', '#ff6a00', '#ffffff', '#9f79ff', '#5c31ff'];

type ParticleSpec = {
  id: string;
  left: number;
  delay: number;
  color: string;
  size: number;
  driftX: number;
  bottom: number;
  loop?: boolean;
};

const BURST_PARTICLES: ParticleSpec[] = Array.from({ length: 14 }).map((_, index) => ({
  id: `burst-${index}`,
  left: 8 + ((index * 17) % 84),
  delay: (index % 5) * 70,
  color: COLORS[index % COLORS.length],
  size: 6 + (index % 3) * 2,
  driftX: (index % 2 === 0 ? -1 : 1) * (8 + (index % 4) * 3),
  bottom: 42,
}));

const AMBIENT_PARTICLES: ParticleSpec[] = Array.from({ length: 10 }).map((_, index) => ({
  id: `ambient-${index}`,
  left: 6 + ((index * 19) % 88),
  delay: index * 220,
  color: COLORS[(index + 2) % COLORS.length],
  size: 4 + (index % 2) * 2,
  driftX: (index % 2 === 0 ? -1 : 1) * (6 + (index % 3) * 2),
  bottom: 28 + (index % 4) * 8,
  loop: true,
}));

const Particle = memo(function Particle({
  spec,
  active,
}: {
  spec: ParticleSpec;
  active: boolean;
}) {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (!active) {
      progress.value = 0;
      return;
    }

    progress.value = 0;

    if (spec.loop) {
      progress.value = withRepeat(
        withDelay(
          spec.delay,
          withTiming(1, { duration: 2200, easing: Easing.out(Easing.quad) })
        ),
        -1,
        false
      );
      return;
    }

    progress.value = withDelay(
      spec.delay,
      withTiming(1, { duration: 1100, easing: Easing.out(Easing.cubic) })
    );
  }, [active, progress, spec.delay, spec.loop]);

  const style = useAnimatedStyle(() => ({
    opacity: spec.loop ? 0.15 + (1 - progress.value) * 0.55 : 1 - progress.value,
    transform: [
      { translateY: -progress.value * (spec.loop ? 80 : 120) },
      { translateX: progress.value * spec.driftX },
      { rotate: `${progress.value * 180}deg` },
    ],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.particle,
        style,
        {
          left: `${spec.left}%`,
          bottom: `${spec.bottom}%`,
          width: spec.size,
          height: spec.size,
          borderRadius: spec.size / 2,
          backgroundColor: spec.color,
        },
      ]}
    />
  );
});

type LightConfettiProps = {
  active: boolean;
  continuous?: boolean;
};

function LightConfetti({ active, continuous = false }: LightConfettiProps) {
  if (!active) {
    return null;
  }

  const particles = continuous
    ? [...BURST_PARTICLES, ...AMBIENT_PARTICLES]
    : BURST_PARTICLES;

  return (
    <View pointerEvents="none" style={styles.layer}>
      {particles.map((spec) => (
        <Particle key={spec.id} spec={spec} active={active} />
      ))}
    </View>
  );
}

export default memo(LightConfetti);

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
  },
  particle: {
    position: 'absolute',
  },
});