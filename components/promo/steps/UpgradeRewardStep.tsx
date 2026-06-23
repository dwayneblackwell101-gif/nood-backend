import React, { useEffect } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
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

import { getPromoAsset } from '../assets';
import type { PromoStepComponentProps } from '../types';

export function UpgradeRewardStep({ config }: PromoStepComponentProps) {
  const scale = useSharedValue(0.92);
  const glow = useSharedValue(0);
  const arrowAsset = getPromoAsset(config.assets, 'arrowGlow');

  useEffect(() => {
    scale.value = withSpring(1, { damping: 16, stiffness: 132 });
    glow.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 1500, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
  }, [glow, scale]);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(glow.value, [0, 1], [0.28, 0.62]),
    transform: [{ scale: interpolate(glow.value, [0, 1], [0.95, 1.08]) }],
  }));

  return (
    <View style={styles.container}>
      <View style={styles.badgePill}>
        <Text style={styles.badgeText}>{config.copy.badgeText}</Text>
      </View>

      <Text style={styles.headline}>{config.copy.upgradeHeadline}</Text>
      <Text style={styles.subtitle}>{config.copy.upgradeSubtitle}</Text>

      <View style={styles.cardZone}>
        <Animated.View style={[styles.cardGlow, glowStyle]} />

        <Animated.View style={[styles.ticketWrap, cardStyle]}>
          <LinearGradient colors={['#ff9b1c', '#ff5c12']} style={styles.ticket}>
            <Text style={styles.ticketLabel}>{config.copy.todayGiftLabel}</Text>
            <Text style={styles.ticketAmount}>
              {config.currencySymbol}
              {config.upgradedGiftAmount}
            </Text>

            {arrowAsset ? (
              <Image source={arrowAsset} style={styles.arrowAsset} resizeMode="contain" />
            ) : (
              <Text style={styles.arrowFallback}>→</Text>
            )}
          </LinearGradient>
        </Animated.View>
      </View>

      <Text style={styles.disclaimer}>{config.disclaimers.upgrade}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  badgePill: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#fff3d0',
    borderWidth: 1,
    borderColor: '#ffd27f',
  },
  badgeText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    color: '#7d4d00',
  },
  headline: {
    marginTop: 22,
    fontSize: 44,
    lineHeight: 48,
    fontWeight: '900',
    color: '#111108',
  },
  subtitle: {
    marginTop: 10,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '800',
    color: '#1a160a',
    textAlign: 'center',
    maxWidth: 320,
  },
  cardZone: {
    marginTop: 28,
    width: '100%',
    maxWidth: 380,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardGlow: {
    position: 'absolute',
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: 'rgba(255,255,255,0.7)',
  },
  ticketWrap: {
    width: '100%',
  },
  ticket: {
    minHeight: 230,
    borderRadius: 36,
    paddingHorizontal: 26,
    paddingVertical: 28,
    justifyContent: 'center',
    shadowColor: '#c54d00',
    shadowOpacity: 0.28,
    shadowRadius: 20,
    elevation: 14,
  },
  ticketLabel: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '700',
    color: '#ffeacc',
  },
  ticketAmount: {
    marginTop: 12,
    fontSize: 72,
    lineHeight: 76,
    fontWeight: '900',
    color: '#fff',
  },
  arrowAsset: {
    position: 'absolute',
    right: 18,
    top: '50%',
    marginTop: -42,
    width: 84,
    height: 84,
  },
  arrowFallback: {
    position: 'absolute',
    right: 24,
    top: '50%',
    marginTop: -32,
    fontSize: 44,
    fontWeight: '900',
    color: '#fff7d0',
  },
  disclaimer: {
    marginTop: 18,
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: '#7a5d10',
    maxWidth: 320,
  },
});
