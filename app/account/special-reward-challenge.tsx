import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import RequireSignIn from '../../components/RequireSignIn';
import BalanceTicketVisual from '../../components/rewards-demo/BalanceTicketVisual';
import CelebrationGlow from '../../components/rewards-demo/CelebrationGlow';
import CelebrationVisual from '../../components/rewards-demo/CelebrationVisual';
import ChallengePanel from '../../components/rewards-demo/ChallengePanel';
import DemoButton from '../../components/rewards-demo/DemoButton';
import FloatingShapes from '../../components/rewards-demo/FloatingShapes';
import GlassPanel from '../../components/rewards-demo/GlassPanel';
import LightConfetti from '../../components/rewards-demo/LightConfetti';
import SlideTransition from '../../components/rewards-demo/SlideTransition';
import SocialPostCard from '../../components/rewards-demo/SocialPostCard';
import StepIndicator from '../../components/rewards-demo/StepIndicator';
import { DEMO_GRADIENT } from '../../components/rewards-demo/theme';
import { useCart } from '../../context/CartContext';
import { useUser } from '../../context/UserContext';
import { copyToClipboard } from '../../utils/copy-to-clipboard';
import { noodAlert } from '../../utils/nood-alert';
import { markScratchPrizeManualOpen } from '../../utils/scratch-prize-popup';
import { SPECIAL_REWARD_USD_LABEL } from '../../utils/reward-currency';
import {
  buildFallbackRewardsStatus,
  claimSpecialReward,
  fetchRewardsStatus,
  getPrimaryChallenge,
  recordRewardShare,
  type RewardsStatusResponse,
} from '../../utils/rewards-api';

type ChallengeStep = 'intro' | 'challenge' | 'share' | 'unlocked';

const STEPS: ChallengeStep[] = ['intro', 'challenge', 'share', 'unlocked'];
const HEADER_TOP_EXTRA = 10;
const DEFAULT_REWARD_LABEL = SPECIAL_REWARD_USD_LABEL;
const NOOD_SHARE_TITLE = 'NOOD Rewards';
const NOOD_SHARE_URL = 'https://noodcaribbean.com';
const NOOD_SHARE_MESSAGE =
  'Join me on NOOD for premium fashion, trending finds, and daily reward challenges.';

