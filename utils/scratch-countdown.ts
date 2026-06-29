import {
  SCRATCH_COMPLETION_COOLDOWN_DAYS,
  SCRATCH_COMPLETED_KEY,
} from './scratch-prize-popup';

const COMPLETION_COOLDOWN_MS = SCRATCH_COMPLETION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

function parseTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type ScratchCountdownParts = {
  days: number;
  hours: number;
  minutes: number;
  totalMs: number;
  shortLabel: string;
  statusLabel: string;
  lockedButtonLabel: string;
  nextInDaysLabel: string;
};

export function getScratchCountdownParts(
  completedAtIso: string | null | undefined,
  now = Date.now()
): ScratchCountdownParts | null {
  const completedAt = parseTimestamp(completedAtIso);
  if (!completedAt) return null;

  const unlockAt = completedAt.getTime() + COMPLETION_COOLDOWN_MS;
  const remainingMs = unlockAt - now;
  if (remainingMs <= 0) return null;

  const totalMinutes = Math.floor(remainingMs / (1000 * 60));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const shortLabel = `${days}d ${hours}h`;

  return {
    days,
    hours,
    minutes,
    totalMs: remainingMs,
    shortLabel,
    statusLabel: `Unlocks in ${shortLabel}`,
    lockedButtonLabel: `Locked for ${shortLabel}`,
    nextInDaysLabel: `Next Scratch Prize in ${Math.max(days, 1)} day${days === 1 ? '' : 's'}`,
  };
}

export function isScratchCooldownActive(completedAtIso: string | null | undefined, now = Date.now()) {
  return getScratchCountdownParts(completedAtIso, now) != null;
}

export { SCRATCH_COMPLETED_KEY };