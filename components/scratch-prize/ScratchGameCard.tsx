import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { SCRATCH_BORDER, SCRATCH_GOLD, SCRATCH_ORANGE, SCRATCH_TEXT } from './theme';

type ScratchGameCardProps = {
  prizeLabel: string;
  prizeNote?: string;
  scratchCount: number;
  revealed: boolean;
  onScratch: () => void;
  cardScale: SharedValue<number>;
  coverOpacity: SharedValue<number>;
};

function ScratchPattern() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {Array.from({ length: 12 }).map((_, index) => (
        <View
          key={`line-${index}`}
          style={[
            styles.scratchLine,
            {
              transform: [{ rotate: `${index * 15 - 82}deg` }],
              opacity: 0.08 + (index % 3) * 0.04,
            },
          ]}
        />
      ))}
    </View>
  );
}

function ScratchGameCard({
  prizeLabel,
  prizeNote = 'Scratch to reveal your reward.',
  scratchCount,
  revealed,
  onScratch,
  cardScale,
  coverOpacity,
}: ScratchGameCardProps) {
  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: cardScale.value }],
  }));

  const coverStyle = useAnimatedStyle(() => ({
    opacity: coverOpacity.value,
  }));

  return (
    <Animated.View style={[styles.wrap, cardStyle]}>
      <View style={styles.glow} pointerEvents="none" />
      <LinearGradient
        colors={['rgba(255,176,0,0.22)', 'rgba(255,106,0,0.12)', 'rgba(255,255,255,0.05)']}
        style={styles.prizeCard}
      >
        <Text style={styles.prizeKicker}>Your reward</Text>
        <Text style={styles.prizeValue}>{prizeLabel}</Text>
        <Text style={styles.prizeNote}>{prizeNote}</Text>
      </LinearGradient>

      {!revealed ? (
        <Animated.View style={[styles.cover, coverStyle]}>
          <Pressable style={styles.coverPressable} onPress={onScratch}>
            <LinearGradient
              colors={['#FFB000', '#FF6A00', '#FF3D00']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.coverGradient}
            >
              <ScratchPattern />
              <View style={styles.coverContent}>
                <Ionicons name="hand-left-outline" size={30} color="#fff" />
                <Text style={styles.coverTitle}>Tap to scratch</Text>
                <Text style={styles.coverMeta}>{Math.min(scratchCount, 5)}/5</Text>
              </View>
            </LinearGradient>
          </Pressable>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

export function useScratchCardMotion() {
  const cardScale = useSharedValue(0.94);
  const coverOpacity = useSharedValue(1);

  const primeEntrance = () => {
    cardScale.value = withSpring(1, { damping: 14, stiffness: 180 });
  };

  const scratchStep = (count: number) => {
    coverOpacity.value = withTiming(Math.max(0, 1 - count * 0.22), { duration: 180 });
  };

  const finishReveal = () => {
    coverOpacity.value = withTiming(0, { duration: 220 });
  };

  const resetCover = () => {
    coverOpacity.value = 1;
  };

  return { cardScale, coverOpacity, primeEntrance, scratchStep, finishReveal, resetCover };
}

export default memo(ScratchGameCard);

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    maxWidth: 340,
    minHeight: 250,
    borderRadius: 28,
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    top: -30,
    alignSelf: 'center',
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: 'rgba(255,106,0,0.18)',
  },
  prizeCard: {
    minHeight: 250,
    borderRadius: 28,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,176,0,0.35)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  prizeKicker: {
    color: SCRATCH_GOLD,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  prizeValue: {
    marginTop: 12,
    color: SCRATCH_TEXT,
    fontSize: 28,
    fontWeight: '900',
    textAlign: 'center',
  },
  prizeNote: {
    marginTop: 10,
    color: 'rgba(255,255,255,0.62)',
    fontSize: 12,
    fontWeight: '700',
  },
  cover: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 28,
    overflow: 'hidden',
  },
  coverPressable: {
    flex: 1,
  },
  coverGradient: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverContent: {
    alignItems: 'center',
    gap: 8,
  },
  coverTitle: {
    color: SCRATCH_TEXT,
    fontSize: 18,
    fontWeight: '900',
  },
  coverMeta: {
    color: 'rgba(255,255,255,0.88)',
    fontSize: 13,
    fontWeight: '800',
  },
  scratchLine: {
    position: 'absolute',
    left: '-20%',
    right: '-20%',
    top: '50%',
    height: 2,
    backgroundColor: '#fff',
  },
});