async function triggerHaptic(type: 'light' | 'success' = 'light') {
  if (Platform.OS === 'web') return;

  try {
    if (type === 'success') {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  } catch {
    // Optional haptics.
  }
}

type ChallengeHeaderProps = {
  onBack: () => void;
  topInset: number;
};

function ChallengeHeader({ onBack, topInset }: ChallengeHeaderProps) {
  return (
    <View style={[styles.headerRow, { paddingTop: topInset + HEADER_TOP_EXTRA }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        hitSlop={10}
        onPress={onBack}
        style={styles.backButton}
      >
        <Ionicons name="arrow-back" size={22} color="#fff" />
      </Pressable>
      <Text style={styles.headerKicker}>Special reward</Text>
      <View style={styles.headerSpacer} />
    </View>
  );
}

type BottomActionDockProps = {
  bottomInset: number;
  children: React.ReactNode;
};

function BottomActionDock({ bottomInset, children }: BottomActionDockProps) {
  return (
    <GlassPanel variant="dock" padding={12} style={styles.actionDock}>
      <View style={[styles.actionDockInner, { paddingBottom: Math.max(bottomInset, 10) }]}>
        {children}
      </View>
    </GlassPanel>
  );
}

function SpecialRewardChallengeContent() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profileId } = useUser();
  const { syncWalletBalanceFromBackend } = useCart() as {
    syncWalletBalanceFromBackend?: (balanceTtd: number) => void;
  };

  const [stepIndex, setStepIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [status, setStatus] = useState<RewardsStatusResponse | null>(null);
  const [usingFallbackStatus, setUsingFallbackStatus] = useState(false);

  const step = STEPS[stepIndex];
  const challenge = useMemo(() => getPrimaryChallenge(status), [status]);

  const loadStatus = useCallback(async () => {
    if (!profileId) {
      setStatus(buildFallbackRewardsStatus('guest'));
      setUsingFallbackStatus(true);
      return;
    }

    const result = await fetchRewardsStatus(profileId);
    setStatus(result.status);
    setUsingFallbackStatus(result.usingFallback);
  }, [profileId]);

  useEffect(() => {
    markScratchPrizeManualOpen();
  }, []);

  useEffect(() => {
    let mounted = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) {
          setReducedMotion(enabled);
        }
      })
      .catch(() => null);

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    (async () => {
      setLoading(true);
      await loadStatus();
      if (mounted) {
        setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [loadStatus]);

  const refreshStatus = useCallback(async () => {
    await loadStatus();
  }, [loadStatus]);

  const goBack = useCallback(() => {
    router.back();
  }, [router]);

  const goNext = useCallback(() => {
    setStepIndex((current) => Math.min(current + 1, STEPS.length - 1));
  }, []);

  const skipStep = useCallback(() => {
    if (stepIndex >= STEPS.length - 1) {
      goBack();
      return;
    }
    goNext();
  }, [goBack, goNext, stepIndex]);

  const shareInviteMessage = useCallback(
    async (options?: { advanceOnSuccess?: boolean }) => {
      void triggerHaptic();

      const referralLink = String(challenge?.referralLink || '').trim();
      const referralCode = String(challenge?.referralCode || '').trim();
      const inviteUrl = referralLink || NOOD_SHARE_URL;
      const inviteMessage = referralCode
        ? `${NOOD_SHARE_MESSAGE} Use code ${referralCode}.`
        : NOOD_SHARE_MESSAGE;
      const fullText = `${inviteMessage} ${inviteUrl}`;

      if (!referralLink && !referralCode) {
        noodAlert(
          'Invite link unavailable',
          'Your personal invite link will appear once rewards sync.'
        );
        if (options?.advanceOnSuccess) {
          goNext();
        }
        return;
      }

      if (!usingFallbackStatus && profileId) {
        void recordRewardShare(profileId, 'invite').catch(() => null);
      }

      if (Platform.OS === 'web') {
        const copied = await copyToClipboard(fullText);
        if (copied) {
          noodAlert('Link copied', 'NOOD invite text copied to clipboard.');
          if (options?.advanceOnSuccess) {
            goNext();
          }
        } else {
          noodAlert('Share unavailable', 'Sharing is not available in this browser.');
        }
        return;
      }

      try {
        const shareOptions =
          Platform.OS === 'ios'
            ? {
                title: NOOD_SHARE_TITLE,
                message: inviteMessage,
                url: inviteUrl,
              }
            : {
                title: NOOD_SHARE_TITLE,
                message: fullText,
              };

        const result = await Share.share(shareOptions);

        if (__DEV__) {
          console.log('[SpecialReward] Invite share result:', result);
        }

        if (options?.advanceOnSuccess && result.action === Share.sharedAction) {
          goNext();
        }
      } catch (error) {
        if (__DEV__) {
          console.log('[SpecialReward] Invite share failed:', error);
        }

        const copied = await copyToClipboard(fullText);
        if (copied) {
          noodAlert(
            'Link copied',
            'Could not open share options. NOOD invite text copied to clipboard.'
          );
          if (options?.advanceOnSuccess) {
            goNext();
          }
        } else {
          noodAlert(
            'Share unavailable',
            'No sharing app is available on this device. Visit noodcaribbean.com to share manually.'
          );
        }
      }
    },
    [challenge?.referralCode, challenge?.referralLink, goNext, profileId, usingFallbackStatus]
  );

  const handleInviteFriends = useCallback(async () => {
    await shareInviteMessage({ advanceOnSuccess: true });
  }, [shareInviteMessage]);

  const handleShareNood = useCallback(async () => {
    await shareInviteMessage({ advanceOnSuccess: true });
  }, [shareInviteMessage]);

  const handleClaimReward = useCallback(async () => {
    if (!profileId) {
      noodAlert('Sign in required', 'Please sign in to claim your reward.');
      return;
    }

    if (!challenge) {
      noodAlert('Reward unavailable', 'Challenge status is not available yet.');
      return;
    }

    if (challenge.claimed || challenge.claimReason === 'already_claimed') {
      noodAlert('Already claimed', 'You have already claimed this reward.');
      return;
    }

    if (!challenge.eligibleToClaim) {
      noodAlert('Complete challenge first', 'Invite 5 friends within 7 days to unlock this reward.');
      return;
    }

    setClaiming(true);
    void triggerHaptic('success');

    try {
      const result = await claimSpecialReward(profileId);
      if (result.walletBalance != null) {
        syncWalletBalanceFromBackend?.(Number(result.walletBalance));
      }
      await refreshStatus();
      const claimedLabel = challenge.rewardLabel || DEFAULT_REWARD_LABEL;
      noodAlert('Reward claimed', `${claimedLabel} has been added to your wallet.`);
    } catch (error: any) {
      const message = String(error?.message || 'Could not claim reward.');
      if (message.toLowerCase().includes('already claimed')) {
        noodAlert('Already claimed', 'You have already claimed this reward.');
      } else if (message.toLowerCase().includes('complete challenge')) {
        noodAlert('Complete challenge first', 'Invite 5 friends within 7 days to unlock this reward.');
      } else {
        noodAlert('Claim failed', message);
      }
    } finally {
      setClaiming(false);
    }
  }, [challenge, profileId, refreshStatus, syncWalletBalanceFromBackend]);

  const handleShopNow = useCallback(() => {
    router.replace('/(tabs)');
  }, [router]);

  const rewardLabel = challenge?.rewardLabel || DEFAULT_REWARD_LABEL;
  const invitedCount = challenge?.invitedCount ?? 0;
  const inviteGoal = challenge?.inviteGoal ?? 5;
  const daysLeft = challenge?.daysLeft ?? 7;
  const claimed = Boolean(challenge?.claimed);
  const eligibleToClaim = Boolean(challenge?.eligibleToClaim);

  const claimButtonLabel = useMemo(() => {
    if (claiming) return 'Claiming...';
    if (claimed) return 'Already claimed';
    if (!eligibleToClaim) return 'Complete challenge first';
    return 'Claim Reward';
  }, [claimed, claiming, eligibleToClaim]);

  const socialBodyText = useMemo(() => {
    const referralLink = String(challenge?.referralLink || '').trim();
    const referralCode = String(challenge?.referralCode || '').trim();
    const inviteUrl = referralLink || NOOD_SHARE_URL;
    const inviteMessage = referralCode
      ? `${NOOD_SHARE_MESSAGE} Use code ${referralCode}.`
      : NOOD_SHARE_MESSAGE;
    return `${inviteMessage} ${inviteUrl}`;
  }, [challenge?.referralCode, challenge?.referralLink]);

  if (loading) {
    return (
      <View style={styles.loadingScreen}>
        <LinearGradient colors={[...DEMO_GRADIENT]} style={StyleSheet.absoluteFill} />
        <ActivityIndicator size="large" color="#fff" />
        <Text style={styles.loadingText}>Loading reward challenge...</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <LinearGradient colors={[...DEMO_GRADIENT]} style={StyleSheet.absoluteFill} />
      <FloatingShapes reducedMotion={reducedMotion} />
      <CelebrationGlow active={step === 'unlocked'} reducedMotion={reducedMotion} />
      <LightConfetti
        active={step === 'unlocked' && eligibleToClaim && !reducedMotion}
        continuous={step === 'unlocked' && eligibleToClaim}
      />

      <View style={styles.layout}>
        <ChallengeHeader onBack={goBack} topInset={insets.top} />
        {usingFallbackStatus ? (
          <View style={styles.syncBanner}>
            <Ionicons name="cloud-outline" size={14} color="#ffe08a" />
            <Text style={styles.syncBannerText}>Rewards are syncing. Try again shortly.</Text>
          </View>
        ) : null}
        <StepIndicator total={STEPS.length} activeIndex={stepIndex} reducedMotion={reducedMotion} />

        <SlideTransition stepKey={step} style={styles.slideWrap} reducedMotion={reducedMotion}>
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {step === 'intro' ? (
              <View style={styles.slideBody}>
                <View style={styles.copyBlock}>
                  <Text style={styles.title}>Unlock NOOD Balance</Text>
                  <Text style={styles.subtitle}>
                    Complete challenges, invite friends, and unlock NOOD Balance rewards.
                  </Text>
                </View>

                <View style={[styles.visualStage, styles.visualStageIntro]}>
                  <BalanceTicketVisual
                    amountLabel={rewardLabel}
                    animateKey={step}
                    reducedMotion={reducedMotion}
                  />
                </View>
              </View>
            ) : null}

            {step === 'challenge' ? (
              <View style={styles.slideBody}>
                <View style={styles.copyBlock}>
                  <Text style={styles.title}>Invite 5 friends in 7 days</Text>
                  <Text style={styles.subtitle}>
                    Bring your circle to NOOD and unlock your reward faster.
                  </Text>
                </View>

                <View style={styles.visualStage}>
                  <ChallengePanel
                    invitedCount={invitedCount}
                    inviteGoal={inviteGoal}
                    daysLeft={daysLeft}
                    rewardLabel={rewardLabel}
                    animateKey={`${step}-${invitedCount}`}
                  />
                </View>
              </View>
            ) : null}

            {step === 'share' ? (
              <View style={styles.slideBody}>
                <View style={styles.copyBlock}>
                  <Text style={styles.title}>Share NOOD and earn</Text>
                  <Text style={styles.subtitle}>
                    Post your invite and keep the challenge momentum going.
                  </Text>
                </View>

                <View style={styles.visualStage}>
                  <SocialPostCard animateKey={step} bodyText={socialBodyText} />
                </View>
              </View>
            ) : null}

            {step === 'unlocked' ? (
              <View style={styles.slideBody}>
                <View style={styles.copyBlock}>
                  <View style={styles.congratsBadge}>
                    <Ionicons name="sparkles" size={18} color="#fff" />
                    <Text style={styles.congratsBadgeText}>
                      {eligibleToClaim || claimed ? 'You did it' : 'Almost there'}
                    </Text>
                  </View>
                  <Text style={[styles.title, styles.titleCelebration]}>
                    {eligibleToClaim || claimed ? 'Congratulations' : 'Keep going'}
                  </Text>
                  <Text style={styles.subtitle}>
                    {eligibleToClaim || claimed
                      ? 'Your NOOD reward is ready'
                      : `Invite ${Math.max(inviteGoal - invitedCount, 0)} more friends to unlock`}
                  </Text>
                </View>

                <View style={styles.visualStage}>
                  <CelebrationVisual
                    amountLabel={rewardLabel}
                    animateKey={`${step}-${claimed ? 'claimed' : eligibleToClaim ? 'ready' : 'pending'}`}
                    reducedMotion={reducedMotion}
                    claimed={claimed}
                  />
                </View>
              </View>
            ) : null}
          </ScrollView>
        </SlideTransition>

        <BottomActionDock bottomInset={insets.bottom}>
          {step === 'intro' ? (
            <>
              <DemoButton label="Continue" onPress={goNext} />
              <DemoButton label="Skip" variant="secondary" onPress={skipStep} />
            </>
          ) : null}

          {step === 'challenge' ? (
            <>
              <DemoButton label="Invite Friends" onPress={() => void handleInviteFriends()} />
              <DemoButton label="Skip" variant="secondary" onPress={skipStep} />
            </>
          ) : null}

          {step === 'share' ? (
            <>
              <DemoButton label="Share NOOD" onPress={handleShareNood} />
              <DemoButton label="Continue" variant="secondary" onPress={goNext} />
            </>
          ) : null}

          {step === 'unlocked' ? (
            <>
              <DemoButton label={claimButtonLabel} onPress={handleClaimReward} />
              <DemoButton label="Shop Now" variant="secondary" onPress={handleShopNow} />
            </>
          ) : null}
        </BottomActionDock>
      </View>
    </View>
  );
}

export default function SpecialRewardChallengeScreen() {
  return (
    <RequireSignIn
      feature="rewards"
      title="Sign in to play"
      subtitle="Special Reward Challenge requires a signed-in NOOD account."
      icon="gift-outline"
    >
      <SpecialRewardChallengeContent />
    </RequireSignIn>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#2a1578',
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    backgroundColor: '#2a1578',
  },
  loadingText: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: 15,
    fontWeight: '700',
  },
  layout: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingBottom: 12,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  headerKicker: {
    flex: 1,
    textAlign: 'center',
    color: 'rgba(255,255,255,0.92)',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  headerSpacer: {
    width: 44,
  },
  syncBanner: {
    marginHorizontal: 18,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  syncBannerText: {
    flex: 1,
    color: 'rgba(255,255,255,0.9)',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 17,
  },
  slideWrap: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 22,
    paddingTop: 6,
    paddingBottom: 12,
  },
  slideBody: {
    flex: 1,
    minHeight: 400,
    gap: 12,
  },
  copyBlock: {
    gap: 8,
  },
  visualStage: {
    flex: 1,
    justifyContent: 'center',
    minHeight: 260,
  },
  visualStageIntro: {
    justifyContent: 'flex-start',
    minHeight: 300,
    paddingTop: 2,
  },
  title: {
    color: '#fff',
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: -0.6,
    lineHeight: 36,
  },
  titleCelebration: {
    fontSize: 34,
    lineHeight: 40,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
  },
  congratsBadge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    marginBottom: 4,
  },
  congratsBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  actionDock: {
    marginHorizontal: 14,
    marginBottom: 6,
  },
  actionDockInner: {
    gap: 10,
  },
});