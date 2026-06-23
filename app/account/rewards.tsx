import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AccessibilityInfo,
  Image,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCart } from '../../context/CartContext';
import { BASE_CURRENCY } from '../../utils/currency';

type Prize = {
  id: string;
  label: string;
  amount: number;
  unlockRequirement: number;
  weight: number;
  kind: 'reward' | 'try-again';
};

const PURPLE = '#5c31ff';
const PURPLE_SOFT = '#9f79ff';
const ORANGE = '#ff6a00';
const DAILY_SPIN_KEY = 'NOOD_LUCKY_SPIN_DAILY_LIMIT_V1';

const WHEEL_PRIZES: Prize[] = [
  { id: 'ttd-1', label: 'TTD $1', amount: 1, unlockRequirement: 25, weight: 38, kind: 'reward' },
  { id: 'ttd-2', label: 'TTD $2', amount: 2, unlockRequirement: 40, weight: 30, kind: 'reward' },
  { id: 'ttd-3', label: 'TTD $3', amount: 3, unlockRequirement: 50, weight: 16, kind: 'reward' },
  { id: 'ttd-5', label: 'TTD $5', amount: 5, unlockRequirement: 75, weight: 8, kind: 'reward' },
  { id: 'ttd-10', label: 'TTD $10', amount: 10, unlockRequirement: 150, weight: 2, kind: 'reward' },
  { id: 'try-again', label: '1 more chance', amount: 0, unlockRequirement: 0, weight: 6, kind: 'try-again' },
];

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function formatTtd(amount: number) {
  return `TTD $${Number(amount || 0).toFixed(0)}`;
}

function pickPrize() {
  const totalWeight = WHEEL_PRIZES.reduce((sum, prize) => sum + prize.weight, 0);
  let ticket = Math.random() * totalWeight;

  for (const prize of WHEEL_PRIZES) {
    ticket -= prize.weight;
    if (ticket <= 0) return prize;
  }

  return WHEEL_PRIZES[0];
}

