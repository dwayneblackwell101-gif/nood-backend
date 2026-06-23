import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

type Reward = {
  points: number;
  label: string;
  kicker: string;
};

type PromoGameModalProps = {
  visible: boolean;
  onClose: () => void;
  playsLeft: number;
  lockedReason?: string;
  onClaimReward: (reward: Reward) => void;
};

const REWARD_POOL: Reward[] = [
  { points: 2, label: '2 Points', kicker: 'Tiny drop landed' },
  { points: 4, label: '4 Points', kicker: 'Street bonus unlocked' },
  { points: 7, label: '7 Points', kicker: 'Lucky tap' },
  { points: 10, label: '10 Points', kicker: 'Rare drop energy' },
];

export default function PromoGameModal({
  visible,
  onClose,
  playsLeft,
  lockedReason,
  onClaimReward,
}: PromoGameModalProps) {
  const fade = useRef(new Animated.Value(0)).current;
  const cardLift = useRef(new Animated.Value(24)).current;
  const cardScale = useRef(new Animated.Value(0.92)).current;
  const glowPulse = useRef(new Animated.Value(0.6)).current;
  const packBob = useRef(new Animated.Value(0)).current;
  const rewardScale = useRef(new Animated.Value(0.9)).current;
  const rewardOpacity = useRef(new Animated.Value(0)).current;

  const [revealed, setRevealed] = useState(false);
  const [reward, setReward] = useState<Reward | null>(null);

  const selectedReward = useMemo(
    () => REWARD_POOL[Math.floor(Math.random() * REWARD_POOL.length)],
    [visible]
  );

  useEffect(() => {
    if (!visible) {
      fade.setValue(0);
      cardLift.setValue(24);
      cardScale.setValue(0.92);
      glowPulse.setValue(0.6);
      packBob.setValue(0);
      rewardScale.setValue(0.9);
      rewardOpacity.setValue(0);
      setRevealed(false);
      setReward(null);
      return;
    }

    Vibration.vibrate(30);
    setReward(selectedReward);

    Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(cardLift, {
        toValue: 0,
        duration: 360,
        easing: Easing.out(Easing.back(1.2)),
        useNativeDriver: true,
      }),
      Animated.timing(cardScale, {
        toValue: 1,
        duration: 360,
        easing: Easing.out(Easing.back(1.05)),
        useNativeDriver: true,
      }),
    ]).start();

    const glowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowPulse, {
          toValue: 1,
          duration: 1100,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(glowPulse, {
          toValue: 0.62,
          duration: 1100,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    const bobLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(packBob, {
          toValue: -8,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(packBob, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    glowLoop.start();
    bobLoop.start();

    return () => {
      glowLoop.stop();
      bobLoop.stop();
    };
  }, [cardLift, cardScale, fade, glowPulse, packBob, rewardOpacity, rewardScale, selectedReward, visible]);

  const handleReveal = () => {
    if (revealed || !reward || playsLeft <= 0) {
      if (playsLeft <= 0) {
        Vibration.vibrate([0, 30, 40, 30]);
      }
      return;
    }

    setRevealed(true);
    Vibration.vibrate(45);

    Animated.parallel([
      Animated.timing(rewardOpacity, {
        toValue: 1,
        duration: 240,
        useNativeDriver: true,
      }),
      Animated.timing(rewardScale, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.back(1.4)),
        useNativeDriver: true,
      }),
      Animated.timing(packBob, {
        toValue: -18,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const handleClaim = () => {
    if (!reward || playsLeft <= 0) {
      Vibration.vibrate([0, 30, 40, 30]);
      return;
    }

    Vibration.vibrate([0, 40, 50, 60]);
    onClaimReward(reward);
    onClose();
  };

  const isLocked = playsLeft <= 0;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.overlay, { opacity: fade }]}>
        <Pressable style={styles.backdropTapZone} onPress={onClose} />

        <Animated.View
          style={[
            styles.modalCard,
            {
              transform: [{ translateY: cardLift }, { scale: cardScale }],
            },
          ]}
        >
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Ionicons name="close" size={22} color="#fff" />
          </TouchableOpacity>

          <Text style={styles.eyebrow}>NOOD Arcade Drop</Text>
          <Text style={styles.title}>Low-drop arcade for real buyers</Text>
          <Text style={styles.subtitle}>
            Each play is unlocked by spend. Rewards are intentionally small so the grind stays valuable.
          </Text>

          <View style={styles.playsBadge}>
            <Text style={styles.playsBadgeText}>{playsLeft} purchased plays available</Text>
          </View>

          <View style={styles.stage}>
            <Animated.View
              style={[
                styles.purpleGlow,
                {
                  opacity: glowPulse,
                  transform: [{ scale: glowPulse }],
                },
              ]}
            />

            <Animated.View style={[styles.goldGlow, { opacity: glowPulse }]}>
              <View style={styles.goldGlowInner} />
            </Animated.View>

            <Animated.View
              style={[
                styles.rewardPackWrap,
                { transform: [{ translateY: packBob }] },
              ]}
            >
              <View style={styles.rewardPack}>
                <View style={styles.packTop}>
                  <Text style={styles.packTopText}>NOOD DROP</Text>
                </View>
                <View style={styles.packBody}>
                  <Text style={styles.packBodyMain}>STYLE</Text>
                  <Text style={styles.packBodySub}>ARCADE</Text>
                </View>
                <View style={styles.packBottom} />
              </View>

              <View style={styles.packShadow} />
            </Animated.View>

            <View style={styles.sparkRow}>
              <View style={[styles.spark, styles.sparkOne]} />
              <View style={[styles.spark, styles.sparkTwo]} />
              <View style={[styles.spark, styles.sparkThree]} />
            </View>

            <Animated.View
              style={[
                styles.rewardReveal,
                {
                  opacity: rewardOpacity,
                  transform: [{ scale: rewardScale }],
                },
              ]}
            >
              <Text style={styles.rewardKicker}>{reward?.kicker}</Text>
              <Text style={styles.rewardValue}>{reward?.label}</Text>
              <Text style={styles.rewardHint}>Stack points slowly, then exchange for wallet credit</Text>
            </Animated.View>
          </View>

          {!revealed ? (
            <TouchableOpacity
              style={[styles.primaryButton, isLocked && styles.primaryButtonDisabled]}
              onPress={handleReveal}
              disabled={isLocked}
            >
              <Text style={styles.primaryButtonText}>{isLocked ? 'Spin locked' : 'Crack the pack'}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.primaryButton, isLocked && styles.primaryButtonDisabled]}
              onPress={handleClaim}
              disabled={isLocked}
            >
              <Text style={styles.primaryButtonText}>{isLocked ? 'Spin locked' : 'Claim points'}</Text>
            </TouchableOpacity>
          )}

          {lockedReason ? <Text style={styles.lockedCopy}>{lockedReason}</Text> : null}

          <Text style={styles.footnote}>
            2000 points are needed for $10 wallet credit. Customers get 1 spin for every $5 spent.
          </Text>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(7, 8, 14, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 18,
  },
  backdropTapZone: {
    ...StyleSheet.absoluteFillObject,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 30,
    backgroundColor: '#0d1018',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  closeButton: {
    position: 'absolute',
    top: 14,
    right: 14,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 3,
  },
  eyebrow: {
    alignSelf: 'flex-start',
    backgroundColor: '#191d29',
    color: '#9f79ff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
    marginBottom: 14,
  },
  title: {
    color: '#fff',
    fontSize: 28,
    lineHeight: 32,
    fontWeight: '900',
    maxWidth: '82%',
  },
  subtitle: {
    color: '#b0b7c4',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
    marginBottom: 18,
    maxWidth: '88%',
  },
  playsBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#1a2030',
    marginBottom: 10,
  },
  playsBadgeText: {
    color: '#ffb400',
    fontSize: 12,
    fontWeight: '900',
  },
  stage: {
    height: 360,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  purpleGlow: {
    position: 'absolute',
    width: 270,
    height: 270,
    borderRadius: 135,
    backgroundColor: 'rgba(148, 86, 255, 0.24)',
  },
  goldGlow: {
    position: 'absolute',
    bottom: 42,
    width: 270,
    height: 110,
    alignItems: 'center',
    justifyContent: 'center',
  },
  goldGlowInner: {
    width: 240,
    height: 76,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 142, 0, 0.28)',
  },
  rewardPackWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  rewardPack: {
    width: 186,
    height: 228,
    borderRadius: 26,
    backgroundColor: '#5a2dff',
    borderWidth: 2,
    borderColor: '#a66dff',
    overflow: 'hidden',
    shadowColor: '#8f63ff',
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  packTop: {
    height: 44,
    backgroundColor: '#7d51ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  packTopText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1,
  },
  packBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  packBodyMain: {
    color: '#fff',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: 1,
  },
  packBodySub: {
    marginTop: 4,
    color: '#ffb400',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1,
  },
  packBottom: {
    height: 16,
    backgroundColor: '#ff7a00',
  },
  packShadow: {
    marginTop: 14,
    width: 188,
    height: 24,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.26)',
  },
  sparkRow: {
    position: 'absolute',
    top: 44,
    width: '100%',
    height: 120,
  },
  spark: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#9f79ff',
  },
  sparkOne: {
    left: 54,
    top: 8,
  },
  sparkTwo: {
    right: 62,
    top: 34,
    backgroundColor: '#ff8e00',
  },
  sparkThree: {
    left: 88,
    top: 72,
    backgroundColor: '#fff',
  },
  rewardReveal: {
    position: 'absolute',
    bottom: 4,
    width: '100%',
    alignItems: 'center',
  },
  rewardKicker: {
    color: '#9f79ff',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  rewardValue: {
    color: '#fff',
    fontSize: 30,
    fontWeight: '900',
  },
  rewardHint: {
    color: '#aab1be',
    fontSize: 13,
    marginTop: 6,
  },
  primaryButton: {
    backgroundColor: '#ff7a00',
    borderRadius: 999,
    minHeight: 58,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#ff7a00',
    shadowOpacity: 0.32,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  primaryButtonDisabled: {
    backgroundColor: '#59606d',
    shadowOpacity: 0,
    elevation: 0,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '900',
  },
  footnote: {
    color: '#8f97a7',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 14,
    paddingHorizontal: 12,
  },
  lockedCopy: {
    color: '#ffb400',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 10,
  },
});
