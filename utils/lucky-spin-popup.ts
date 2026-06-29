import { getLuckySpinStatus } from './lucky-spin';
import {
  canShowAnyGamePopup,
  isGamePopupRouteBlocked,
  isLuckySpinDismissedForSession,
} from './game-popup-session';

export const LUCKY_SPIN_POST_LOGIN_DELAY_MIN_MS = 1000;
export const LUCKY_SPIN_POST_LOGIN_DELAY_MAX_MS = 2000;

export function getLuckySpinPostLoginDelayMs() {
  const spread = LUCKY_SPIN_POST_LOGIN_DELAY_MAX_MS - LUCKY_SPIN_POST_LOGIN_DELAY_MIN_MS;
  return LUCKY_SPIN_POST_LOGIN_DELAY_MIN_MS + Math.floor(Math.random() * spread);
}

export async function shouldShowLuckySpinPopup({
  pathname,
  appInteractive,
  isSignedIn,
  customerId,
  customerKey,
}: {
  pathname: string;
  appInteractive: boolean;
  isSignedIn: boolean;
  customerId: string;
  customerKey: string;
}) {
  if (!appInteractive || !isSignedIn || !customerId || !customerKey) {
    return false;
  }

  if (isLuckySpinDismissedForSession()) {
    return false;
  }

  if (!canShowAnyGamePopup()) {
    return false;
  }

  if (isGamePopupRouteBlocked(pathname)) {
    return false;
  }

  const status = await getLuckySpinStatus(customerId, customerKey);
  return status.canSpin && !status.used;
}