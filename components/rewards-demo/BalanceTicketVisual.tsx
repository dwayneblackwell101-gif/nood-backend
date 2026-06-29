import React, { memo, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import CardShine from './CardShine';
import GlassPanel from './GlassPanel';
import { DEMO_GOLD, DEMO_ORANGE, DEMO_PURPLE } from './theme';

type BalanceTicketVisualProps = {
  amountLabel: string;
  animateKey?: string | number;
  reducedMotion?: boolean;
};

const FLOAT_CHIPS = [
  { id: 'chip-a', label: 'N', colors: ['#9f79ff', '#5c31ff'] as const, offset: -14 },
  { id: 'chip-b', label: '$', colors: ['#ffb400', '#ff6a00'] as const, offset: 0 },
  { id: 'chip-c', label: 'N', colors: ['#ffb400', '#ff8a3d'] as const, offset: 14 },
];

function BalanceTicketVisual({
  amountLabel,
  animateKey = 0,
  reducedMotion = false,
}: BalanceTicketVisualProps) {
  const floatY = useSharedValue(0);
  const tilt = useSharedValue(0);
  const entry = useSharedValue(0);
  const chipFloat = useSharedValue(0);

  useEffect(() => {
    entry.value = 0;
    entry.value = withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) });

    if (reducedMotion) {
      floatY.value = 0;
      tilt.value = 0;
      chipFloat.value = 0;
      return;
    }

    floatY.value = withRepeat(
      withSequence(
        withTiming(-10, { duration: 2200, easing: Easing.inOut(Easing.sin) }),
        withTiming(6, { duration: 2200, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
    tilt.value = withRepeat(
      withSequence(
        withTiming(-2.5, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
        withTiming(2.5, { duration: 2600, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
    chipFloat.value = withRepeat(
      withSequence(
        withTiming(-6, { duration: 2000, easing: Easing.inOut(Easing.sin) }),
        withTiming(4, { duration: 2000, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
  }, [animateKey, chipFloat, entry, floatY, reducedMotion, tilt]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: entry.value,
    transform: [
      { translateY: floatY.value },
      { rotate: `${tilt.value}deg` },
      { scale: 0.92 + entry.value * 0.08 },
    ],
  }));

  const chipStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: chipFloat.value }],
  }));

  return (
    <View style={styles.stage}>
      <Animated.View style={[styles.chipRow, chipStyle]}>
        {FLOAT_CHIPS.map((chip) => (
          <LinearGradient key={chip.id} colors={[...chip.colors]} style={styles.floatChip}>
            <Text style={styles.floatChipText}>{chip.label}</Text>
          </LinearGradient>
        ))}
      </Animated.View>

      <Animated.View style={[styles.ticketStage, animatedStyle]}>
        <View style={styles.coinBackLeft}>
          <LinearGradient colors={['#ffb400', '#ff6a00']} style={styles.coin}>
            <Text style={styles.coinText}>$</Text>
          </LinearGradient>
        </View>
        <View style={styles.coinBackRight}>
          <LinearGradient colors={['#9f79ff', '#5c31ff']} style={styles.coinSmall}>
            <Text style={styles.coinTextSmall}>N</Text>
          </LinearGradient>
        </View>

        <GlassPanel glow padding={0} style={styles.ticketWrap}>
          <LinearGradient colors={['#ffffff', '#f7f2ff']} style={styles.ticket}>
            <CardShine disabled={reducedMotion} />
            <View style={styles.ticketTop}>
              <View style={styles.ticketBrand}>
                <Ionicons name="wallet" size={18} color={DEMO_PURPLE} />
                <Text style={styles.ticketBrandText}>NOOD Balance Ticket</Text>
              </View>
              <View style={styles.ticketChip}>
                <Text style={styles.ticketChipText}>Special</Text>
              </View>
            </View>

            <Text style={styles.ticketAmount}>{amountLabel}</Text>
            <Text style={styles.ticketSub}>Unlock through challenges</Text>

            <View style={styles.perforationRow}>
              {Array.from({ length: 14 }).map((_, index) => (
                <View key={`dot-${index}`} style={styles.perforationDot} />
              ))}
            </View>

            <View style={styles.ticketFooter}>
              <Text style={styles.ticketFooterLabel}>Reward tier</Text>
              <Text style={styles.ticketFooterValue}>Caribbean exclusive</Text>
            </View>
          </LinearGradient>
        </GlassPanel>
      </Animated.View>
    </View>
  );
}

export default memo(BalanceTicketVisual);

const styles = StyleSheet.create({
  stage: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 4,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 14,
    zIndex: 3,
  },
  floatChip: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  floatChipText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },
  ticketStage: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 230,
  },
  coinBackLeft: {
    position: 'absolute',
    left: '8%',
    top: 10,
    transform: [{ rotate: '-14deg' }],
    zIndex: 0,
  },
  coinBackRight: {
    position: 'absolute',
    right: '10%',
    top: 18,
    transform: [{ rotate: '12deg' }],
    zIndex: 0,
  },
  coin: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.65)',
  },
  coinSmall: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.55)',
  },
  coinText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '900',
  },
  coinTextSmall: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '900',
  },
  ticketWrap: {
    width: '88%',
    zIndex: 2,
  },
  ticket: {
    borderRadius: 26,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 16,
    overflow: 'hidden',
  },
  ticketTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  ticketBrand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  ticketBrandText: {
    color: DEMO_PURPLE,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  ticketChip: {
    backgroundColor: 'rgba(255, 106, 0, 0.18)',
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 106, 0, 0.38)',
  },
  ticketChipText: {
    color: '#e85d00',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  ticketAmount: {
    marginTop: 18,
    color: '#1a1037',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  ticketSub: {
    marginTop: 4,
    color: '#5b5675',
    fontSize: 14,
    fontWeight: '700',
  },
  perforationRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 18,
    marginBottom: 14,
    paddingHorizontal: 2,
  },
  perforationDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(92, 49, 255, 0.18)',
  },
  ticketFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  ticketFooterLabel: {
    color: '#6a6388',
    fontSize: 12,
    fontWeight: '700',
  },
  ticketFooterValue: {
    color: '#d99600',
    fontSize: 12,
    fontWeight: '900',
  },
});