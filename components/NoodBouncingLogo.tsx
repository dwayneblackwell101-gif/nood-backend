import React, { useEffect } from 'react';
import { Image, StyleSheet, View, type ImageStyle, type StyleProp } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

const NOOD_LOGO_SOURCE = require('../assets/images/nood-splash-logo.png');

type NoodBouncingLogoProps = {
  width: number;
  height: number;
  imageStyle?: StyleProp<ImageStyle>;
  onAnimationStarted?: () => void;
  bounceEnabled?: boolean;
};

export default function NoodBouncingLogo({
  width,
  height,
  imageStyle,
  onAnimationStarted,
  bounceEnabled = true,
}: NoodBouncingLogoProps) {
  const bounce = useSharedValue(0);
  const logoScale = useSharedValue(bounceEnabled ? 0.96 : 1);

  useEffect(() => {
    if (!bounceEnabled) {
      onAnimationStarted?.();
      return;
    }

    logoScale.value = withTiming(1, { duration: 420, easing: Easing.out(Easing.back(1.1)) });
    bounce.value = withRepeat(
      withSequence(
        withTiming(-8, { duration: 750, easing: Easing.inOut(Easing.sin) }),
        withTiming(4, { duration: 750, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
    onAnimationStarted?.();
  }, [bounce, bounceEnabled, logoScale, onAnimationStarted]);

  const animatedLogoStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: bounce.value }, { scale: logoScale.value }],
  }));

  if (!bounceEnabled) {
    return (
      <View style={[styles.wrap, { width, height }]}>
        <Image
          source={NOOD_LOGO_SOURCE}
          resizeMode="contain"
          style={[styles.logo, imageStyle]}
        />
      </View>
    );
  }

  return (
    <Animated.View style={[styles.wrap, { width, height }, animatedLogoStyle]}>
      <Image
        source={NOOD_LOGO_SOURCE}
        resizeMode="contain"
        style={[styles.logo, imageStyle]}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: '100%',
    height: '100%',
  },
});