import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useUser } from '../context/UserContext';
import { resolveCustomerStorageKey } from '../utils/customer-storage';
import {
  addScratchBrowsingMs,
  beginPostLoginPopupWindow,
  canShowAnyGamePopup,
  isInPostLoginWindow,
  isLuckySpinDismissedForSession,
  isScratchBrowsingRouteAllowed,
  markAnyGamePopupShown,
  markLuckySpinLaterForSession,
  markManualGameOpened,
  signalScratchInstantTrigger,
} from '../utils/game-popup-session';
import {
  getLuckySpinPostLoginDelayMs,
  shouldShowLuckySpinPopup,
} from '../utils/lucky-spin-popup';
import {
  markScratchPrizeManualOpen,
  markScratchPrizePopupDismissedForSession,
  markScratchPrizePopupShown,
  markScratchPopupDismissedAt,
  shouldShowScratchPrizePopup,
} from '../utils/scratch-prize-popup';
import LuckySpinPopup from './LuckySpinPopup';
import ScratchPrizePopup from './ScratchPrizePopup';

type RewardPopupHostProps = {
  appInteractive: boolean;
  welcomeDismissedForSession: boolean;
};

type ActivePopup = 'none' | 'lucky-spin' | 'scratch-prize';

function isCartOrAccountTab(pathname: string) {
  return (
    pathname === '/cart' ||
    pathname === '/(tabs)/cart' ||
    pathname === '/account' ||
    pathname === '/(tabs)/account'
  );
}

export default function RewardPopupHost({
  appInteractive,
  welcomeDismissedForSession,
}: RewardPopupHostProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { isReady, isSignedIn, profileId } = useUser();
  const [activePopup, setActivePopup] = useState<ActivePopup>('none');
  const checkingRef = useRef(false);
  const lastTickRef = useRef(Date.now());
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const wasSignedInRef = useRef(isSignedIn);
  const luckySpinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScratchRouteRef = useRef<string | null>(null);

  const customerKey = resolveCustomerStorageKey(profileId || '', '', isSignedIn);

  const isAuthRoute =
    pathname === '/sign-in' ||
    pathname === '/account/auth' ||
    pathname === '/auth/callback' ||
    pathname === '/callback';

  const welcomeBlocking =
    appInteractive &&
    isReady &&
    !isSignedIn &&
    !welcomeDismissedForSession &&
    !isAuthRoute;

  const tryShowLuckySpinAfterLogin = useCallback(async () => {
    if (checkingRef.current || activePopup !== 'none' || !isSignedIn || !profileId || !customerKey) {
      return;
    }

    checkingRef.current = true;

    try {
      const shouldShow = await shouldShowLuckySpinPopup({
        pathname,
        appInteractive: appInteractive && isReady,
        isSignedIn,
        customerId: profileId,
        customerKey,
      });

      if (shouldShow) {
        markAnyGamePopupShown();
        setActivePopup('lucky-spin');
      }
    } finally {
      checkingRef.current = false;
    }
  }, [activePopup, appInteractive, customerKey, isReady, isSignedIn, pathname, profileId]);

  const tryShowScratchPrizeWhileBrowsing = useCallback(async () => {
    if (checkingRef.current || activePopup !== 'none' || welcomeBlocking) {
      return;
    }

    checkingRef.current = true;

    try {
      const shouldShow = await shouldShowScratchPrizePopup({
        pathname,
        appInteractive: appInteractive && isReady,
        welcomeBlocking,
        customerId: isSignedIn ? profileId : undefined,
      });

      if (shouldShow) {
        markScratchPrizePopupShown();
        setActivePopup('scratch-prize');
      }
    } finally {
      checkingRef.current = false;
    }
  }, [activePopup, appInteractive, isReady, isSignedIn, pathname, profileId, welcomeBlocking]);

  useEffect(() => {
    if (!isReady) {
      wasSignedInRef.current = isSignedIn;
      return;
    }

    const justSignedIn = isSignedIn && !wasSignedInRef.current;
    wasSignedInRef.current = isSignedIn;

    if (!justSignedIn || !canShowAnyGamePopup()) {
      return;
    }

    beginPostLoginPopupWindow();

    if (luckySpinTimerRef.current) {
      clearTimeout(luckySpinTimerRef.current);
    }

    luckySpinTimerRef.current = setTimeout(() => {
      void tryShowLuckySpinAfterLogin();
    }, getLuckySpinPostLoginDelayMs());

    return () => {
      if (luckySpinTimerRef.current) {
        clearTimeout(luckySpinTimerRef.current);
        luckySpinTimerRef.current = null;
      }
    };
  }, [isReady, isSignedIn, tryShowLuckySpinAfterLogin]);

  useEffect(() => {
    if (!appInteractive || !isReady || activePopup !== 'none') {
      return;
    }

    const interval = setInterval(() => {
      if (appStateRef.current !== 'active') {
        lastTickRef.current = Date.now();
        return;
      }

      const now = Date.now();
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;

      if (isScratchBrowsingRouteAllowed(pathname)) {
        addScratchBrowsingMs(delta);
      }

      void tryShowScratchPrizeWhileBrowsing();
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, [activePopup, appInteractive, isReady, pathname, tryShowScratchPrizeWhileBrowsing]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      appStateRef.current = nextState;

      if (nextState !== 'active') {
        lastTickRef.current = Date.now();
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (activePopup !== 'none') {
      return;
    }

    if (
      isInPostLoginWindow() &&
      isSignedIn &&
      canShowAnyGamePopup() &&
      !isLuckySpinDismissedForSession() &&
      !luckySpinTimerRef.current
    ) {
      void tryShowLuckySpinAfterLogin();
    }

    if (isCartOrAccountTab(pathname) && lastScratchRouteRef.current !== pathname) {
      signalScratchInstantTrigger();
    }

    lastScratchRouteRef.current = pathname;
    void tryShowScratchPrizeWhileBrowsing();
  }, [activePopup, isSignedIn, pathname, tryShowLuckySpinAfterLogin, tryShowScratchPrizeWhileBrowsing]);

  const handleLuckySpinNow = useCallback(() => {
    setActivePopup('none');
    markManualGameOpened();
    router.push('/account/rewards?autoSpin=1' as any);
  }, [router]);

  const handleLuckySpinLater = useCallback(() => {
    setActivePopup('none');
    markLuckySpinLaterForSession();
  }, []);

  const handleScratchPlayNow = useCallback(() => {
    setActivePopup('none');
    markScratchPrizeManualOpen();
    router.push('/scratch-prize' as any);
  }, [router]);

  const handleScratchNotNow = useCallback(() => {
    setActivePopup('none');
    markScratchPrizePopupDismissedForSession();
    void markScratchPopupDismissedAt();
  }, []);

  return (
    <>
      <LuckySpinPopup
        visible={activePopup === 'lucky-spin'}
        onSpinNow={handleLuckySpinNow}
        onLater={handleLuckySpinLater}
      />
      <ScratchPrizePopup
        visible={activePopup === 'scratch-prize'}
        onPlayNow={handleScratchPlayNow}
        onNotNow={handleScratchNotNow}
      />
    </>
  );
}