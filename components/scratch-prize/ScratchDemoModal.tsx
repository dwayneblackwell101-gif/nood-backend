import React, { memo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import ScratchPremiumButton from './ScratchPremiumButton';
import { SCRATCH_BG_DEEP, SCRATCH_BORDER, SCRATCH_CARD, SCRATCH_TEXT, SCRATCH_TEXT_MUTED } from './theme';

type ScratchDemoModalProps = {
  visible: boolean;
  onClose: () => void;
};

function ScratchDemoModal({ visible, onClose }: ScratchDemoModalProps) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />

        <View style={styles.sheet}>
          <LinearGradient
            colors={['rgba(255,106,0,0.14)', SCRATCH_CARD, SCRATCH_BG_DEEP]}
            style={styles.sheetGradient}
          >
            <View style={styles.glow} pointerEvents="none" />
            <Text style={styles.title}>Reward secured</Text>
            <Text style={styles.copy}>
              Your reward will be added to your NOOD Balance after verification.
            </Text>
            <ScratchPremiumButton label="OK" onPress={onClose} style={styles.button} />
          </LinearGradient>
        </View>
      </View>
    </Modal>
  );
}

export default memo(ScratchDemoModal);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,106,0,0.35)',
  },
  sheetGradient: {
    paddingHorizontal: 22,
    paddingTop: 24,
    paddingBottom: 20,
    alignItems: 'center',
  },
  glow: {
    position: 'absolute',
    top: -50,
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: 'rgba(255,106,0,0.2)',
  },
  title: {
    color: SCRATCH_TEXT,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  copy: {
    marginTop: 10,
    color: SCRATCH_TEXT_MUTED,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  button: {
    marginTop: 20,
  },
});