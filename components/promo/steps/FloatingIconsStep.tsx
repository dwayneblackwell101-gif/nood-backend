import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Ionicons from '@expo/vector-icons/Ionicons';

import type { PromoStepComponentProps } from '../types';

const iconSet = [
  { key: 'gift', icon: 'gift-outline', color: '#ff8b1f', size: 56, top: '18%', left: '10%' },
  { key: 'cash', icon: 'cash-outline', color: '#ffe763', size: 64, top: '30%', right: '12%' },
  { key: 'coupon', icon: 'ticket-outline', color: '#ff5f1f', size: 58, top: '44%', left: '14%' },
  { key: 'wallet', icon: 'wallet-outline', color: '#ffffff', size: 62, top: '56%', right: '8%' },
  { key: 'cut', icon: 'cut-outline', color: '#ffd84c', size: 54, top: '64%', left: '20%' },
  { key: 'pricetag', icon: 'pricetag-outline', color: '#ff9d1a', size: 54, top: '24%', left: '50%' },
] as const;

function FloatingBubble({
  icon,
  color,
  size,
  style,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  size: number;
  style: object;
}) {
  const floatY = useSharedValue(0);
  const scale = useSharedValue(1);

  useEffect(() => {
    floatY.value = withRepeat(
      withSequence(
        withTiming(-12, { duration: 1900, easing: Easing.inOut(Easing.ease) }),
        withTiming(12, { duration: 1900, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      true
    );
    scale.value = withRepeat(
      withSequence(withTiming(1.04, { duration: 1400 }), withTiming(0.96, { duration: 1400 })),
      -1,
      true
    );
  }, [floatY, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: floatY.value }, { scale: scale.value }],
  }));

  return (
    <Animated.View style={[styles.bubble, style, animatedStyle]}>
      <Ionicons name={icon} size={size} color={color} />
    </Animated.View>
  );
}

export function FloatingIconsStep({ config }: PromoStepComponentProps) {
  const opacity = useSharedValue(0);
  const headlineY = useSharedValue(18);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 260 });
    headlineY.value = withTiming(0, { duration: 420, easing: Easing.out(Easing.cubic) });
  }, [headlineY, opacity]);

  const wrapperStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const headlineStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: headlineY.value }],
  }));

  return (
    <Animated.View style={[styles.container, wrapperStyle]}>
      <Animated.Text style={[styles.headline, headlineStyle]}>
        {config.copy.floatingHeadline}
      </Animated.Text>

      {iconSet.map((item) => (
        <FloatingBubble
          key={item.key}
          icon={item.icon}
          color={item.color}
          size={item.size}
          style={item}
        />
      ))}

      <View style={styles.appBadge}>
        <Text style={styles.appBadgeBrand}>{config.brandName}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(9,9,13,0.62)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  headline: {
    marginTop: -40,
    textAlign: 'center',
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '900',
    color: '#fff7d0',
    maxWidth: 320,
  },
  bubble: {
    position: 'absolute',
    width: 110,
    height: 110,
    borderRadius: 55,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    elevation: 8,
  },
  appBadge: {
    position: 'absolute',
    bottom: 108,
    width: 134,
    height: 134,
    borderRadius: 67,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ff7b16',
    borderWidth: 6,
    borderColor: '#ffe38c',
    shadowColor: '#ff8b1f',
    shadowOpacity: 0.34,
    shadowRadius: 24,
    elevation: 16,
  },
  appBadgeBrand: {
    fontSize: 32,
    fontWeight: '900',
    letterSpacing: 1,
    color: '#fff',
  },
});
