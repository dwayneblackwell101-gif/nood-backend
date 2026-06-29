import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatGameRewardUsd, GAME_PRIZE_AMOUNTS_USD } from '../../utils/reward-currency';
import { SCRATCH_BORDER, SCRATCH_TEXT } from './theme';

const PRIZE_LABELS = GAME_PRIZE_AMOUNTS_USD.map((amount) => formatGameRewardUsd(amount));

function ScratchPrizeChips() {
  return (
    <View style={styles.strip}>
      {PRIZE_LABELS.map((label) => (
        <View key={label} style={styles.pill}>
          <Text style={styles.pillText}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

export default memo(ScratchPrizeChips);

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    maxWidth: 340,
  },
  pill: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: SCRATCH_BORDER,
  },
  pillText: {
    color: SCRATCH_TEXT,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.2,
  },
});