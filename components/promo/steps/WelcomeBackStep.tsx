import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import type { PromoStepComponentProps } from '../types';

export function WelcomeBackStep({ config }: PromoStepComponentProps) {
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.94);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 280 });
    scale.value = withSpring(1, { damping: 16, stiffness: 132 });
  }, [opacity, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.content, animatedStyle]}>
        <Text style={styles.lineOne}>{config.copy.welcomeLineOne}</Text>
        <Text style={styles.lineTwo}>{config.copy.welcomeLineTwo}</Text>

        <View style={styles.avatarWrap}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>{config.avatarInitials}</Text>
          </View>
          <Text numberOfLines={1} ellipsizeMode="tail" style={styles.username}>
            {config.username}
          </Text>
        </View>

        <Text style={styles.disclaimer}>{config.disclaimers.bottomSmallPrint}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  content: {
    width: '100%',
    alignItems: 'center',
  },
  lineOne: {
    fontSize: 44,
    lineHeight: 48,
    fontWeight: '900',
    color: '#14120b',
  },
  lineTwo: {
    fontSize: 56,
    lineHeight: 60,
    fontWeight: '900',
    color: '#14120b',
    marginTop: -2,
  },
  avatarWrap: {
    marginTop: 34,
    alignItems: 'center',
  },
  avatarCircle: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: '#fff7dd',
    borderWidth: 6,
    borderColor: '#ffbd36',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#f0a000',
    shadowOpacity: 0.28,
    shadowRadius: 18,
    elevation: 10,
  },
  avatarText: {
    fontSize: 34,
    fontWeight: '900',
    color: '#ff6f10',
  },
  username: {
    marginTop: 16,
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '800',
    color: '#222',
    maxWidth: 280,
  },
  disclaimer: {
    marginTop: 28,
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '600',
    color: '#7a6320',
    maxWidth: 320,
  },
});
