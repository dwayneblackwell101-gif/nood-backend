import React, { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

type StepIndicatorProps = {
  total: number;
  activeIndex: number;
  reducedMotion?: boolean;
};

const SEGMENT_WIDTH = 52;
const SEGMENT_GAP = 8;

function StepIndicator({ total, activeIndex, reducedMotion = false }: StepIndicatorProps) {
  const progress = useSharedValue(activeIndex);

  useEffect(() => {
    progress.value = reducedMotion
      ? activeIndex
      : withTiming(activeIndex, { duration: 320, easing: Easing.out(Easing.cubic) });
  }, [activeIndex, progress, reducedMotion]);

  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * (SEGMENT_WIDTH + SEGMENT_GAP) }],
  }));

  return (
    <View style={styles.wrap}>
      <View style={styles.track}>
        <Animated.View style={[styles.activePill, pillStyle]} />
        {Array.from({ length: total }).map((_, index) => (
          <View key={`seg-${index}`} style={styles.segment} />
        ))}
      </View>
    </View>
  );
}

export default memo(StepIndicator);

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingBottom: 10,
  },
  track: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SEGMENT_GAP,
    padding: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    position: 'relative',
  },
  segment: {
    width: SEGMENT_WIDTH,
    height: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  activePill: {
    position: 'absolute',
    left: 4,
    width: SEGMENT_WIDTH,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#fff',
  },
});