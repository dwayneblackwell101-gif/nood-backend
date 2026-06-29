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
import RewardCard from './RewardCard';
import RewardSparkles from './RewardSparkles';
import { DEMO_GOLD, DEMO_ORANGE } from './theme';

type CelebrationVisualProps = {
  amountLabel: string;
  animateKey?: string | number;
  reducedMotion?: boolean;
  claimed?: boolean;
};

function CelebrationVisual({
  amountLabel,
  animateKey = 0,
  reducedMotion = false,
  claimed = false,
}: CelebrationVisualProps) {
  const bounce = useSharedValue(0);
  const crownScale = useSharedValue(0.9);

  useEffect(() => {
    crownScale.value = withTiming(1, { duration: 520, easing: Easing.out(Easing.back(1.4)) });

    if (reducedMotion) {
      bounce.value = 0;
      return;
    }

    bounce.value = withRepeat(
      withSequence(
        withTiming(-8, { duration: 1200, easing: Easing.inOut(Easing.sin) }),
        withTiming(4, { duration: 1200, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
      false
    );
  }, [animateKey, bounce, crownScale, reducedMotion]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: bounce.value }, { scale: crownScale.value }],
  }));

  return (
    <Animated.View style={[styles.stage, animatedStyle]}>
      <GlassPanel glow style={styles.chestWrap}>
        <LinearGradient colors={['rgba(255,255,255,0.28)', 'rgba(255,255,255,0.1)']} style={styles.chest}>
          <CardShine disabled={reducedMotion} />
          <View style={styles.crownRing}>
            <LinearGradient colors={['#ffb400', '#ff6a00']} style={styles.crownBadge}>
              <Ionicons name="trophy" size={30} color="#fff" />
            </LinearGradient>
          </View>
          <Text style={styles.chestTitle}>{claimed ? 'Reward ready to claim' : 'Reward unlocked'}</Text>
          <Text style={styles.chestSub}>Your NOOD Balance ticket is waiting</Text>
          <View style={styles.ticketStub}>
            <Ionicons name="ticket" size={18} color={DEMO_ORANGE} />
            <Text style={styles.ticketStubText}>NOOD Balance Ticket</Text>
          </View>
        </LinearGradient>
      </GlassPanel>

      <View style={styles.rewardCardWrap}>
        <RewardSparkles active reducedMotion={reducedMotion} />
        <RewardCard amountLabel={amountLabel} animateKey={animateKey} hero />
      </View>
    </Animated.View>
  );
}

export default memo(CelebrationVisual);

const styles = StyleSheet.create({
  stage: {
    width: '100%',
    minHeight: 340,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  chestWrap: {
    width: '92%',
  },
  chest: {
    borderRadius: 28,
    padding: 22,
    alignItems: 'center',
    overflow: 'hidden',
  },
  crownRing: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    marginBottom: 12,
  },
  crownBadge: {
    width: 64,
    height: 64,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chestTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
  },
  chestSub: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.94)',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 21,
    textAlign: 'center',
  },
  ticketStub: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.26)',
  },
  ticketStubText: {
    color: '#ffe08a',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  rewardCardWrap: {
    width: '100%',
    position: 'relative',
    minHeight: 110,
    justifyContent: 'center',
  },
});