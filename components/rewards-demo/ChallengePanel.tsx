import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import AnimatedProgressBar from './AnimatedProgressBar';
import GlassPanel from './GlassPanel';
import RewardCard from './RewardCard';
import { DEMO_GOLD } from './theme';

type ChallengePanelProps = {
  invitedCount: number;
  inviteGoal: number;
  daysLeft: number;
  rewardLabel: string;
  animateKey?: string | number;
};

function ChallengePanel({
  invitedCount,
  inviteGoal,
  daysLeft,
  rewardLabel,
  animateKey = 0,
}: ChallengePanelProps) {
  const progress = invitedCount / inviteGoal;

  return (
    <GlassPanel glow style={styles.panel}>
      <View style={styles.headerRow}>
        <View style={styles.iconWrap}>
          <Ionicons name="people" size={22} color="#fff" />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.kicker}>Challenge progress</Text>
          <Text style={styles.title}>Invite your NOOD circle</Text>
        </View>
        <View style={styles.daysBadge}>
          <Ionicons name="time-outline" size={13} color={DEMO_GOLD} />
          <Text style={styles.daysBadgeText}>{daysLeft} days left</Text>
        </View>
      </View>

      <View style={styles.friendsRow}>
        {Array.from({ length: inviteGoal }).map((_, index) => {
          const filled = index < invitedCount;
          return (
            <View
              key={`friend-${index}`}
              style={[styles.friendDot, filled ? styles.friendDotFilled : styles.friendDotEmpty]}
            >
              <Ionicons
                name={filled ? 'person' : 'person-outline'}
                size={16}
                color={filled ? '#2a1578' : 'rgba(255,255,255,0.7)'}
              />
            </View>
          );
        })}
      </View>

      <AnimatedProgressBar
        animateKey={animateKey}
        progress={progress}
        label={`${invitedCount}/${inviteGoal} friends invited`}
        variant="hero"
      />

      <View style={styles.rewardInset}>
        <RewardCard amountLabel={rewardLabel} animateKey={animateKey} compact hero />
      </View>
    </GlassPanel>
  );
}

export default memo(ChallengePanel);

const styles = StyleSheet.create({
  panel: {
    width: '100%',
    minHeight: 300,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 18,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  headerText: {
    flex: 1,
  },
  kicker: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  title: {
    marginTop: 3,
    color: '#fff',
    fontSize: 18,
    fontWeight: '900',
  },
  daysBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255, 180, 0, 0.2)',
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(255, 180, 0, 0.42)',
  },
  daysBadgeText: {
    color: '#ffe08a',
    fontSize: 12,
    fontWeight: '900',
  },
  friendsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
    justifyContent: 'center',
  },
  friendDot: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  friendDotFilled: {
    backgroundColor: '#fff',
    borderColor: 'rgba(255,255,255,0.9)',
  },
  friendDotEmpty: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderColor: 'rgba(255,255,255,0.18)',
  },
  rewardInset: {
    marginTop: 16,
  },
});