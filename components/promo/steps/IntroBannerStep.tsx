import React, { useEffect } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import { getPromoAsset } from '../assets';
import type { PromoStepComponentProps } from '../types';

export function IntroBannerStep({ config }: PromoStepComponentProps) {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(26);
  const scale = useSharedValue(0.96);
  const arrowAsset = getPromoAsset(config.assets, 'arrowGlow');

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 320 });
    translateY.value = withSpring(0, { damping: 16, stiffness: 140 });
    scale.value = withSpring(1, { damping: 16, stiffness: 130 });
  }, [opacity, scale, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }, { scale: scale.value }],
  }));

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.bannerWrap, animatedStyle]}>
        <LinearGradient
          colors={['#ff9f1f', '#ff6b0a', '#ff4a10']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.banner}
        >
          <Text style={styles.smallLine}>{config.copy.headlineIntroSmall}</Text>
          <Text style={styles.bigLine}>{config.copy.headlineIntroBig}</Text>

          {arrowAsset ? (
            <Image source={arrowAsset} style={styles.arrowAsset} resizeMode="contain" />
          ) : (
            <View style={styles.arrowFallback}>
              <Text style={styles.arrowFallbackText}>→</Text>
            </View>
          )}
        </LinearGradient>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  bannerWrap: {
    width: '100%',
    maxWidth: 380,
  },
  banner: {
    minHeight: 168,
    borderRadius: 36,
    paddingHorizontal: 24,
    paddingVertical: 24,
    justifyContent: 'center',
    shadowColor: '#9b3700',
    shadowOpacity: 0.28,
    shadowRadius: 24,
    elevation: 16,
  },
  smallLine: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '700',
    color: '#fff3d0',
  },
  bigLine: {
    marginTop: 8,
    fontSize: 38,
    lineHeight: 42,
    fontWeight: '900',
    color: '#fff',
    maxWidth: 250,
  },
  arrowAsset: {
    position: 'absolute',
    right: 16,
    top: 20,
    width: 86,
    height: 86,
  },
  arrowFallback: {
    position: 'absolute',
    right: 20,
    top: '50%',
    marginTop: -28,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowFallbackText: {
    fontSize: 28,
    fontWeight: '900',
    color: '#fff',
  },
});
