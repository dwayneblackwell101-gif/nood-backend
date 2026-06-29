import React, { memo, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SPECIAL_REWARD_USD_LABEL } from '../../utils/reward-currency';
import GlassPanel from './GlassPanel';

type SocialPostCardProps = {
  animateKey?: string | number;
  accountName?: string;
  bodyText?: string;
};

const DEFAULT_BODY_TEXT =
  'Join me on NOOD for premium fashion, trending finds, and daily reward challenges.';

function SocialPostCard({
  animateKey = 0,
  accountName = 'NOOD',
  bodyText = DEFAULT_BODY_TEXT,
}: SocialPostCardProps) {
  const entry = useSharedValue(0);

  useEffect(() => {
    entry.value = 0;
    entry.value = withTiming(1, { duration: 480, easing: Easing.out(Easing.cubic) });
  }, [animateKey, entry]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: entry.value,
    transform: [{ translateY: (1 - entry.value) * 18 }, { scale: 0.96 + entry.value * 0.04 }],
  }));

  return (
    <Animated.View style={[styles.stage, animatedStyle]}>
      <GlassPanel glow style={styles.frame}>
        <View style={styles.card}>
          <View style={styles.socialHeader}>
            <View style={styles.socialAvatar}>
              <Text style={styles.socialAvatarText}>N</Text>
            </View>
            <View style={styles.socialHeaderText}>
              <Text style={styles.socialName}>{accountName}</Text>
              <Text style={styles.socialMeta}>Just now · Reward challenge live</Text>
            </View>
            <View style={styles.whatsappBadge}>
              <Ionicons name="logo-whatsapp" size={18} color="#25D366" />
            </View>
          </View>

          <Text style={styles.socialBody}>{bodyText}</Text>

          <View style={styles.socialPreview}>
            <LinearGradient colors={['#5c31ff', '#ff6a00']} style={styles.socialPreviewGradient}>
              <Text style={styles.socialPreviewTitle}>Unlock {SPECIAL_REWARD_USD_LABEL}</Text>
              <Text style={styles.socialPreviewSub}>Complete challenges. Claim rewards.</Text>
            </LinearGradient>
          </View>

          <View style={styles.engagementRow}>
            <View style={styles.engagementPill}>
              <Ionicons name="heart" size={14} color="#ff6a00" />
              <Text style={styles.engagementText}>128</Text>
            </View>
            <View style={styles.engagementPill}>
              <Ionicons name="chatbubble-ellipses" size={14} color="#5c31ff" />
              <Text style={styles.engagementText}>24</Text>
            </View>
            <View style={styles.engagementPill}>
              <Ionicons name="share-social" size={14} color="#1f2937" />
              <Text style={styles.engagementText}>Share</Text>
            </View>
          </View>
        </View>
      </GlassPanel>
    </Animated.View>
  );
}

export default memo(SocialPostCard);

const styles = StyleSheet.create({
  stage: {
    width: '100%',
    minHeight: 320,
    justifyContent: 'center',
  },
  frame: {
    width: '100%',
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.97)',
    borderRadius: 24,
    padding: 18,
    gap: 14,
  },
  socialHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  socialAvatar: {
    width: 46,
    height: 46,
    borderRadius: 15,
    backgroundColor: '#5c31ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  socialAvatarText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 17,
  },
  socialHeaderText: {
    flex: 1,
  },
  socialName: {
    color: '#171717',
    fontSize: 15,
    fontWeight: '900',
  },
  socialMeta: {
    marginTop: 2,
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '600',
  },
  whatsappBadge: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: 'rgba(37, 211, 102, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  socialBody: {
    color: '#1f2937',
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
  },
  socialPreview: {
    borderRadius: 18,
    overflow: 'hidden',
  },
  socialPreviewGradient: {
    padding: 18,
    borderRadius: 18,
    minHeight: 92,
    justifyContent: 'center',
  },
  socialPreviewTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '900',
  },
  socialPreviewSub: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.9)',
    fontSize: 12,
    fontWeight: '700',
  },
  engagementRow: {
    flexDirection: 'row',
    gap: 8,
  },
  engagementPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#f4f4f8',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  engagementText: {
    color: '#374151',
    fontSize: 12,
    fontWeight: '800',
  },
});