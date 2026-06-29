import React, { memo } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';

type LuckySpinPopupProps = {
  visible: boolean;
  onSpinNow: () => void;
  onLater: () => void;
};

function LuckySpinPopup({ visible, onSpinNow, onLater }: LuckySpinPopupProps) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onLater}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onLater} />

        <View style={styles.sheet}>
          <LinearGradient colors={['#141414', '#0a0a0a']} style={styles.sheetGradient}>
            <View style={styles.accentGlow} pointerEvents="none" />

            <View style={styles.iconWrap}>
              <LinearGradient colors={['#ff6a00', '#ffb400']} style={styles.iconBadge}>
                <Ionicons name="sparkles" size={24} color="#fff" />
              </LinearGradient>
            </View>

            <Text style={styles.title}>Lucky Spin</Text>
            <Text style={styles.copy}>Your one-time Lucky Spin is ready.</Text>

            <TouchableOpacity style={styles.primaryButton} activeOpacity={0.9} onPress={onSpinNow}>
              <LinearGradient colors={['#ff6a00', '#ff8a3d']} style={styles.primaryGradient}>
                <Text style={styles.primaryText}>Spin Now</Text>
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity style={styles.secondaryButton} activeOpacity={0.85} onPress={onLater}>
              <Text style={styles.secondaryText}>Later</Text>
            </TouchableOpacity>
          </LinearGradient>
        </View>
      </View>
    </Modal>
  );
}

export default memo(LuckySpinPopup);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    marginHorizontal: 14,
    marginBottom: 18,
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,106,0,0.35)',
  },
  sheetGradient: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 18,
    alignItems: 'center',
  },
  accentGlow: {
    position: 'absolute',
    top: -40,
    right: -10,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: 'rgba(255,106,0,0.18)',
  },
  iconWrap: {
    marginBottom: 12,
  },
  iconBadge: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  title: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.4,
  },
  copy: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.84)',
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  primaryButton: {
    marginTop: 18,
    width: '100%',
    borderRadius: 16,
    overflow: 'hidden',
  },
  primaryGradient: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '900',
  },
  secondaryButton: {
    marginTop: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  secondaryText: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 14,
    fontWeight: '800',
  },
});