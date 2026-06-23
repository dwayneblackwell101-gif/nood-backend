import React, { useEffect, useRef } from 'react';
import * as Haptics from 'expo-haptics';
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

type BundleClaimModalProps = {
  visible: boolean;
  locked: boolean;
  onClose: () => void;
  onClaim: () => void;
  lockedReason?: string;
};

export default function BundleClaimModal({
  visible,
  locked,
  onClose,
  onClaim,
  lockedReason,
}: BundleClaimModalProps) {
  const fade = useRef(new Animated.Value(0)).current;
  const contentLift = useRef(new Animated.Value(28)).current;
  const glowPulse = useRef(new Animated.Value(0.8)).current;
  const scaleBob = useRef(new Animated.Value(0)).current;
  const ctaPulse = useRef(new Animated.Value(1)).current;

  const triggerHaptic = async (kind: 'open' | 'claim' | 'locked') => {
    try {
      if (Platform.OS !== 'web') {
        if (kind === 'open') {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        } else if (kind === 'claim') {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        }
      }
    } catch {
      if (kind === 'claim') {
        Vibration.vibrate([0, 35, 45, 60]);
      } else if (kind === 'locked') {
        Vibration.vibrate([0, 30, 40, 30]);
      } else {
        Vibration.vibrate(35);
      }
    }
  };

  useEffect(() => {
    if (!visible) {
      fade.setValue(0);
      contentLift.setValue(28);
      glowPulse.setValue(0.8);
      scaleBob.setValue(0);
      ctaPulse.setValue(1);
      return;
    }

    void triggerHaptic('open');

    Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration: 250,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(contentLift, {
        toValue: 0,
        duration: 380,
        easing: Easing.out(Easing.back(1.1)),
        useNativeDriver: true,
      }),
    ]).start();

    const glowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowPulse, {
          toValue: 1.08,
          duration: 1200,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(glowPulse, {
          toValue: 0.82,
          duration: 1200,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    const bobLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(scaleBob, {
          toValue: -8,
          duration: 1100,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(scaleBob, {
          toValue: 0,
          duration: 1100,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    const ctaLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(ctaPulse, {
          toValue: 1.03,
          duration: 950,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(ctaPulse, {
          toValue: 1,
          duration: 950,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    glowLoop.start();
    bobLoop.start();
    ctaLoop.start();

    return () => {
      glowLoop.stop();
      bobLoop.stop();
      ctaLoop.stop();
    };
  }, [contentLift, ctaPulse, fade, glowPulse, scaleBob, visible]);

  const handleClaim = () => {
    if (locked) {
      void triggerHaptic('locked');
      return;
    }

    void triggerHaptic('claim');
    onClaim();
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.overlay, { opacity: fade }]}>
        <Pressable style={styles.backdrop} onPress={onClose} />

        <Animated.View style={[styles.content, { transform: [{ translateY: contentLift }] }]}>
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>

          <View style={styles.topPill}>
            <Text style={styles.topPillText}>NOOD</Text>
          </View>
          <Animated.View style={[styles.glowBeam, { transform: [{ scale: glowPulse }] }]} />
          <Animated.View style={[styles.glowFloor, { transform: [{ scale: glowPulse }] }]} />
          <View style={styles.ambientShadowOne} />
          <View style={styles.ambientShadowTwo} />

          <Text style={styles.title}>Claim this Amazing Bundle</Text>

          <View style={styles.bubble}>
            <Text style={styles.bubbleText}>Gifts at $0{"\n"}& Coupons</Text>
          </View>

          <Animated.View style={[styles.stage, { transform: [{ translateY: scaleBob }] }]}>
            <View style={styles.giftCluster}>
              <View style={styles.giftGlow} />
              <View style={styles.giftBox}>
                <View style={styles.giftRibbonVertical} />
                <View style={styles.giftRibbonHorizontal} />
                <Text style={styles.questionMark}>?</Text>
                <Text style={[styles.questionMark, styles.questionMarkRight]}>?</Text>
              </View>
              <View style={styles.ticketStack}>
                <View style={[styles.ticket, styles.ticketOne]} />
                <View style={[styles.ticket, styles.ticketTwo]} />
                <View style={[styles.ticket, styles.ticketThree]} />
                <Text style={styles.ticketTag}>Gift at $0</Text>
              </View>
            </View>

            <View style={styles.scaleStem} />
            <View style={styles.scaleBase} />
            <View style={styles.scaleArm} />

            <View style={styles.coinChest}>
              <View style={styles.chestGlow} />
              <View style={styles.chestLid} />
              <View style={styles.chestBase} />
              <View style={styles.coinPileLarge} />
              <View style={styles.coinPileSmall} />
            </View>
          </Animated.View>

          <Animated.View style={{ width: '100%', transform: [{ scale: ctaPulse }] }}>
            <TouchableOpacity
              style={[styles.claimButton, locked && styles.claimButtonDisabled]}
              onPress={handleClaim}
              disabled={locked}
            >
              <Text style={styles.claimButtonText}>{locked ? 'Already Claimed' : 'Tap & Claim'}</Text>
            </TouchableOpacity>
          </Animated.View>

          <Text style={styles.footerText}>
            {locked
              ? lockedReason || 'This home-page bundle has already been used on this account profile.'
              : 'With qualifying orders'}
          </Text>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(17, 10, 2, 0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 18,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  content: {
    width: '100%',
    maxWidth: 430,
    minHeight: 690,
    paddingHorizontal: 28,
    paddingTop: 32,
    paddingBottom: 28,
    justifyContent: 'space-between',
    alignItems: 'center',
    overflow: 'hidden',
  },
  topPill: {
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#fff1df',
    marginBottom: 18,
  },
  topPillText: {
    color: '#ff7f14',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 1.4,
  },
  closeButton: {
    position: 'absolute',
    top: 112,
    right: 14,
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  glowBeam: {
    position: 'absolute',
    top: 6,
    width: 240,
    height: 520,
    borderRadius: 160,
    backgroundColor: 'rgba(244, 186, 84, 0.2)',
  },
  glowFloor: {
    position: 'absolute',
    bottom: 122,
    width: 332,
    height: 132,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 167, 61, 0.34)',
  },
  ambientShadowOne: {
    position: 'absolute',
    bottom: 164,
    left: 44,
    width: 124,
    height: 124,
    borderRadius: 62,
    backgroundColor: 'rgba(0,0,0,0.12)',
  },
  ambientShadowTwo: {
    position: 'absolute',
    bottom: 168,
    right: 42,
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: 'rgba(0,0,0,0.12)',
  },
  title: {
    color: '#fff1d9',
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 24,
    maxWidth: 330,
  },
  bubble: {
    alignSelf: 'flex-start',
    marginLeft: 8,
    backgroundColor: '#c2a35a',
    borderRadius: 32,
    paddingHorizontal: 22,
    paddingVertical: 18,
    shadowColor: '#ffd270',
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  bubbleText: {
    color: '#fff5dc',
    fontSize: 19,
    lineHeight: 25,
    fontWeight: '900',
    textAlign: 'center',
  },
  stage: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 22,
    marginBottom: 34,
    height: 300,
  },
  giftCluster: {
    position: 'absolute',
    left: 8,
    bottom: 68,
    width: 188,
    height: 176,
    alignItems: 'center',
    justifyContent: 'center',
  },
  giftGlow: {
    position: 'absolute',
    width: 190,
    height: 146,
    borderRadius: 72,
    backgroundColor: 'rgba(255, 212, 85, 0.26)',
  },
  giftBox: {
    width: 118,
    height: 108,
    borderRadius: 24,
    backgroundColor: '#f2561f',
    borderWidth: 4,
    borderColor: '#ffd164',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 2,
  },
  giftRibbonVertical: {
    position: 'absolute',
    width: 18,
    height: '100%',
    backgroundColor: '#ffe59a',
  },
  giftRibbonHorizontal: {
    position: 'absolute',
    width: '100%',
    height: 18,
    backgroundColor: '#ffe59a',
  },
  questionMark: {
    position: 'absolute',
    left: 26,
    top: 20,
    fontSize: 42,
    fontWeight: '900',
    color: '#ffe8a0',
  },
  questionMarkRight: {
    left: undefined,
    right: 26,
  },
  ticketStack: {
    position: 'absolute',
    right: -2,
    bottom: 30,
    width: 108,
    height: 116,
  },
  ticket: {
    position: 'absolute',
    width: 78,
    height: 108,
    borderRadius: 14,
    backgroundColor: '#8b43ff',
    borderWidth: 2,
    borderColor: '#ffdb5c',
  },
  ticketOne: {
    transform: [{ rotate: '-18deg' }],
    left: 8,
    top: 8,
  },
  ticketTwo: {
    transform: [{ rotate: '-6deg' }],
    left: 20,
    top: 2,
    backgroundColor: '#7040ff',
  },
  ticketThree: {
    transform: [{ rotate: '12deg' }],
    left: 34,
    top: 6,
    backgroundColor: '#f2b200',
  },
  ticketTag: {
    position: 'absolute',
    right: -4,
    top: 54,
    backgroundColor: '#ffd46f',
    color: '#6f4612',
    fontSize: 11,
    fontWeight: '900',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 999,
    transform: [{ rotate: '48deg' }],
  },
  scaleStem: {
    position: 'absolute',
    bottom: 68,
    width: 16,
    height: 66,
    borderRadius: 999,
    backgroundColor: '#e8a22f',
  },
  scaleBase: {
    position: 'absolute',
    bottom: 52,
    width: 80,
    height: 20,
    borderRadius: 999,
    backgroundColor: '#d68f1b',
  },
  scaleArm: {
    width: 292,
    height: 16,
    borderRadius: 999,
    backgroundColor: '#f0ac2d',
    marginTop: 126,
    shadowColor: '#ffcb63',
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  coinChest: {
    position: 'absolute',
    right: 6,
    bottom: 76,
    width: 132,
    height: 126,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  chestGlow: {
    position: 'absolute',
    bottom: 8,
    width: 126,
    height: 90,
    borderRadius: 52,
    backgroundColor: 'rgba(255, 204, 84, 0.24)',
  },
  chestLid: {
    width: 96,
    height: 34,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    backgroundColor: '#8a3ef7',
    borderWidth: 3,
    borderColor: '#f4b73c',
    transform: [{ rotate: '-8deg' }],
    marginBottom: -4,
  },
  chestBase: {
    width: 104,
    height: 62,
    borderRadius: 18,
    backgroundColor: '#6f2fe9',
    borderWidth: 3,
    borderColor: '#f4b73c',
  },
  coinPileLarge: {
    position: 'absolute',
    bottom: 10,
    right: -6,
    width: 58,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#ffcf4d',
  },
  coinPileSmall: {
    position: 'absolute',
    bottom: 34,
    right: 24,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#ffd56a',
  },
  claimButton: {
    width: '100%',
    minHeight: 68,
    borderRadius: 999,
    backgroundColor: '#ff7425',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#ffd6ba',
    shadowColor: '#ff8a2f',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  claimButtonDisabled: {
    backgroundColor: '#8f8678',
    borderColor: '#cec0af',
    shadowOpacity: 0,
    elevation: 0,
  },
  claimButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '900',
  },
  footerText: {
    marginTop: 14,
    color: '#f4dfbf',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
    textAlign: 'center',
    maxWidth: 320,
  },
});
