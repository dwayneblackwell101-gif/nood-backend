import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import type { PromoStepComponentProps } from '../types';

export function MissedGiftStep({ config }: PromoStepComponentProps) {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(40);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 240 });
    translateY.value = withSpring(0, { damping: 15, stiffness: 130 });
  }, [opacity, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <View style={styles.container}>
      <Text style={styles.lineOne}>{config.copy.visitLineOne}</Text>
      <Text style={styles.lineTwo}>{config.copy.visitLineTwo}</Text>

      <Animated.View style={[styles.cardWrap, animatedStyle]}>
        <LinearGradient colors={['#ff9620', '#ff5e11']} style={styles.ticketCard}>
          <View style={styles.mainTicketBody}>
            <Text style={styles.giftLabel}>{config.copy.previousGiftLabel}</Text>
            <Text style={styles.giftAmount}>
              {config.currencySymbol}
              {config.previousGiftAmount}
            </Text>
          </View>

          <View style={styles.missedStamp}>
            <Text style={styles.missedStampText}>MISSED</Text>
          </View>
        </LinearGradient>
      </Animated.View>

      <Text style={styles.disclaimer}>{config.disclaimers.missedGift}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  lineOne: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700',
    color: '#261800',
  },
  lineTwo: {
    marginTop: 6,
    fontSize: 40,
    lineHeight: 44,
    fontWeight: '900',
    color: '#1f1500',
    textAlign: 'center',
  },
  cardWrap: {
    width: '100%',
    maxWidth: 370,
    marginTop: 26,
  },
  ticketCard: {
    minHeight: 200,
    borderRadius: 32,
    overflow: 'hidden',
    shadowColor: '#a44400',
    shadowOpacity: 0.26,
    shadowRadius: 18,
    elevation: 12,
  },
  mainTicketBody: {
    justifyContent: 'center',
    paddingHorizontal: 26,
    paddingVertical: 26,
  },
  giftLabel: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
    color: '#ffe9cc',
  },
  giftAmount: {
    marginTop: 10,
    fontSize: 46,
    lineHeight: 50,
    fontWeight: '900',
    color: '#fff',
  },
  missedStamp: {
    position: 'absolute',
    right: 18,
    top: 18,
    transform: [{ rotate: '-13deg' }],
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#351900',
    borderWidth: 2,
    borderColor: '#ffcf9f',
  },
  missedStampText: {
    fontSize: 15,
    fontWeight: '900',
    color: '#ffecce',
    letterSpacing: 1.2,
  },
  disclaimer: {
    marginTop: 20,
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 18,
    color: '#7a5800',
    fontWeight: '600',
    maxWidth: 320,
  },
});
