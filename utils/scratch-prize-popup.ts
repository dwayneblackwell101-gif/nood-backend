import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchScratchRewardStatus, type ScratchStatusResponse } from './rewards-api';
import {
  addScratchBrowsingMs,
  canShowAnyGamePopup,
  consumeScratchInstantTrigger,
  getScratchBrowsingMs,
  isGamePopupRouteBlocked,
  isInPostLoginWindow,
  isScratchBrowsingRouteAllowed,
  markAnyGamePopupShown,
  markManualGameOpened,
  resetGamePopupSessionForTesting,
  setGamePopupExternalModalOpen,
  signalScratchInstantTrigger,
} from './game-popup-session';

export const SCRATCH_POPUP_DISMISSED_KEY = 'noodScratchPopupDismissedAt';
export const SCRATCH_COMPLETED_KEY = 'noodScratchCompletedAt';
export const SCRATCH_COMPLETION_COOLDOWN_DAYS = 14;

export const SCRATCH_POPUP_ACTIVE_MS = 30_000;
const COMPLETION_COOLDOWN_MS = SCRATCH_COMPLETION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

let forceScratchNextShow = false;

export type ScratchEligibility = {
  popupEligible: boolean;
  canPlay: boolean;
  scratchTokens: number;
  nextAvailableAt: string | null;
  completedAt: string | null;
  cooldownDaysRemaining: number;
  alreadyClaimed: boolean;
  source: 'local' | 'backend';
};

function parseTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfLocalDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function isScratchDismissedUntilTomorrow(dismissedAtIso: string | null | undefined) {
  const dismissedAt = parseTimestamp(dismissedAtIso);
  if (!dismissedAt) return false;

  const dismissedDay = startOfLocalDay(dismissedAt).getTime();
  const today = startOfLocalDay(new Date()).getTime();
  return dismissedDay >= today;
}

export function getScratchCooldownDaysRemaining(completedAtIso: string | null | undefined) {
  const completedAt = parseTimestamp(completedAtIso);
  if (!completedAt) return 0;

  const elapsed = Date.now() - completedAt.getTime();
  if (elapsed >= COMPLETION_COOLDOWN_MS) return 0;

  const remainingMs = COMPLETION_COOLDOWN_MS - elapsed;
  return Math.max(Math.ceil(remainingMs / (24 * 60 * 60 * 1000)), 1);
}

export function getScratchNextAvailableAt(completedAtIso: string | null | undefined) {
  const completedAt = parseTimestamp(completedAtIso);
  if (!completedAt) return null;

  const nextAt = new Date(completedAt.getTime() + COMPLETION_COOLDOWN_MS);
  if (nextAt.getTime() <= Date.now()) return null;
  return nextAt.toISOString();
}

export function isWithinScratchCompletionCooldown(completedAtIso: string | null | undefined) {
  return getScratchCooldownDaysRemaining(completedAtIso) > 0;
}

async function readDismissedAt() {
  try {
    return await AsyncStorage.getItem(SCRATCH_POPUP_DISMISSED_KEY);
  } catch {
    return null;
  }
}

async function readCompletedAt() {
  try {
    return await AsyncStorage.getItem(SCRATCH_COMPLETED_KEY);
  } catch {
    return null;
  }
}

function mapBackendStatus(status: ScratchStatusResponse): ScratchEligibility {
  return {
    popupEligible: Boolean(status.popupEligible),
    canPlay: Boolean(status.canPlay),
    scratchTokens: Number(status.scratchTokens || 0),
    nextAvailableAt: status.nextAvailableAt || null,
    completedAt: status.completedAt || null,
    cooldownDaysRemaining: Number(status.cooldownDaysRemaining || 0),
    alreadyClaimed: Boolean(status.alreadyClaimed),
    source: 'backend',
  };
}

function mapLocalStatus({
  dismissedAt,
  completedAt,
}: {
  dismissedAt: string | null;
  completedAt: string | null;
}): ScratchEligibility {
  const cooldownDaysRemaining = getScratchCooldownDaysRemaining(completedAt);
  const inCompletionCooldown = cooldownDaysRemaining > 0;
  const dismissedUntilTomorrow = isScratchDismissedUntilTomorrow(dismissedAt);
  const scratchTokens = inCompletionCooldown ? 0 : 1;

  return {
    popupEligible: scratchTokens > 0 && !dismissedUntilTomorrow,
    canPlay: scratchTokens > 0,
    scratchTokens,
    nextAvailableAt: getScratchNextAvailableAt(completedAt),
    completedAt,
    cooldownDaysRemaining,
    alreadyClaimed: inCompletionCooldown,
    source: 'local',
  };
}

