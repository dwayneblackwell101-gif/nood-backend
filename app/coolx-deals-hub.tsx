import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { CoolXPromoFlow } from '../components/promo/CoolXPromoFlow';
import { coolxPromoConfig } from '../components/promo/promoConfig';
import { useUser } from '../context/UserContext';

export default function CoolXDealsHubScreen() {
  const router = useRouter();
  const { displayName } = useUser();

  const safeName = displayName?.trim() || 'NOOD Shopper';
  const initials = safeName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'N';

  const liveConfig = {
    ...coolxPromoConfig,
    username: safeName,
    avatarInitials: initials,
  };

  return (
    <View style={styles.container}>
      <CoolXPromoFlow
        config={liveConfig}
        mode="auto"
        devMode={liveConfig.devModeEnabled}
        onClose={() => router.back()}
        onComplete={() => router.back()}
        onSpinComplete={async () => {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }}
        onClaim={async () => {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffcb2f',
  },
});
