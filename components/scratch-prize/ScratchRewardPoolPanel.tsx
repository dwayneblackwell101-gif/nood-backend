import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import { formatGameRewardUsd, GAME_PRIZE_AMOUNTS_USD } from '../../utils/reward-currency';
import { SCRATCH_BORDER, SCRATCH_GOLD, SCRATCH_TEXT, SCRATCH_TEXT_MUTED } from './theme';

const POOL_LABELS = GAME_PRIZE_AMOUNTS_USD.map((amount) => formatGameRewardUsd(amount));

function ScratchRewardPoolPanel() {
  return (
    <View style={styles.panel}>
      <LinearGradient
        colors={['rgba(255,106,0,0.1)', 'rgba(255,255,255,0.04)', 'rgba(0,0,0,0.15)']}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={styles.edgeHighlight} />

      <View style={styles.headerRow}>
        <View style={styles.ticketIcon}>
          <Ionicons name="ticket-outline" size={18} color={SCRATCH_GOLD} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>Next reward pool</Text>
          <Text style={styles.subtitle}>Rewards available in USD</Text>
        </View>
      </View>

      <View style={styles.chipRow}>
        {POOL_LABELS.map((label) => (
          <View key={label} style={styles.chip}>
            <Text style={styles.chipText}>{label}</Text>
          </View>
        ))}
      </View>

      <View style={styles.previewRow}>
        <View style={styles.previewTicket}>
          <Text style={styles.previewKicker}>Rewards</Text>
          <Text style={styles.previewValue}>$10 USD</Text>
        </View>
        <Text style={styles.previewNote}>Rewards are added to your NOOD Balance when unlocked.</Text>
      </View>
    </View>
  );
}

export default memo(ScratchRewardPoolPanel);

const styles = StyleSheet.create({
  panel: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,176,0,0.28)',
    padding: 16,
  },
  edgeHighlight: {
    position: 'absolute',
    top: 0,
    left: 18,
    right: 18,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  ticketIcon: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,106,0,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,176,0,0.3)',
  },
  headerText: {
    flex: 1,
  },
  title: {
    color: SCRATCH_TEXT,
    fontSize: 15,
    fontWeight: '900',
  },
  subtitle: {
    marginTop: 2,
    color: SCRATCH_TEXT_MUTED,
    fontSize: 12,
    fontWeight: '600',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 14,
  },
  chip: {
    backgroundColor: 'rgba(0,0,0,0.28)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: SCRATCH_BORDER,
  },
  chipText: {
    color: SCRATCH_TEXT,
    fontSize: 11,
    fontWeight: '900',
  },
  previewRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  previewTicket: {
    minWidth: 92,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,106,0,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,176,0,0.35)',
    alignItems: 'center',
  },
  previewKicker: {
    color: SCRATCH_GOLD,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  previewValue: {
    marginTop: 4,
    color: SCRATCH_TEXT,
    fontSize: 14,
    fontWeight: '900',
  },
  previewNote: {
    flex: 1,
    color: SCRATCH_TEXT_MUTED,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '600',
  },
});