import React, { memo, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {
  SCRATCH_CARD,
  SCRATCH_GOLD,
  SCRATCH_ORANGE,
  SCRATCH_TEXT,
  SCRATCH_TEXT_MUTED,
} from './theme';

type ScratchLockedPrizeCardProps = {
  statusLabel: string;
  ready?: boolean;
  reducedMotion?: boolean;
};

function CardPattern() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {Array.from({ length: 8 }).map((_, row) => (
        <View key={`row-${row}`} style={[styles.patternRow, { top: `${row * 14}%` }]}>
          {Array.from({ length: 10 }).map((__, col) => (
            <View
              key={`dot-${row}-${col}`}
              style={[
                styles.patternDot,
                { opacity: (row + col) % 3 === 0 ? 0.16 : 0.07 },
              ]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function ScratchLockedPrizeCard({
  statusLabel,
  ready = false,
  reducedMotion = false,
}: ScratchLockedPrizeCardProps) {
  const entrance = useSharedValue(0.94);
  const lockPulse = useSharedValue(1);
  const glowPulse = useSharedValue(0.45);
  const goldGlowPulse = useSharedValue(0.3);

  useEffect(() => {
    entrance.value = withSpring(1, { damping: 14, stiffness: 180 });
  }, [entrance]);

  useEffect(() => {
    if (reducedMotion) {
      lockPulse.value = 1;
      glowPulse.value = 0.65;
      goldGlowPulse.value = 0.45;
      return;
    }

    lockPulse.value = withRepeat(
      withSequence(
        withTiming(1.08, { duration: 850, easing: Easing.inOut(Easing.sin) }),
        withTiming(1, { duration: 850, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );

    glowPulse.value = withRepeat(
      withSequence(
        withTiming(0.85, { duration: 1000, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.4, { duration: 1000, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );

    goldGlowPulse.value = withRepeat(
      withSequence(
        withTiming(0.7, { duration: 1200, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.25, { duration: 1200, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
  }, [goldGlowPulse, glowPulse, lockPulse, reducedMotion]);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: entrance.value }],
  }));

  const lockStyle = useAnimatedStyle(() => ({
    transform: [{ scale: lockPulse.value }],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowPulse.value,
    transform: [{ scale: 0.9 + glowPulse.value * 0.2 }],
  }));

  const goldGlowStyle = useAnimatedStyle(() => ({
    opacity: goldGlowPulse.value,
    transform: [{ scale: 0.86 + goldGlowPulse.value * 0.22 }],
  }));

  return (
    <Animated.View style={[styles.wrap, cardStyle]}>
      <Animated.View pointerEvents="none" style={[styles.glowRingOuter, goldGlowStyle]} />
      <Animated.View pointerEvents="none" style={[styles.glowRing, glowStyle]} />
      <View style={[styles.card, ready && styles.cardReady]}>
        <LinearGradient
          colors={
            ready
              ? ['rgba(255,176,0,0.16)', 'rgba(255,255,255,0.06)', 'rgba(0,0,0,0.22)']
              : ['rgba(255,106,0,0.18)', 'rgba(255,255,255,0.05)', 'rgba(0,0,0,0.28)']
          }
          style={StyleSheet.absoluteFill}
        />
        <View pointerEvents="none" style={styles.cardEdgeHighlight} />
        <CardPattern />

        <View style={[styles.statusPill, ready && styles.statusPillReady]}>
          <View style={[styles.statusDot, ready && styles.statusDotReady]} />
          <Text style={styles.statusText}>{statusLabel}</Text>
        </View>

        <View style={styles.lockStage}>
          <Animated.View style={[styles.lockHaloOuter, lockStyle]}>
            <LinearGradient
              colors={
                ready
                  ? ['rgba(255,176,0,0.42)', 'rgba(255,106,0,0.22)']
                  : ['rgba(255,106,0,0.38)', 'rgba(255,61,0,0.18)']
              }
              style={styles.lockHalo}
            >
              <Ionicons
                name={ready ? 'ticket-outline' : 'lock-closed'}
                size={54}
                color={ready ? SCRATCH_GOLD : SCRATCH_ORANGE}
              />
            </LinearGradient>
          </Animated.View>
          <Text style={styles.cardTitle}>{ready ? 'Scratch Token Ready' : 'Scratch Prize Locked'}</Text>
          <Text style={styles.cardCopy}>
            {ready
              ? 'Scratch to reveal your reward.'
              : 'Your next Scratch Token unlocks soon.'}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}

export default memo(ScratchLockedPrizeCard);

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    maxWidth: 340,
    minHeight: 310,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowRingOuter: {
    position: 'absolute',
    width: 310,
    height: 310,
    borderRadius: 155,
    backgroundColor: 'rgba(255,176,0,0.14)',
  },
  glowRing: {
    position: 'absolute',
    width: 290,
    height: 290,
    borderRadius: 145,
    backgroundColor: 'rgba(255,106,0,0.22)',
  },
  card: {
    width: '100%',
    minHeight: 310,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: SCRATCH_CARD,
    borderWidth: 1.5,
    borderColor: 'rgba(255,106,0,0.38)',
    padding: 20,
  },
  cardReady: {
    borderColor: 'rgba(255,176,0,0.45)',
  },
  cardEdgeHighlight: {
    position: 'absolute',
    top: 0,
    left: 20,
    right: 20,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  patternRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
  },
  patternDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#fff',
  },
  statusPill: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderWidth: 1,
    borderColor: 'rgba(255,106,0,0.45)',
  },
  statusPillReady: {
    borderColor: 'rgba(255,176,0,0.55)',
    backgroundColor: 'rgba(255,106,0,0.16)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: SCRATCH_ORANGE,
  },
  statusDotReady: {
    backgroundColor: SCRATCH_GOLD,
  },
  statusText: {
    color: SCRATCH_TEXT,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  lockStage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 18,
    gap: 10,
  },
  lockHaloOuter: {
    borderRadius: 68,
    padding: 3,
    borderWidth: 1,
    borderColor: 'rgba(255,176,0,0.28)',
  },
  lockHalo: {
    width: 124,
    height: 124,
    borderRadius: 62,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  cardTitle: {
    color: SCRATCH_TEXT,
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
  },
  cardCopy: {
    color: SCRATCH_TEXT_MUTED,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 12,
    maxWidth: 280,
  },
});