export async function getScratchEligibility(customerId?: string): Promise<ScratchEligibility> {
  if (customerId) {
    try {
      const backendStatus = await fetchScratchRewardStatus(customerId);
      if (backendStatus?.success) {
        return mapBackendStatus(backendStatus);
      }
    } catch {
      // Fall back to local demo rules.
    }
  }

  const [dismissedAt, completedAt] = await Promise.all([readDismissedAt(), readCompletedAt()]);
  return mapLocalStatus({ dismissedAt, completedAt });
}

export function resetScratchPopupSessionForTesting() {
  resetGamePopupSessionForTesting();
  forceScratchNextShow = false;
}

export function forceScratchPrizePopupForTesting() {
  resetGamePopupSessionForTesting();
  forceScratchNextShow = true;
  signalScratchInstantTrigger();
}

export function markScratchPrizeManualOpen() {
  markManualGameOpened();
}

export function setScratchPopupExternalModalOpen(open: boolean) {
  setGamePopupExternalModalOpen(open);
}

export { addScratchBrowsingMs, signalScratchInstantTrigger };

export async function markScratchPopupDismissedAt() {
  try {
    await AsyncStorage.setItem(SCRATCH_POPUP_DISMISSED_KEY, new Date().toISOString());
  } catch {
    // Optional persistence.
  }
}

export async function markScratchPrizeCompleted() {
  try {
    await AsyncStorage.setItem(SCRATCH_COMPLETED_KEY, new Date().toISOString());
  } catch {
    // Optional persistence.
  }
}

export async function clearScratchPopupCooldownForTesting() {
  try {
    await AsyncStorage.multiRemove([SCRATCH_POPUP_DISMISSED_KEY, SCRATCH_COMPLETED_KEY]);
  } catch {
    // Optional persistence.
  }
}

type PopupEligibilityInput = {
  pathname: string;
  appInteractive: boolean;
  welcomeBlocking: boolean;
  customerId?: string;
};

function hasScratchTriggerReady() {
  if (forceScratchNextShow) {
    return true;
  }

  if (consumeScratchInstantTrigger()) {
    return true;
  }

  return getScratchBrowsingMs() >= SCRATCH_POPUP_ACTIVE_MS;
}

export async function shouldShowScratchPrizePopup({
  pathname,
  appInteractive,
  welcomeBlocking,
  customerId,
}: PopupEligibilityInput) {
  if (!appInteractive || welcomeBlocking || isInPostLoginWindow()) {
    return false;
  }

  if (!canShowAnyGamePopup()) {
    return false;
  }

  if (isGamePopupRouteBlocked(pathname) || !isScratchBrowsingRouteAllowed(pathname)) {
    return false;
  }

  if (!hasScratchTriggerReady()) {
    return false;
  }

  const eligibility = await getScratchEligibility(customerId);

  if (!eligibility.popupEligible || eligibility.scratchTokens <= 0) {
    return false;
  }

  if (forceScratchNextShow) {
    forceScratchNextShow = false;
    return true;
  }

  return true;
}

export function markScratchPrizePopupShown() {
  markAnyGamePopupShown();
}

export function markScratchPrizePopupDismissedForSession() {
  markAnyGamePopupShown();
}

export function getScratchPopupActiveMs() {
  return getScratchBrowsingMs();
}

if (__DEV__) {
  const globalScope = globalThis as typeof globalThis & {
    forceScratchPrizePopup?: () => void;
    resetScratchPopupSession?: () => void;
    clearScratchPopupCooldown?: () => Promise<void>;
  };

  globalScope.forceScratchPrizePopup = forceScratchPrizePopupForTesting;
  globalScope.resetScratchPopupSession = resetScratchPopupSessionForTesting;
  globalScope.clearScratchPopupCooldown = clearScratchPopupCooldownForTesting;
}