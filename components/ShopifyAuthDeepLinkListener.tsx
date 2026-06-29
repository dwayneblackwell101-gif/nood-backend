import { useCallback, useEffect, useRef } from 'react';
import { Linking } from 'react-native';
import { useHistoryEvents } from '../context/HistoryContext';
import { useUser } from '../context/UserContext';
import { logAuthRestartCheck } from '../utils/auth-restart-debug';
import { isAppBootstrapComplete } from '../utils/app-bootstrap';
import { handleShopifyAuthRedirectUrl } from '../utils/shopify-auth-handlers';

export default function ShopifyAuthDeepLinkListener() {
  const { markSignedIn } = useUser();
  const { addHistoryEvent } = useHistoryEvents();
  const isReadyRef = useRef(false);

  const handleAuthUrl = useCallback(
    async (url: string | null | undefined) => {
      if (!url) {
        return;
      }

      logAuthRestartCheck({
        step: 'deep-link-auth-url',
        isAppBootstrapping: !isAppBootstrapComplete(),
        isAuthLoading: true,
        detail: { urlPresent: Boolean(url) },
      });

      await handleShopifyAuthRedirectUrl(url, {
        markSignedIn,
        addHistoryEvent,
      });
    },
    [addHistoryEvent, markSignedIn]
  );

  useEffect(() => {
    console.log('[AUTH] root Linking listener registered');

    const subscription = Linking.addEventListener('url', ({ url }) => {
      console.log('[AUTH] Linking url event', url);
      void handleAuthUrl(url);
    });

    void Linking.getInitialURL().then((url) => {
      console.log('[AUTH] initial url', url || null);
      void handleAuthUrl(url);
    });

    isReadyRef.current = true;

    return () => {
      subscription.remove();
    };
  }, [handleAuthUrl]);

  return null;
}