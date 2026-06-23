import React, { useEffect } from 'react';
import { Dimensions, Image, ImageSourcePropType, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

const { width: screenWidth } = Dimensions.get('window');

type PromoBackgroundProps = {
  symbol?: string;
  variant?: 'gold' | 'dimmed-grid';
  showCenterGlow?: boolean;
  heroArt?: ImageSourcePropType | null;
};

const symbolRows = Array.from({ length: 8 }, (_, row) =>
  Array.from({ length: 5 }, (_, column) => `${row}-${column}`)
);

export function PromoBackground({
  symbol = '$',
  variant = 'gold',
  showCenterGlow = true,
  heroArt = null,
}: PromoBackgroundProps) {
  const shimmer = useSharedValue(0);

  useEffect(() => {
    shimmer.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 4200, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 4200, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
  }, [shimmer]);

  const glowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(shimmer.value, [0, 1], [0.22, 0.45]),
    transform: [{ scale: interpolate(shimmer.value, [0, 1], [0.92, 1.04]) }],
  }));

  return (
    <View style={StyleSheet.absoluteFill}>
      {variant === 'gold' ? (
        <>
          {heroArt ? (
            <Image source={heroArt} resizeMode="cover" style={styles.heroArt} />
          ) : null}
          <LinearGradient
            colors={
              heroArt
                ? ['rgba(255,233,105,0.86)', 'rgba(255,199,50,0.82)', 'rgba(255,178,33,0.9)']
                : ['#ffe969', '#ffc732', '#ffb221']
            }
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        </>
      ) : (
        <View style={styles.darkBackdrop}>
          <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill}>
            <View style={styles.productGrid}>
              {Array.from({ length: 9 }).map((_, index) => (
                <View key={index} style={styles.productCard}>
                  <View style={styles.productThumb} />
                  <View style={styles.productLineShort} />
                  <View style={styles.productLineLong} />
                </View>
              ))}
            </View>
          </BlurView>
        </View>
      )}

      {variant === 'gold' ? (
        <View style={styles.moneyGrid}>
          {symbolRows.map((row, rowIndex) => (
            <View key={rowIndex} style={styles.moneyRow}>
              {row.map((cell) => (
                <Animated.Text key={cell} style={[styles.moneySymbol, glowStyle]}>
                  {symbol}
                </Animated.Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}

      {showCenterGlow ? (
        <Animated.View style={[styles.centerGlow, glowStyle]}>
          <LinearGradient
            colors={['rgba(255,255,255,0.9)', 'rgba(255,221,116,0.55)', 'rgba(255,179,44,0)']}
            style={StyleSheet.absoluteFill}
            start={{ x: 0.5, y: 0.5 }}
            end={{ x: 1, y: 1 }}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  darkBackdrop: {
    flex: 1,
    backgroundColor: '#0d0d12',
  },
  heroArt: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.34,
  },
  productGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 140,
    justifyContent: 'space-between',
  },
  productCard: {
    width: screenWidth > 420 ? '30%' : '47%',
    minHeight: 156,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.08)',
    padding: 12,
    marginBottom: 12,
  },
  productThumb: {
    height: 90,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.13)',
  },
  productLineShort: {
    height: 12,
    width: '56%',
    borderRadius: 999,
    marginTop: 14,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  productLineLong: {
    height: 12,
    width: '82%',
    borderRadius: 999,
    marginTop: 10,
    backgroundColor: 'rgba(255,255,255,0.09)',
  },
  moneyGrid: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-evenly',
    paddingVertical: 80,
    pointerEvents: 'none',
  },
  moneyRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    opacity: 0.18,
  },
  moneySymbol: {
    fontSize: 44,
    fontWeight: '900',
    color: 'rgba(145, 92, 0, 0.46)',
  },
  centerGlow: {
    position: 'absolute',
    width: 340,
    height: 340,
    borderRadius: 170,
    left: '50%',
    top: '44%',
    marginLeft: -170,
    marginTop: -170,
    overflow: 'hidden',
  },
});
