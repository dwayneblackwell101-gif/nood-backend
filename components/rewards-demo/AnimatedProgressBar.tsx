import React, { memo, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

type AnimatedProgressBarProps = {
  progress: number;
  label: string;
  animateKey?: string | number;
  variant?: 'default' | 'hero';
};

function AnimatedProgressBar({
  progress,
  label,
  animateKey = 0,
  variant = 'default',
}: AnimatedProgressBarProps) {
  const clamped = Math.max(0, Math.min(progress, 1));
  const fill = useSharedValue(0);
  const hero = variant === 'hero';

  useEffect(() => {
    fill.value = 0;
    fill.value = withTiming(clamped, {
      duration: 700,
      easing: Easing.out(Easing.cubic),
    });
  }, [animateKey, clamped, fill]);

  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: fill.value }],
    transformOrigin: 'left center',
  }));

  return (
    <View style={[styles.wrap, hero && styles.wrapHero]}>
      <View style={[styles.track, hero && styles.trackHero]}>
        <Animated.View style={[styles.fill, hero && styles.fillHero, fillStyle]} />
      </View>
      <Text style={[styles.label, hero && styles.labelHero]}>{label}</Text>
    </View>
  );
}

export default memo(AnimatedProgressBar);

const styles = StyleSheet.create({
  wrap: {
    gap: 10,
  },
  wrapHero: {
    gap: 12,
  },
  track: {
    height: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.16)',
    overflow: 'hidden',
  },
  trackHero: {
    height: 16,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  fill: {
    height: '100%',
    width: '100%',
    borderRadius: 999,
    backgroundColor: '#fff',
    transformOrigin: 'left',
  },
  fillHero: {
    backgroundColor: '#ffb400',
  },
  label: {
    color: 'rgba(255,255,255,0.88)',
    fontSize: 13,
    fontWeight: '800',
  },
  labelHero: {
    fontSize: 14,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
});