import { useCallback, useEffect } from 'react';
import { Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useUser } from '../context/UserContext';
import {
  applyPendingReferralAttribution,
  isInviteDeepLink,
  parseInviteReferralCode,
  savePendingReferralCode,
} from '../utils/referral-attribution';
import { isShopifyAuthCallbackUrl } from '../utils/shopify-auth';

export default function RewardInviteDeepLinkListener() {
  const router = useRouter();
  const { isSignedIn, profileId } = useUser();

  const handleInviteUrl = useCallback(
    async (url: string | null | undefined) => {
      if (!url || isShopifyAuthCallbackUrl(url)) {
        return;
      }

      const referralCode = parseInviteReferralCode(url);
      if (!referralCode) {
        return;
      }

      await savePendingReferralCode(referralCode);

      if (isSignedIn && profileId) {
        await applyPendingReferralAttribution(profileId);
      }

      router.push('/account/special-reward-challenge' as any);
    },
    [isSignedIn, profileId, router]
  );

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (isInviteDeepLink(url)) {
        void handleInviteUrl(url);
      }
    });

    void Linking.getInitialURL().then((url) => {
      if (url && isInviteDeepLink(url)) {
        void handleInviteUrl(url);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [handleInviteUrl]);

  return null;
}