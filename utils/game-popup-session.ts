export type GamePopupKind = 'lucky-spin' | 'scratch-prize' | 'special-reward';

const session = {
  anyPopupShown: false,
  manualGameOpened: false,
  externalModalOpen: false,
  luckySpinDismissedSession: false,
  postLoginWindowUntil: 0,
  scratchBrowsingMs: 0,
  scratchInstantTrigger: false,
};

export function canShowAnyGamePopup() {
  return !session.anyPopupShown && !session.manualGameOpened && !session.externalModalOpen;
}

export function markAnyGamePopupShown() {
  session.anyPopupShown = true;
}

export function markManualGameOpened() {
  session.manualGameOpened = true;
  session.anyPopupShown = true;
}

export function setGamePopupExternalModalOpen(open: boolean) {
  session.externalModalOpen = open;
}

export function markLuckySpinLaterForSession() {
  session.luckySpinDismissedSession = true;
}

export function isLuckySpinDismissedForSession() {
  return session.luckySpinDismissedSession;
}

export function beginPostLoginPopupWindow(durationMs = 6000) {
  session.postLoginWindowUntil = Date.now() + durationMs;
}

export function isInPostLoginWindow() {
  return Date.now() < session.postLoginWindowUntil;
}

export function addScratchBrowsingMs(deltaMs: number) {
  if (!canShowAnyGamePopup() || isInPostLoginWindow()) {
    return session.scratchBrowsingMs;
  }

  session.scratchBrowsingMs = Math.max(0, session.scratchBrowsingMs + deltaMs);
  return session.scratchBrowsingMs;
}

export function getScratchBrowsingMs() {
  return session.scratchBrowsingMs;
}

export function signalScratchInstantTrigger() {
  if (!canShowAnyGamePopup() || isInPostLoginWindow()) {
    return;
  }

  session.scratchInstantTrigger = true;
}

export function consumeScratchInstantTrigger() {
  const triggered = session.scratchInstantTrigger;
  session.scratchInstantTrigger = false;
  return triggered;
}

export function isGamePopupRouteBlocked(pathname: string) {
  const path = String(pathname || '').trim() || '/';

  const blockedPrefixes = [
    '/checkout',
    '/payment',
    '/paypal-checkout',
    '/payment-result',
    '/account/auth',
    '/sign-in',
    '/auth/callback',
    '/callback',
    '/scratch-prize',
    '/account/special-reward-challenge',
    '/account/rewards',
    '/rewards-demo',
    '/coolx-deals-hub',
    '/modal',
    '/product/',
    '/collection/',
    '/search',
    '/wishlist',
    '/(tabs)/wishlist',
  ];

  return blockedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

export function isScratchBrowsingRouteAllowed(pathname: string) {
  const path = String(pathname || '').trim() || '/';

  if (isGamePopupRouteBlocked(path)) {
    return false;
  }

  const isHome =
    path === '/' ||
    path === '/(tabs)' ||
    path === '/index' ||
    path === '/(tabs)/index';

  const isCategories = path === '/categories' || path === '/(tabs)/categories';
  const isCart = path === '/cart' || path === '/(tabs)/cart';
  const isAccountTab = path === '/account' || path === '/(tabs)/account';

  return isHome || isCategories || isCart || isAccountTab;
}

export function resetGamePopupSessionForTesting() {
  session.anyPopupShown = false;
  session.manualGameOpened = false;
  session.externalModalOpen = false;
  session.luckySpinDismissedSession = false;
  session.postLoginWindowUntil = 0;
  session.scratchBrowsingMs = 0;
  session.scratchInstantTrigger = false;
}

if (__DEV__) {
  const globalScope = globalThis as typeof globalThis & {
    resetGamePopupSession?: () => void;
  };

  globalScope.resetGamePopupSession = resetGamePopupSessionForTesting;
}