async function haptic(type: 'light' | 'success' = 'light') {
  if (Platform.OS === 'web') return;

  try {
    if (type === 'success') {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  } catch {
    // Haptics are optional.
  }
}

function CoinBurst({ active, reducedMotion }: { active: boolean; reducedMotion: boolean }) {
  if (!active) return null;

  return (
    <View style={styles.coinLayer}>
      {Array.from({ length: reducedMotion ? 6 : 16 }).map((_, index) => (
        <Animated.View
          key={`coin-${index}`}
          entering={FadeIn.delay(index * 28).duration(160)}
          exiting={FadeOut.duration(120)}
          style={[
            styles.coin,
            {
              left: `${8 + ((index * 17) % 80)}%`,
              top: `${9 + ((index * 29) % 58)}%`,
            },
          ]}
        >
          <Text style={styles.coinText}>$</Text>
        </Animated.View>
      ))}
    </View>
  );
}

export default function RewardsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ autoSpin?: string }>();
  const spinRotation = useSharedValue(0);
  const loadingProgress = useSharedValue(0);
  const couponBob = useSharedValue(0);
  const pointerPulse = useSharedValue(1);
  const progressWidth = useSharedValue(0);
  const spinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spinClosedRef = useRef(false);
  const autoOpenedRef = useRef(false);
  const {
    balance = 0,
    balanceConverted = 0,
    orders = [],
    formatMoney,
    selectedCurrency = BASE_CURRENCY,
    convertPrice,
    lockedRewards = [],
    lockedBalanceFormatted = formatMoney?.(0, selectedCurrency) || '$0.00',
    refreshLockedRewards,
    addLockedReward,
  } = (useCart() as any) || {};

  const [modalVisible, setModalVisible] = useState(false);
  const [modalStep, setModalStep] = useState<'loading' | 'wheel' | 'reveal'>('loading');
  const [spinning, setSpinning] = useState(false);
  const [selectedPrize, setSelectedPrize] = useState<Prize | null>(null);
  const [lastSpinDate, setLastSpinDate] = useState('');
  const [reducedMotion, setReducedMotion] = useState(false);
  const [burstActive, setBurstActive] = useState(false);

  const today = useMemo(() => todayKey(), []);
  const canSpinToday = lastSpinDate !== today;

  const activeLockedRewards = useMemo(
    () => (Array.isArray(lockedRewards) ? lockedRewards : []).filter((reward: any) => reward?.status === 'locked'),
    [lockedRewards]
  );

  const unlockedRewards = useMemo(
    () => (Array.isArray(lockedRewards) ? lockedRewards : []).filter((reward: any) => reward?.status === 'unlocked').slice(0, 4),
    [lockedRewards]
  );

  const expiredRewards = useMemo(
    () => (Array.isArray(lockedRewards) ? lockedRewards : []).filter((reward: any) => reward?.status === 'expired').slice(0, 4),
    [lockedRewards]
  );

  const qualifyingSpend = useMemo(
    () =>
      (Array.isArray(orders) ? orders : []).reduce((sum: number, order: any) => {
        const total = Number(order?.total || 0);
        return total > 10 ? sum + total : sum;
      }, 0),
    [orders]
  );

  const leadReward = activeLockedRewards[0] || null;
  const leadProgress = leadReward
    ? Math.min(
        (Number(leadReward?.totalSpentTowardsUnlock || 0) /
          Math.max(Number(leadReward?.unlockRequirement || 1), 1)) *
          100,
        100
      )
    : 0;
  const spendLeft = leadReward
    ? Math.max(
        Number(leadReward?.unlockRequirement || 0) - Number(leadReward?.totalSpentTowardsUnlock || 0),
        0
      )
    : 0;

  const displayMoney = (amount: number, fromCurrency = BASE_CURRENCY) =>
    formatMoney?.(
      convertPrice?.(Number(amount || 0), fromCurrency || BASE_CURRENCY, selectedCurrency) ??
        Number(amount || 0),
      selectedCurrency
    ) || '$0.00';

  useEffect(() => {
    refreshLockedRewards?.();
  }, [refreshLockedRewards]);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion).catch(() => setReducedMotion(false));
    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReducedMotion);
    return () => subscription?.remove?.();
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(DAILY_SPIN_KEY)
      .then((value) => {
        if (value) setLastSpinDate(value);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    progressWidth.value = withTiming(leadProgress, {
      duration: reducedMotion ? 120 : 650,
      easing: Easing.out(Easing.cubic),
    });
  }, [leadProgress, progressWidth, reducedMotion]);

  useEffect(() => {
    couponBob.value = reducedMotion
      ? 0
      : withRepeat(
          withSequence(
            withTiming(1, { duration: 650, easing: Easing.inOut(Easing.cubic) }),
            withTiming(0, { duration: 650, easing: Easing.inOut(Easing.cubic) })
          ),
          -1,
          false
        );
  }, [couponBob, reducedMotion]);

  useEffect(
    () => () => {
      if (spinTimeoutRef.current) clearTimeout(spinTimeoutRef.current);
      if (loadingTimeoutRef.current) clearTimeout(loadingTimeoutRef.current);
    },
    []
  );

  const progressStyle = useAnimatedStyle(() => ({
    width: `${progressWidth.value}%`,
  }));

  const loadingStyle = useAnimatedStyle(() => ({
    width: `${loadingProgress.value}%`,
  }));

  const couponStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: couponBob.value * -8 }, { rotate: `${couponBob.value * 4 - 2}deg` }],
  }));

  const wheelStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spinRotation.value}deg` }],
  }));

  const pointerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pointerPulse.value }],
  }));

  const consumeDailySpin = useCallback(async () => {
    await AsyncStorage.setItem(DAILY_SPIN_KEY, today);
    setLastSpinDate(today);
  }, [today]);

  const openLuckySpin = useCallback(() => {
    spinClosedRef.current = false;
    setSelectedPrize(null);
    setModalStep('loading');
    setModalVisible(true);
    loadingProgress.value = 0;
    loadingProgress.value = withTiming(100, {
      duration: reducedMotion ? 350 : 1450,
      easing: Easing.out(Easing.cubic),
    });

    if (loadingTimeoutRef.current) clearTimeout(loadingTimeoutRef.current);
    loadingTimeoutRef.current = setTimeout(
      () => {
        if (!spinClosedRef.current) setModalStep('wheel');
      },
      reducedMotion ? 420 : 1520
    );
  }, [loadingProgress, reducedMotion]);

  useEffect(() => {
    if (autoOpenedRef.current || params.autoSpin !== '1') return;

    autoOpenedRef.current = true;
    const timer = setTimeout(() => {
      if (canSpinToday) {
        openLuckySpin();
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [canSpinToday, openLuckySpin, params.autoSpin]);

  const closeSpinModal = useCallback(() => {
    spinClosedRef.current = true;
    setModalVisible(false);
    setSpinning(false);
    setBurstActive(false);
    if (spinTimeoutRef.current) {
      clearTimeout(spinTimeoutRef.current);
      spinTimeoutRef.current = null;
    }
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
  }, []);

  const startSpin = useCallback(async () => {
    if (!canSpinToday || spinning) return;

    const prize = pickPrize();
    const prizeIndex = WHEEL_PRIZES.findIndex((item) => item.id === prize.id);
    const slice = 360 / WHEEL_PRIZES.length;
    const target = 360 * 7 + (360 - prizeIndex * slice) + slice / 2;

    setSpinning(true);
    setSelectedPrize(null);
    await consumeDailySpin();
    void haptic();

    spinRotation.value = 0;
    pointerPulse.value = withRepeat(
      withSequence(withTiming(1.14, { duration: 90 }), withTiming(1, { duration: 90 })),
      reducedMotion ? 4 : 18,
      false
    );
    spinRotation.value = withTiming(target, {
      duration: reducedMotion ? 950 : 4300,
      easing: Easing.out(Easing.cubic),
    });

    if (spinTimeoutRef.current) clearTimeout(spinTimeoutRef.current);
    spinTimeoutRef.current = setTimeout(
      () => {
        if (spinClosedRef.current) return;
        setSpinning(false);
        setSelectedPrize(prize);

        if (prize.kind === 'reward') {
          addLockedReward?.(prize.amount, prize.unlockRequirement, 'Lucky Spin reward', 48);
          refreshLockedRewards?.();
          setBurstActive(true);
          void haptic('success');
          setTimeout(() => setBurstActive(false), reducedMotion ? 700 : 1800);
        } else {
          void haptic();
        }

        setModalStep('reveal');
      },
      reducedMotion ? 1000 : 4350
    );
  }, [
    addLockedReward,
    canSpinToday,
    consumeDailySpin,
    pointerPulse,
    reducedMotion,
    refreshLockedRewards,
    spinRotation,
    spinning,
  ]);

  const continueShopping = useCallback(() => {
    closeSpinModal();
    router.push('/(tabs)');
  }, [closeSpinModal, router]);

  const viewRewards = useCallback(() => {
    closeSpinModal();
    refreshLockedRewards?.();
  }, [closeSpinModal, refreshLockedRewards]);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Rewards</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.heroCard}>
          <View style={styles.heroBadge}>
            <Text style={styles.heroBadgeText}>Locked Store Credit</Text>
          </View>
          <Text style={styles.heroTitle}>Spin small. Unlock with spend.</Text>
          <Text style={styles.heroCopy}>
            Lucky Spin rewards are locked store credit. They move to wallet only after the spend goal is reached.
          </Text>

          <View style={styles.heroStats}>
            <View style={styles.heroStatDark}>
              <Text style={styles.heroStatValuePurple}>{lockedBalanceFormatted}</Text>
              <Text style={styles.heroStatLabelDark}>Locked balance</Text>
            </View>
            <View style={styles.heroStatLight}>
              <Text style={styles.heroStatValueOrange}>
                {formatMoney?.(Number(balanceConverted || balance || 0), selectedCurrency) || '$0.00'}
              </Text>
              <Text style={styles.heroStatLabelLight}>Wallet</Text>
            </View>
          </View>

          <View style={styles.ruleRow}>
            <Ionicons name="bag-check-outline" size={18} color={PURPLE_SOFT} />
            <Text style={styles.ruleText}>Rewards are for qualifying orders only and are not withdrawable cash.</Text>
          </View>
        </View>

        <View style={styles.progressCard}>
          <View style={styles.progressHeader}>
            <View>
              <Text style={styles.sectionTitle}>Unlock progress</Text>
              <Text style={styles.sectionSubtitle}>
                {leadReward
                  ? `Spend ${displayMoney(spendLeft)} more to unlock`
                  : 'Spin to add a locked reward.'}
              </Text>
            </View>
            <Text style={styles.progressPercent}>{Math.floor(leadProgress)}%</Text>
          </View>

          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, progressStyle]} />
          </View>

          <Text style={styles.progressMeta}>
            {leadReward
              ? `${displayMoney(Number(leadReward?.totalSpentTowardsUnlock || 0))} / ${displayMoney(Number(leadReward?.unlockRequirement || 0))}`
              : 'No active locked reward yet'}
          </Text>
        </View>

        <View style={styles.luckyCard}>
          <View style={styles.luckyGlow} />
          <View style={styles.luckyTopRow}>
            <View style={styles.luckyIcon}>
              <Ionicons name="sparkles" size={25} color="#fff" />
            </View>
            <View style={styles.luckyTitleWrap}>
              <Text style={styles.luckyKicker}>One free spin per day</Text>
              <Text style={styles.luckyTitle}>Lucky Spin Wheel</Text>
              <Text style={styles.luckyCopy}>Win TTD $1-$10 locked store credit. TTD $10 is rare.</Text>
            </View>
          </View>

          <View style={styles.prizeStrip}>
            {WHEEL_PRIZES.map((prize) => (
              <View key={`strip-${prize.id}`} style={styles.prizePill}>
                <Text style={styles.prizePillText}>{prize.label}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.openSpinButton, !canSpinToday && styles.openSpinButtonDisabled]}
            activeOpacity={0.9}
            onPress={openLuckySpin}
          >
            <Text style={styles.openSpinButtonText}>
              {canSpinToday ? 'Lucky Spin' : 'Spin again tomorrow'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.lockedCard}>
          <View style={styles.sectionHeaderInline}>
            <Text style={styles.sectionTitle}>Locked rewards</Text>
            <Text style={styles.gamesPill}>{activeLockedRewards.length} open</Text>
          </View>

          {activeLockedRewards.length ? (
            activeLockedRewards.map((reward: any) => {
              const rewardProgress = Math.min(
                (Number(reward?.totalSpentTowardsUnlock || 0) /
                  Math.max(Number(reward?.unlockRequirement || 1), 1)) *
                  100,
                100
              );
              const rewardSpendLeft = Math.max(
                Number(reward?.unlockRequirement || 0) - Number(reward?.totalSpentTowardsUnlock || 0),
                0
              );
              const hoursLeft = Math.max(
                Math.ceil((new Date(reward?.expiresAt || 0).getTime() - Date.now()) / (1000 * 60 * 60)),
                0
              );

              return (
                <View key={reward?.id || `${reward?.amount}-${reward?.createdAt}`} style={styles.lockedRewardCard}>
                  <View style={styles.lockedRewardHeader}>
                    <View>
                      <Text style={styles.lockedRewardAmount}>
                        {formatTtd(Number(reward?.amount || 0))}
                      </Text>
                      <Text style={styles.lockedRewardNote}>{reward?.note || 'Locked reward'}</Text>
                    </View>
                    <Text style={styles.lockedRewardExpiry}>{hoursLeft}h left</Text>
                  </View>

                  <View style={styles.inlineTrack}>
                    <View style={[styles.inlineFill, { width: `${rewardProgress}%` }]} />
                  </View>

                  <Text style={styles.lockedRewardMeta}>
                    {formatTtd(Number(reward?.totalSpentTowardsUnlock || 0))} / {formatTtd(Number(reward?.unlockRequirement || 0))}
                  </Text>
                  <Text style={styles.lockedRewardHint}>
                    Spend {formatTtd(rewardSpendLeft)} more to unlock
                  </Text>
                </View>
              );
            })
          ) : (
            <Text style={styles.emptyCopy}>No active locked rewards yet. Spin once today to start.</Text>
          )}
        </View>

        <View style={styles.summaryRowWrap}>
          <View style={styles.summaryBoxDark}>
            <Text style={styles.summaryBoxValue}>{formatMoney?.(qualifyingSpend, selectedCurrency) || '$0.00'}</Text>
            <Text style={styles.summaryBoxLabelDark}>Qualifying spend</Text>
          </View>
          <View style={styles.summaryBoxLight}>
            <Text style={styles.summaryBoxValueOrange}>{unlockedRewards.length}</Text>
            <Text style={styles.summaryBoxLabelLight}>Unlocked rewards</Text>
          </View>
        </View>

        <View style={styles.activityCard}>
          <Text style={styles.sectionTitle}>Reward status</Text>

          {unlockedRewards.length ? (
            unlockedRewards.map((reward: any) => (
              <View key={`unlocked-${reward?.id || reward?.createdAt}`} style={styles.statusRow}>
                <View style={[styles.statusIconWrap, styles.statusIconSuccess]}>
                  <Ionicons name="checkmark" size={15} color={PURPLE} />
                </View>
                <View style={styles.statusTextWrap}>
                  <Text style={styles.statusTitle}>{formatTtd(Number(reward?.amount || 0))} moved to wallet</Text>
                  <Text style={styles.statusMeta}>{reward?.note || 'Unlocked reward'}</Text>
                </View>
              </View>
            ))
          ) : (
            <Text style={styles.emptyCopy}>No rewards have unlocked yet.</Text>
          )}

          {expiredRewards.length ? (
            <>
              <Text style={styles.expiredHeading}>Expired</Text>
              {expiredRewards.map((reward: any) => (
                <View key={`expired-${reward?.id || reward?.createdAt}`} style={styles.statusRow}>
                  <View style={[styles.statusIconWrap, styles.statusIconExpired]}>
                    <Ionicons name="close" size={15} color="#a76009" />
                  </View>
                  <View style={styles.statusTextWrap}>
                    <Text style={styles.statusTitle}>{formatTtd(Number(reward?.amount || 0))} expired</Text>
                    <Text style={styles.statusMeta}>The unlock goal was not reached in time.</Text>
                  </View>
                </View>
              ))}
            </>
          ) : null}
        </View>
      </ScrollView>

      <Modal transparent visible={modalVisible} animationType="fade" onRequestClose={closeSpinModal}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalClose} activeOpacity={0.85} onPress={closeSpinModal}>
            <Ionicons name="close" size={22} color="#fff" />
          </TouchableOpacity>

          {modalStep === 'loading' ? (
            <View style={styles.loadingBox}>
              <Animated.View style={[styles.couponIcon, couponStyle]}>
                <Image
                  source={require('../../assets/images/nood-brand-logo.png')}
                  style={styles.couponLogo}
                  resizeMode="contain"
                />
              </Animated.View>
              <View style={styles.loadingTrack}>
                <Animated.View style={[styles.loadingFill, loadingStyle]} />
              </View>
              <Text style={styles.loadingText}>Preparing your reward...</Text>
            </View>
          ) : null}

          {modalStep === 'wheel' ? (
            <View style={styles.wheelModalCard}>
              <Text style={styles.modalTitle}>Spin to win a locked reward</Text>
              <Text style={styles.modalSubtitle}>Rewards unlock after qualifying spend</Text>

              <View style={styles.wheelWrap}>
                <Animated.View style={[styles.pointer, pointerStyle]}>
                  <Ionicons name="location" size={44} color="#ffcf6a" />
                </Animated.View>
                <Animated.View style={[styles.wheel, wheelStyle]}>
                  {WHEEL_PRIZES.map((prize, index) => (
                    <View
                      key={`wheel-${prize.id}`}
                      style={[
                        styles.wheelPrize,
                        {
                          transform: [
                            { rotate: `${index * (360 / WHEEL_PRIZES.length)}deg` },
                            { translateY: -88 },
                          ],
                        },
                      ]}
                    >
                      <Text style={styles.wheelPrizeText}>{prize.label}</Text>
                    </View>
                  ))}
                  <View style={styles.wheelCenter}>
                    <Image
                      source={require('../../assets/images/nood-brand-logo.png')}
                      style={styles.wheelCenterLogo}
                      resizeMode="contain"
                    />
                  </View>
                </Animated.View>
              </View>

              <TouchableOpacity
                style={[styles.spinButton, (!canSpinToday || spinning) && styles.spinButtonDisabled]}
                activeOpacity={0.9}
                disabled={!canSpinToday || spinning}
                onPress={() => void startSpin()}
              >
                <Text style={styles.spinButtonText}>
                  {spinning ? 'Spinning...' : canSpinToday ? 'Spin' : 'Spin again tomorrow'}
                </Text>
              </TouchableOpacity>
              <Text style={styles.qualifyingText}>Reward is provided for qualifying orders only.</Text>
            </View>
          ) : null}

          {modalStep === 'reveal' && selectedPrize ? (
            <View style={styles.revealCard}>
              <View style={styles.revealGlow} />
              <Text style={styles.revealKicker}>
                {selectedPrize.kind === 'reward' ? 'Locked reward added' : 'Lucky Spin'}
              </Text>
              <Text style={styles.revealTitle}>
                {selectedPrize.kind === 'reward'
                  ? `You won ${selectedPrize.label} locked reward`
                  : 'Try again tomorrow'}
              </Text>
              <Text style={styles.revealCopy}>
                {selectedPrize.kind === 'reward'
                  ? `Spend ${formatTtd(selectedPrize.unlockRequirement)} to unlock`
                  : 'No reward was added this spin.'}
              </Text>
              <View style={styles.revealActions}>
                <TouchableOpacity style={styles.revealSecondary} activeOpacity={0.9} onPress={continueShopping}>
                  <Text style={styles.revealSecondaryText}>Continue Shopping</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.revealPrimary} activeOpacity={0.9} onPress={viewRewards}>
                  <Text style={styles.revealPrimaryText}>View Rewards</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          <CoinBurst active={burstActive} reducedMotion={reducedMotion} />
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#080a10',
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    marginBottom: 22,
  },
  backButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#141925',
    borderWidth: 1,
    borderColor: '#222938',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '900',
  },
  headerSpacer: {
    width: 42,
  },
  content: {
    paddingBottom: 26,
  },
  heroCard: {
    backgroundColor: '#121826',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: '#21283a',
    padding: 18,
    marginBottom: 16,
  },
  heroBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#1a2030',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 12,
  },
  heroBadgeText: {
    color: PURPLE_SOFT,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  heroTitle: {
    color: '#fff',
    fontSize: 25,
    fontWeight: '900',
    marginBottom: 8,
  },
  heroCopy: {
    color: '#adb4c2',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 18,
  },
  heroStats: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 14,
  },
  heroStatDark: {
    flex: 1,
    backgroundColor: '#0c111b',
    borderRadius: 20,
    padding: 16,
  },
  heroStatLight: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
  },
  heroStatValuePurple: {
    color: PURPLE_SOFT,
    fontSize: 23,
    fontWeight: '900',
    marginBottom: 6,
  },
  heroStatValueOrange: {
    color: ORANGE,
    fontSize: 22,
    fontWeight: '900',
    marginBottom: 6,
  },
  heroStatLabelDark: {
    color: '#aab1be',
    fontSize: 13,
    fontWeight: '700',
  },
  heroStatLabelLight: {
    color: '#666',
    fontSize: 13,
    fontWeight: '700',
  },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  ruleText: {
    color: '#d2d9e4',
    fontSize: 13,
    fontWeight: '700',
    marginLeft: 10,
    flex: 1,
  },
  progressCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: '#f2e5d8',
    marginBottom: 16,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  sectionTitle: {
    color: '#111',
    fontSize: 18,
    fontWeight: '900',
  },
  sectionSubtitle: {
    marginTop: 5,
    color: '#666',
    fontSize: 13,
    lineHeight: 18,
    maxWidth: 240,
  },
  progressPercent: {
    color: PURPLE,
    fontSize: 22,
    fontWeight: '900',
  },
  progressTrack: {
    height: 14,
    borderRadius: 999,
    backgroundColor: '#f0e8df',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: PURPLE,
  },
  progressMeta: {
    marginTop: 10,
    color: '#444',
    fontSize: 13,
    fontWeight: '800',
  },
  luckyCard: {
    backgroundColor: '#17112c',
    borderRadius: 26,
    padding: 18,
    borderWidth: 1,
    borderColor: '#3f2b84',
    overflow: 'hidden',
    marginBottom: 16,
  },
  luckyGlow: {
    position: 'absolute',
    right: -38,
    top: -48,
    width: 170,
    height: 170,
    borderRadius: 85,
    backgroundColor: 'rgba(107, 70, 255, 0.28)',
  },
  luckyTopRow: {
    flexDirection: 'row',
    gap: 14,
  },
  luckyIcon: {
    width: 58,
    height: 58,
    borderRadius: 18,
    backgroundColor: PURPLE,
    borderWidth: 1,
    borderColor: PURPLE_SOFT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  luckyTitleWrap: {
    flex: 1,
  },
  luckyKicker: {
    color: '#ffb400',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 5,
  },
  luckyTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
  },
  luckyCopy: {
    color: '#aab1be',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 5,
  },
  prizeStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 16,
  },
  prizePill: {
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  prizePillText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '900',
  },
  openSpinButton: {
    marginTop: 18,
    minHeight: 54,
    borderRadius: 18,
    backgroundColor: ORANGE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  openSpinButtonDisabled: {
    backgroundColor: '#59606d',
  },
  openSpinButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '900',
  },
  lockedCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: '#f2e5d8',
    marginBottom: 16,
  },
  sectionHeaderInline: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  gamesPill: {
    color: PURPLE,
    fontSize: 12,
    fontWeight: '900',
    backgroundColor: '#f1ecff',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  lockedRewardCard: {
    backgroundColor: '#fff8f0',
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: '#f5dec8',
    marginTop: 12,
  },
  lockedRewardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  lockedRewardAmount: {
    color: '#111',
    fontSize: 18,
    fontWeight: '900',
  },
  lockedRewardNote: {
    color: '#666',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 3,
  },
  lockedRewardExpiry: {
    color: '#c25a00',
    fontSize: 12,
    fontWeight: '900',
  },
  inlineTrack: {
    height: 12,
    borderRadius: 999,
    backgroundColor: '#eddcc8',
    overflow: 'hidden',
  },
  inlineFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: PURPLE,
  },
  lockedRewardMeta: {
    marginTop: 8,
    color: '#555',
    fontSize: 12,
    fontWeight: '800',
  },
  lockedRewardHint: {
    marginTop: 4,
    color: '#111',
    fontSize: 13,
    fontWeight: '900',
  },
  summaryRowWrap: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  summaryBoxDark: {
    flex: 1,
    backgroundColor: '#121826',
    borderRadius: 22,
    padding: 18,
    borderWidth: 1,
    borderColor: '#21283a',
  },
  summaryBoxLight: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 22,
    padding: 18,
    borderWidth: 1,
    borderColor: '#f2e5d8',
  },
  summaryBoxValue: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '900',
    marginBottom: 6,
  },
  summaryBoxValueOrange: {
    color: ORANGE,
    fontSize: 22,
    fontWeight: '900',
    marginBottom: 6,
  },
  summaryBoxLabelDark: {
    color: '#aab1be',
    fontSize: 13,
    fontWeight: '700',
  },
  summaryBoxLabelLight: {
    color: '#666',
    fontSize: 13,
    fontWeight: '700',
  },
  activityCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: '#f2e5d8',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#f1e9df',
  },
  statusIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  statusIconSuccess: {
    backgroundColor: '#f1ecff',
  },
  statusIconExpired: {
    backgroundColor: '#fff2e5',
  },
  statusTextWrap: {
    flex: 1,
  },
  statusTitle: {
    color: '#111',
    fontSize: 14,
    fontWeight: '800',
  },
  statusMeta: {
    marginTop: 3,
    color: '#666',
    fontSize: 12,
  },
  expiredHeading: {
    color: '#111',
    fontSize: 15,
    fontWeight: '900',
    marginTop: 12,
  },
  emptyCopy: {
    color: '#666',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  modalClose: {
    position: 'absolute',
    top: 46,
    right: 20,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  loadingBox: {
    width: '100%',
    alignItems: 'center',
  },
  couponIcon: {
    width: 86,
    height: 62,
    borderRadius: 15,
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: ORANGE,
    marginBottom: 24,
  },
  couponLogo: {
    width: 64,
    height: 34,
  },
  loadingTrack: {
    width: '84%',
    height: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.28)',
    overflow: 'hidden',
  },
  loadingFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: ORANGE,
  },
  loadingText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
    marginTop: 22,
  },
  wheelModalCard: {
    width: '100%',
    alignItems: 'center',
  },
  modalTitle: {
    color: '#fff',
    fontSize: 25,
    fontWeight: '900',
    textAlign: 'center',
  },
  modalSubtitle: {
    color: '#d4ccd9',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 7,
    marginBottom: 18,
  },
  wheelWrap: {
    width: 310,
    height: 330,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pointer: {
    position: 'absolute',
    top: 0,
    zIndex: 4,
  },
  wheel: {
    width: 278,
    height: 278,
    borderRadius: 139,
    backgroundColor: '#fff1dc',
    borderWidth: 10,
    borderColor: '#241910',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#ffb400',
    shadowOpacity: 0.32,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  wheelPrize: {
    position: 'absolute',
    width: 92,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wheelPrizeText: {
    color: '#4b1c0f',
    fontSize: 13,
    fontWeight: '900',
    textAlign: 'center',
  },
  wheelCenter: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: '#171717',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#fff',
  },
  wheelCenterLogo: {
    width: 58,
    height: 32,
  },
  spinButton: {
    width: '86%',
    minHeight: 58,
    borderRadius: 999,
    backgroundColor: ORANGE,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#ffb15c',
  },
  spinButtonDisabled: {
    backgroundColor: '#6f635a',
    borderColor: '#8a7d73',
  },
  spinButtonText: {
    color: '#fff',
    fontSize: 19,
    fontWeight: '900',
  },
  qualifyingText: {
    color: '#d4ccd9',
    fontSize: 13,
    marginTop: 16,
    textAlign: 'center',
  },
  revealCard: {
    width: '100%',
    maxWidth: 370,
    borderRadius: 28,
    backgroundColor: '#121826',
    borderWidth: 1,
    borderColor: PURPLE_SOFT,
    padding: 24,
    alignItems: 'center',
    overflow: 'hidden',
  },
  revealGlow: {
    position: 'absolute',
    top: -70,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: 'rgba(159,121,255,0.28)',
  },
  revealKicker: {
    color: '#ffb400',
    fontSize: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  revealTitle: {
    color: '#fff',
    fontSize: 25,
    lineHeight: 32,
    fontWeight: '900',
    textAlign: 'center',
    marginTop: 12,
  },
  revealCopy: {
    color: '#d2d9e4',
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: 10,
  },
  revealActions: {
    width: '100%',
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
  },
  revealSecondary: {
    flex: 1,
    minHeight: 50,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  revealSecondaryText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '900',
  },
  revealPrimary: {
    flex: 1,
    minHeight: 50,
    borderRadius: 16,
    backgroundColor: ORANGE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  revealPrimaryText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '900',
  },
  coinLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 18,
    pointerEvents: 'none',
  },
  coin: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#ffb400',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#ffe59d',
  },
  coinText: {
    color: '#111',
    fontSize: 15,
    fontWeight: '900',
  },
});
