import React, { memo } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import ScratchPremiumButton from './ScratchPremiumButton';
import { SCRATCH_BG_DEEP, SCRATCH_BORDER, SCRATCH_CARD, SCRATCH_GOLD, SCRATCH_TEXT, SCRATCH_TEXT_MUTED } from './theme';

const STEPS = [
  'Earn Scratch Tokens from NOOD activity',
  'Use a token to play Scratch Prize',
  'Scratch the card to reveal your reward',
  'Claim reward when available',
  'Rewards are added to your NOOD Balance when unlocked',
];

type ScratchHowItWorksModalProps = {
  visible: boolean;
  onClose: () => void;
};

function ScratchHowItWorksModal({ visible, onClose }: ScratchHowItWorksModalProps) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />

        <View style={styles.sheet}>
          <LinearGradient
            colors={['rgba(255,106,0,0.12)', SCRATCH_CARD, SCRATCH_BG_DEEP]}
            style={styles.sheetGradient}
          >
            <Text style={styles.title}>How it works</Text>
            <Text style={styles.subtitle}>NOOD Scratch Prize mini-game</Text>

            <ScrollView style={styles.stepsScroll} showsVerticalScrollIndicator={false}>
              {STEPS.map((step, index) => (
                <View key={step} style={styles.stepRow}>
                  <View style={styles.stepBadge}>
                    <Text style={styles.stepBadgeText}>{index + 1}</Text>
                  </View>
                  <Text style={styles.stepText}>{step}</Text>
                </View>
              ))}
            </ScrollView>

            <ScratchPremiumButton label="Got it" onPress={onClose} style={styles.button} />
          </LinearGradient>
        </View>
      </View>
    </Modal>
  );
}

export default memo(ScratchHowItWorksModal);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    width: '100%',
    maxWidth: 360,
    maxHeight: '78%',
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: SCRATCH_BORDER,
  },
  sheetGradient: {
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 18,
  },
  title: {
    color: SCRATCH_TEXT,
    fontSize: 24,
    fontWeight: '900',
  },
  subtitle: {
    marginTop: 6,
    color: SCRATCH_TEXT_MUTED,
    fontSize: 14,
    fontWeight: '700',
  },
  stepsScroll: {
    marginTop: 16,
    maxHeight: 280,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 14,
  },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,106,0,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,176,0,0.35)',
  },
  stepBadgeText: {
    color: SCRATCH_GOLD,
    fontSize: 13,
    fontWeight: '900',
  },
  stepText: {
    flex: 1,
    color: SCRATCH_TEXT,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
  button: {
    marginTop: 8,
  },
});