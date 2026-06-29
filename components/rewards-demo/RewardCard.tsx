import React, { memo, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import CardShine from './CardShine';
import { DEMO_GOLD, DEMO_ORANGE } from './theme';

type RewardCardProps = {
  amountLabel: string;
  subtitle?: string;
  animateKey?: string | number;
  compact?: boolean;
  hero?: boolean;
};

function RewardCard({
  amountLabel,
  subtitle = 'NOOD Balance',
  animateKey = 0,
  compact = false,
  hero = false,
}: RewardCardProps) {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(24);
  const scale = useSharedValue(0.94);

  useEffect(() => {
    opacity.value = 0;
    translateY.value = 24;
    scale.value = 0.94;
    opacity.value = withDelay(120, withTiming(1, { duration: 420, easing: Easing.out(Easing.cubic) }));
    translateY.value = withDelay(120, withSpring(0, { damping: 16, stiffness: 180 }));
    scale.value = withDelay(120, withSpring(1, { damping: 14, stiffness: 200 }));
  }, [animateKey, opacity, scale, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }, { scale: scale.value }],
  }));

  return (
    <Animated.View
      style={[
        styles.wrap,
        compact && styles.wrapCompact,
        hero && styles.wrapHero,
        hero && styles.wrapHeroGlow,
        animatedStyle,
      ]}
    >
      <LinearGradient
        colors={
          hero
            ? ['rgba(255,255,255,0.3)', 'rgba(255,255,255,0.12)']
            : ['rgba(255,255,255,0.22)', 'rgba(255,255,255,0.08)']
        }
        style={[styles.gradient, hero && styles.gradientHero]}
      >
        {hero ? <CardShine /> : null}
        <View style={[styles.iconWrap, compact && styles.iconWrapCompact, hero && styles.iconWrapHero]}>
          <Ionicons name="wallet" size={compact ? 20 : hero ? 28 : 24} color={DEMO_ORANGE} />
        </View>
        <View style={styles.textWrap}>
          <Text style={[styles.amount, compact && styles.amountCompact, hero && styles.amountHero]}>
            {amountLabel}
          </Text>
          <Text style={[styles.subtitle, compact && styles.subtitleCompact, hero && styles.subtitleHero]}>
            {subtitle}
          </Text>
        </View>
        <View style={[styles.badge, hero && styles.badgeHero]}>
          <Text style={styles.badgeText}>Reward</Text>
        </View>
      </LinearGradient>
    </Animated.View>
  );
}

export default memo(RewardCard);

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  wrapCompact: {
    borderRadius: 20,
  },
  wrapHero: {
    borderRadius: 26,
    borderColor: 'rgba(255,255,255,0.32)',
  },
  wrapHeroGlow: {
    shadowColor: '#ffb400',
    shadowOpacity: 0.2,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  gradient: {
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    overflow: 'hidden',
  },
  gradientHero: {
    padding: 22,
    gap: 16,
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapCompact: {
    width: 46,
    height: 46,
    borderRadius: 14,
  },
  iconWrapHero: {
    width: 60,
    height: 60,
    borderRadius: 18,
  },
  textWrap: {
    flex: 1,
  },
  amount: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: -0.4,
  },
  amountCompact: {
    fontSize: 24,
  },
  amountHero: {
    fontSize: 30,
  },
  subtitle: {
    marginTop: 2,
    color: 'rgba(255,255,255,0.86)',
    fontSize: 14,
    fontWeight: '700',
  },
  subtitleCompact: {
    fontSize: 13,
  },
  subtitleHero: {
    fontSize: 15,
  },
  badge: {
    backgroundColor: 'rgba(255, 180, 0, 0.22)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 180, 0, 0.45)',
  },
  badgeHero: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  badgeText: {
    color: DEMO_GOLD,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
});