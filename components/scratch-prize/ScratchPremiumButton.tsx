import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { SCRATCH_BORDER, SCRATCH_ORANGE, SCRATCH_ORANGE_DEEP, SCRATCH_TEXT } from './theme';

type ScratchPremiumButtonProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'glass';
  disabled?: boolean;
  locked?: boolean;
  style?: ViewStyle;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function ScratchPremiumButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  locked = false,
  style,
}: ScratchPremiumButtonProps) {
  const scale = useSharedValue(1);
  const isLockedPrimary = variant === 'primary' && disabled && locked;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: disabled && !isLockedPrimary ? 0.45 : 1,
  }));

  const handlePressIn = () => {
    if (disabled) return;
    scale.value = withSpring(0.96, { damping: 18, stiffness: 320 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 14, stiffness: 260 });
  };

  if (variant === 'primary') {
    return (
      <AnimatedPressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[styles.base, animatedStyle, style]}
      >
        {isLockedPrimary ? (
          <View style={styles.lockedGradient}>
            <Text style={styles.lockedLabel}>{label}</Text>
          </View>
        ) : (
          <LinearGradient colors={[SCRATCH_ORANGE, SCRATCH_ORANGE_DEEP]} style={styles.primaryGradient}>
            <Text style={styles.primaryLabel}>{label}</Text>
          </LinearGradient>
        )}
      </AnimatedPressable>
    );
  }

  const variantStyle =
    variant === 'glass' ? styles.glass : variant === 'secondary' ? styles.secondary : styles.ghost;

  return (
    <AnimatedPressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[styles.base, variantStyle, animatedStyle, style]}
    >
      <Text
        style={[
          styles.secondaryLabel,
          variant === 'ghost' && styles.ghostLabel,
          variant === 'glass' && styles.glassLabel,
        ]}
      >
        {label}
      </Text>
    </AnimatedPressable>
  );
}

export default memo(ScratchPremiumButton);

const styles = StyleSheet.create({
  base: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 16,
    overflow: 'hidden',
  },
  primaryGradient: {
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  primaryLabel: {
    color: SCRATCH_TEXT,
    fontSize: 16,
    fontWeight: '900',
  },
  lockedGradient: {
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,106,0,0.42)',
  },
  lockedLabel: {
    color: SCRATCH_TEXT,
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.2,
  },
  secondary: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: SCRATCH_BORDER,
    paddingHorizontal: 20,
  },
  ghost: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  glass: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,106,0,0.45)',
    paddingHorizontal: 20,
  },
  secondaryLabel: {
    color: SCRATCH_TEXT,
    fontSize: 15,
    fontWeight: '800',
  },
  ghostLabel: {
    color: 'rgba(255,255,255,0.72)',
  },
  glassLabel: {
    color: SCRATCH_TEXT,
    fontWeight: '900',
  },
});