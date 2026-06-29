import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import ScratchDemoModal from '../components/scratch-prize/ScratchDemoModal';
import ScratchGameCard, { useScratchCardMotion } from '../components/scratch-prize/ScratchGameCard';
import ScratchHowItWorksModal from '../components/scratch-prize/ScratchHowItWorksModal';
import ScratchLockedPrizeCard from '../components/scratch-prize/ScratchLockedPrizeCard';
import ScratchPremiumButton from '../components/scratch-prize/ScratchPremiumButton';
import ScratchPrizeBackground from '../components/scratch-prize/ScratchPrizeBackground';
import ScratchPrizeChips from '../components/scratch-prize/ScratchPrizeChips';
import ScratchRewardPoolPanel from '../components/scratch-prize/ScratchRewardPoolPanel';
import ScratchSparkles from '../components/scratch-prize/ScratchSparkles';
import {
  SCRATCH_BG,
  SCRATCH_BORDER,
  SCRATCH_TEXT,
  SCRATCH_TEXT_MUTED,
} from '../components/scratch-prize/theme';
import { useUser } from '../context/UserContext';
import { getScratchCountdownParts } from '../utils/scratch-countdown';
import { SPECIAL_REWARD_USD_LABEL } from '../utils/reward-currency';
import {
  getScratchEligibility,
  markScratchPrizeCompleted,
  markScratchPrizeManualOpen,
  type ScratchEligibility,
} from '../utils/scratch-prize-popup';

type ScratchStep = 'hub' | 'game' | 'revealed';

