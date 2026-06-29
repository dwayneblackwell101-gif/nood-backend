import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { DEMO_PURPLE_DEEP } from './theme';

type DemoButtonProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  style?: ViewStyle;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function DemoButton({ label, onPress, variant = 'primary', style }: DemoButtonProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.96, { damping: 18, stiffness: 320 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 14, stiffness: 260 });
  };

  if (variant === 'primary') {
    return (
      <AnimatedPressable
        accessibilityRole="button"
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[styles.base, styles.primaryOuter, animatedStyle, style]}
      >
        <LinearGradient colors={['#ffffff', '#f4eeff']} style={styles.primaryGradient}>
          <Text style={[styles.label, styles.labelPrimary]}>{label}</Text>
        </LinearGradient>
      </AnimatedPressable>
    );
  }

  return (
    <AnimatedPressable
      accessibilityRole="button"
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[styles.base, variantStyles[variant], animatedStyle, style]}
    >
      {variant === 'secondary' ? <View pointerEvents="none" style={styles.secondaryHighlight} /> : null}
      <Text style={[styles.label, styles.labelSecondary]}>{label}</Text>
    </AnimatedPressable>
  );
}

export default memo(DemoButton);

const variantStyles = StyleSheet.create({
  secondary: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    overflow: 'hidden',
  },
  ghost: {
    backgroundColor: 'transparent',
  },
});

const styles = StyleSheet.create({
  base: {
    minHeight: 56,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  primaryOuter: {
    shadowColor: '#fff',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
    overflow: 'hidden',
  },
  primaryGradient: {
    width: '100%',
    minHeight: 56,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  secondaryHighlight: {
    position: 'absolute',
    top: 0,
    left: 16,
    right: 16,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  label: {
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.2,
  },
  labelPrimary: {
    color: DEMO_PURPLE_DEEP,
  },
  labelSecondary: {
    color: '#fff',
  },
});