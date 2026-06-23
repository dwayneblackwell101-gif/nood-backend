import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import type { PromoStepComponentProps } from '../types';

export function TodayGiftRevealStep({ config }: PromoStepComponentProps) {
  const fade = useSharedValue(0);
  const cardScale = useSharedValue(0.92);
  const glow = useSharedValue(0);

  useEffect(() => {
    fade.value = withTiming(1, { duration: 320 });
    cardScale.value = withSpring(1, { damping: 16, stiffness: 140 });
    glow.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 1400, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
  }, [cardScale, fade, glow]);

  const contentStyle = useAnimatedStyle(() => ({
    opacity: fade.value,
  }));

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: cardScale.value }],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(glow.value, [0, 1], [0.32, 0.72]),
    transform: [{ scale: interpolate(glow.value, [0, 1], [0.94, 1.08]) }],
  }));

  return (
    <Animated.View style={[styles.container, contentStyle]}>
      <View style={styles.oldCard}>
        <Text style={styles.oldCardLabel}>{config.copy.previousGiftLabel}</Text>
        <Text style={styles.oldCardAmount}>
          {config.currencySymbol}
          {config.previousGiftAmount}
        </Text>
      </View>

      <View style={styles.revealZone}>
        <Animated.View style={[styles.glow, glowStyle]} />

        <Animated.View style={[styles.todayCardWrap, cardStyle]}>
          <LinearGradient colors={['#fff7d6', '#ffd54a', '#ffb423']} style={styles.todayCard}>
            <Text style={styles.todayLabel}>{config.copy.todayGiftLabel}</Text>
            <Text style={styles.todayAmount}>
              {config.currencySymbol}
              {config.todayGiftAmount}
            </Text>
          </LinearGradient>
        </Animated.View>
      </View>

      <Text style={styles.disclaimer}>{config.disclaimers.todayGift}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  oldCard: {
    width: '88%',
    maxWidth: 320,
    borderRadius: 28,
    backgroundColor: 'rgba(125, 90, 0, 0.14)',
    paddingVertical: 18,
    paddingHorizontal: 22,
    opacity: 0.48,
  },
  oldCardLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#6d5311',
  },
  oldCardAmount: {
    marginTop: 8,
    fontSize: 34,
    lineHeight: 38,
    fontWeight: '900',
    color: '#5a3b00',
  },
  revealZone: {
    marginTop: 24,
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    position: 'absolute',
    width: 330,
    height: 330,
    borderRadius: 165,
    backgroundColor: 'rgba(255,255,255,0.78)',
  },
  todayCardWrap: {
    width: '100%',
  },
  todayCard: {
    minHeight: 232,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    shadowColor: '#ffb221',
    shadowOpacity: 0.28,
    shadowRadius: 24,
    elevation: 16,
  },
  todayLabel: {
    textAlign: 'center',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '800',
    color: '#241400',
  },
  todayAmount: {
    marginTop: 12,
    fontSize: 64,
    lineHeight: 68,
    fontWeight: '900',
    color: '#251200',
  },
  disclaimer: {
    marginTop: 18,
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 18,
    color: '#795f18',
    fontWeight: '600',
  },
});