function ScratchPrizeScreen() {
  const router = useRouter();
  const { isSignedIn, profileId } = useUser();
  const [loading, setLoading] = useState(true);
  const [eligibility, setEligibility] = useState<ScratchEligibility | null>(null);
  const [step, setStep] = useState<ScratchStep>('hub');
  const [revealed, setRevealed] = useState(false);
  const [scratchCount, setScratchCount] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [demoModalVisible, setDemoModalVisible] = useState(false);
  const [howItWorksVisible, setHowItWorksVisible] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  const { cardScale, coverOpacity, primeEntrance, scratchStep, finishReveal, resetCover } =
    useScratchCardMotion();
  const prizeLabel = SPECIAL_REWARD_USD_LABEL;

  const countdown = useMemo(
    () => getScratchCountdownParts(eligibility?.completedAt, nowMs),
    [eligibility?.completedAt, nowMs]
  );

  const tokenReady = Boolean(eligibility?.canPlay && (eligibility?.scratchTokens || 0) > 0);
  const onCooldown = !tokenReady;

  const hubStatusLabel = tokenReady
    ? 'Scratch Token Ready'
    : countdown?.statusLabel || 'Next Scratch Prize in 14 days';

  const lockedButtonLabel = countdown?.lockedButtonLabel || 'Locked';
  const primaryButtonLabel = tokenReady ? 'Scratch Now' : lockedButtonLabel;

  const refreshEligibility = useCallback(async () => {
    const status = await getScratchEligibility(isSignedIn ? profileId : undefined);
    setEligibility(status);
    return status;
  }, [isSignedIn, profileId]);

  useEffect(() => {
    markScratchPrizeManualOpen();
  }, []);

  useEffect(() => {
    if (__DEV__) {
      console.log('[Scratch Prize] Dev reset: await clearScratchPopupCooldown()');
    }
  }, []);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReducedMotion)
      .catch(() => setReducedMotion(false));
  }, []);

  useEffect(() => {
    let mounted = true;

    (async () => {
      setLoading(true);
      await refreshEligibility();
      if (mounted) {
        setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [refreshEligibility]);

  useEffect(() => {
    if (!onCooldown) return undefined;

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 60_000);

    return () => clearInterval(timer);
  }, [onCooldown]);

  useEffect(() => {
    if (step === 'game') {
      primeEntrance();
    }
  }, [primeEntrance, step]);

  const handleStartGame = useCallback(() => {
    if (!tokenReady) return;
    setScratchCount(0);
    setRevealed(false);
    resetCover();
    setStep('game');
  }, [resetCover, tokenReady]);

  const handleScratch = useCallback(() => {
    if (revealed || !tokenReady) return;

    const nextCount = scratchCount + 1;
    setScratchCount(nextCount);
    scratchStep(nextCount);

    if (nextCount >= 5) {
      setRevealed(true);
      finishReveal();
      void markScratchPrizeCompleted().then(() => refreshEligibility());
      setStep('revealed');
    }
  }, [finishReveal, refreshEligibility, revealed, scratchCount, scratchStep, tokenReady]);

  const handleClaimReward = useCallback(() => {
    setDemoModalVisible(true);
  }, []);

  const handlePlayAgain = useCallback(async () => {
    await refreshEligibility();
    setScratchCount(0);
    setRevealed(false);
    setStep('hub');
  }, [refreshEligibility]);

  const handleShopNow = useCallback(() => {
    router.replace('/(tabs)' as any);
  }, [router]);

  if (loading) {
    return (
      <View style={styles.loadingScreen}>
        <ScratchPrizeBackground reducedMotion />
        <ActivityIndicator size="large" color={SCRATCH_TEXT} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <ScratchPrizeBackground reducedMotion={reducedMotion} />

      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable style={styles.backButton} onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={22} color={SCRATCH_TEXT} />
          </Pressable>
          <Text style={styles.headerTitle}>Scratch Prize</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {step === 'hub' ? (
            <>
              <Text style={styles.title}>Unlock your Scratch Prize</Text>
              <Text style={styles.subtitle}>
                Earn a Scratch Token from NOOD activity to reveal your reward.
              </Text>

              <View style={styles.cardStage}>
                <ScratchLockedPrizeCard
                  statusLabel={hubStatusLabel}
                  ready={tokenReady}
                  reducedMotion={reducedMotion}
                />
              </View>

              <View style={styles.chipsWrap}>
                <ScratchPrizeChips />
              </View>

              <View style={styles.actions}>
                <ScratchPremiumButton
                  label={primaryButtonLabel}
                  onPress={handleStartGame}
                  disabled={!tokenReady}
                  locked={onCooldown}
                />
                {onCooldown ? (
                  <Text style={styles.helperText}>Your next Scratch Token unlocks soon.</Text>
                ) : null}
                <ScratchPremiumButton
                  label="How it works"
                  variant="secondary"
                  onPress={() => setHowItWorksVisible(true)}
                />
                {onCooldown ? (
                  <ScratchPremiumButton label="Shop Now" variant="glass" onPress={handleShopNow} />
                ) : null}
              </View>

              <View style={styles.poolWrap}>
                <ScratchRewardPoolPanel />
              </View>
            </>
          ) : null}

          {step === 'game' ? (
            <>
              <Text style={styles.title}>Reveal your NOOD reward</Text>
              <Text style={styles.subtitle}>Scratch the card to reveal your reward.</Text>

              <View style={styles.cardStage}>
                <ScratchGameCard
                  prizeLabel={prizeLabel}
                  prizeNote={
                    revealed
                      ? 'Reward added to your NOOD Balance.'
                      : 'Scratch to reveal your reward.'
                  }
                  scratchCount={scratchCount}
                  revealed={revealed}
                  onScratch={handleScratch}
                  cardScale={cardScale}
                  coverOpacity={coverOpacity}
                />
              </View>
            </>
          ) : null}

          {step === 'revealed' ? (
            <>
              <Text style={styles.title}>You revealed NOOD Balance</Text>
              <Text style={styles.subtitle}>Your Scratch Prize is ready.</Text>

              <View style={styles.cardStage}>
                <View style={styles.revealedCard}>
                  <ScratchSparkles active reducedMotion={reducedMotion} />
                  <Text style={styles.revealedKicker}>Reward</Text>
                  <Text style={styles.revealedValue}>{prizeLabel}</Text>
                  <Text style={styles.revealedNote}>Reward added to your NOOD Balance.</Text>
                </View>
              </View>

              <View style={styles.actions}>
                <ScratchPremiumButton label="Claim Reward" onPress={handleClaimReward} />
                <ScratchPremiumButton label="Play Again" variant="secondary" onPress={handlePlayAgain} />
                <ScratchPremiumButton label="Shop Now" variant="ghost" onPress={handleShopNow} />
              </View>
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>

      <ScratchDemoModal visible={demoModalVisible} onClose={() => setDemoModalVisible(false)} />
      <ScratchHowItWorksModal visible={howItWorksVisible} onClose={() => setHowItWorksVisible(false)} />
    </View>
  );
}

export default ScratchPrizeScreen;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: SCRATCH_BG,
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: SCRATCH_BG,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 10,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: SCRATCH_BORDER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: SCRATCH_TEXT,
    fontSize: 16,
    fontWeight: '900',
  },
  headerSpacer: {
    width: 44,
  },
  body: {
    paddingHorizontal: 22,
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 28,
  },
  title: {
    color: SCRATCH_TEXT,
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: -0.5,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 8,
    color: SCRATCH_TEXT_MUTED,
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 340,
  },
  cardStage: {
    marginTop: 24,
    width: '100%',
    alignItems: 'center',
  },
  chipsWrap: {
    marginTop: 20,
  },
  actions: {
    marginTop: 22,
    width: '100%',
    alignItems: 'center',
    gap: 10,
  },
  helperText: {
    color: SCRATCH_TEXT_MUTED,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: -2,
    marginBottom: 2,
  },
  poolWrap: {
    marginTop: 20,
    width: '100%',
    alignItems: 'center',
  },
  revealedCard: {
    width: '100%',
    maxWidth: 340,
    minHeight: 220,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,176,0,0.35)',
    overflow: 'hidden',
  },
  revealedKicker: {
    color: '#FFB000',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  revealedValue: {
    marginTop: 12,
    color: SCRATCH_TEXT,
    fontSize: 28,
    fontWeight: '900',
    textAlign: 'center',
  },
  revealedNote: {
    marginTop: 10,
    color: SCRATCH_TEXT_MUTED,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
});