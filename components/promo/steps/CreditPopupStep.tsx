import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Path } from 'react-native-svg';

import type { PromoStepComponentProps } from '../types';

export function CreditPopupStep({ config }: PromoStepComponentProps) {
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.88);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 260 });
    scale.value = withSpring(1, { damping: 15, stiffness: 138 });
  }, [opacity, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.popup, animatedStyle]}>
        <View style={styles.thumbWrap}>
          <Ionicons name="thumbs-up" size={36} color="#1e73ff" />
        </View>

        <Text style={styles.lineOne}>{config.copy.creditLineOne}</Text>
        <Text style={styles.lineTwo}>{config.copy.creditLineTwo}</Text>

        <View style={styles.chartWrap}>
          <Svg width={220} height={86} viewBox="0 0 220 86">
            <Path
              d="M8 68 C52 64, 72 40, 100 42 S156 34, 212 10"
              fill="none"
              stroke="#2f76ff"
              strokeWidth={6}
              strokeLinecap="round"
            />
          </Svg>

          <View style={styles.speechBubble}>
            <Text style={styles.speechBubbleText}>{config.copy.creditSpeechBubble}</Text>
          </View>
        </View>

        <Text style={styles.disclaimer}>{config.disclaimers.creditPopup}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(8,8,12,0.62)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 22,
  },
  popup: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 34,
    backgroundColor: '#ffffff',
    paddingHorizontal: 26,
    paddingTop: 28,
    paddingBottom: 22,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 22,
    elevation: 16,
  },
  thumbWrap: {
    width: 70,
    height: 70,
    borderRadius: 35,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eef4ff',
    alignSelf: 'center',
  },
  lineOne: {
    marginTop: 18,
    textAlign: 'center',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700',
    color: '#182135',
  },
  lineTwo: {
    marginTop: 6,
    textAlign: 'center',
    fontSize: 40,
    lineHeight: 44,
    fontWeight: '900',
    color: '#0f1728',
  },
  chartWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
  },
  speechBubble: {
    position: 'absolute',
    right: 18,
    top: -2,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#2f76ff',
  },
  speechBubbleText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#fff',
  },
  disclaimer: {
    marginTop: 6,
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 18,
    color: '#68718a',
    fontWeight: '600',
  },
});
