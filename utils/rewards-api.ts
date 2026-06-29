import { fetchBackendJson, postBackendJson } from './backend';
import {
  SPECIAL_REWARD_USD_AMOUNT,
  SPECIAL_REWARD_USD_LABEL,
} from './reward-currency';

export type RewardChallengeStatus = {
  id: string;
  title: string;
  subtitle: string;
  rewardAmount: number;
  rewardCurrency: string;
  rewardLabel: string;
  inviteGoal: number;
  invitedCount: number;
  daysLeft: number;
  expiresAt: string;
  startedAt: string;
  shareCount: number;
  referralCode: string;
  referralLink: string;
  claimed: boolean;
  eligibleToClaim: boolean;
  claimReason: 'eligible' | 'already_claimed' | 'expired' | 'complete_challenge_first';
};

export type RewardsStatusResponse = {
  success: boolean;
  customerId: string;
  walletBalance: string;
  currency: string;
  challenges: RewardChallengeStatus[];
};

export type RewardShareResponse = {
  success: boolean;
  referralCode: string;
  referralLink: string;
  shareMessage: string;
  challenge?: RewardChallengeStatus;
  code?: string;
  message?: string;
};

export type RewardClaimResponse = {
  success: boolean;
  message?: string;
  walletBalance?: string;
  rewardAmount?: number;
  rewardCurrency?: string;
  challenge?: RewardChallengeStatus;
  code?: string;
};

export const SPECIAL_REWARD_CHALLENGE_ID = 'invite_5_friends_7_days';

export type ScratchStatusResponse = {
  success: boolean;
  canPlay: boolean;
  scratchTokens: number;
  nextAvailableAt: string | null;
  completedAt: string | null;
  cooldownDaysRemaining: number;
  alreadyClaimed: boolean;
  popupEligible: boolean;
};

export async function fetchScratchRewardStatus(customerId: string) {
  const encodedId = encodeURIComponent(customerId);
  return fetchBackendJson<ScratchStatusResponse>(`/api/rewards/scratch/status?customerId=${encodedId}`);
}

export type LuckySpinStatusResponse = {
  success: boolean;
  customerId?: string;
  canSpin: boolean;
  used: boolean;
  luckySpinUsedAt: string | null;
  luckySpinRewardAmountUsd: number | null;
  alreadyClaimed?: boolean;
  demoOnly?: boolean;
  walletCredited?: boolean;
  prize?: {
    id: string;
    amountUsd: number;
    unlockRequirementUsd: number;
    label: string;
  };
  code?: string;
  message?: string;
};

export async function fetchLuckySpinStatus(customerId: string) {
  const encodedId = encodeURIComponent(customerId);
  return fetchBackendJson<LuckySpinStatusResponse>(`/api/rewards/lucky-spin/status?customerId=${encodedId}`);
}

export async function recordLuckySpinOnBackend(customerId: string) {
  return postBackendJson('/api/rewards/lucky-spin/spin', {
    customerId,
  }) as Promise<LuckySpinStatusResponse>;
}

export type RewardsStatusFetchResult = {
  status: RewardsStatusResponse;
  usingFallback: boolean;
};

function normalizeRewardsStatusPayload(data: any, customerId: string): RewardsStatusResponse | null {
  const challenges = Array.isArray(data?.challenges) ? data.challenges : [];
  if (!challenges.length) return null;

  return {
    success: Boolean(data?.success ?? data?.ok ?? true),
    customerId: String(data?.customerId || customerId),
    walletBalance: String(data?.walletBalance ?? '0.00'),
    currency: String(data?.currency || 'USD'),
    challenges: challenges.map((challenge: any) => ({
      id: String(challenge?.id || SPECIAL_REWARD_CHALLENGE_ID),
      title: String(challenge?.title || 'Invite 5 friends in 7 days'),
      subtitle: String(
        challenge?.subtitle || 'Bring your circle to NOOD and unlock your reward faster.'
      ),
      rewardAmount: Number(challenge?.rewardAmount ?? SPECIAL_REWARD_USD_AMOUNT),
      rewardCurrency: String(challenge?.rewardCurrency || 'USD'),
      rewardLabel: String(challenge?.rewardLabel || SPECIAL_REWARD_USD_LABEL),
      inviteGoal: Number(challenge?.inviteGoal ?? challenge?.target ?? 5),
      invitedCount: Number(challenge?.invitedCount ?? challenge?.progress ?? 0),
      daysLeft: Number(challenge?.daysLeft ?? 7),
      expiresAt: String(challenge?.expiresAt || ''),
      startedAt: String(challenge?.startedAt || ''),
      shareCount: Number(challenge?.shareCount ?? 0),
      referralCode: String(challenge?.referralCode || ''),
      referralLink: String(challenge?.referralLink || ''),
      claimed: Boolean(challenge?.claimed),
      eligibleToClaim: Boolean(challenge?.eligibleToClaim),
      claimReason:
        challenge?.claimReason === 'eligible' ||
        challenge?.claimReason === 'already_claimed' ||
        challenge?.claimReason === 'expired' ||
        challenge?.claimReason === 'complete_challenge_first'
          ? challenge.claimReason
          : 'complete_challenge_first',
    })),
  };
}

export function buildFallbackRewardsStatus(customerId: string): RewardsStatusResponse {
  const normalizedId = String(customerId || 'guest').trim() || 'guest';
  const suffix = normalizedId.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase() || 'GUEST';
  const referralCode = `NOOD-${suffix.padStart(6, '0').slice(-6)}`;
  const startedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  return {
    success: true,
    customerId: normalizedId,
    walletBalance: '0.00',
    currency: 'USD',
    challenges: [
      {
        id: SPECIAL_REWARD_CHALLENGE_ID,
        title: 'Invite 5 friends in 7 days',
        subtitle: 'Bring your circle to NOOD and unlock your reward faster.',
        rewardAmount: SPECIAL_REWARD_USD_AMOUNT,
        rewardCurrency: 'USD',
        rewardLabel: SPECIAL_REWARD_USD_LABEL,
        inviteGoal: 5,
        invitedCount: 0,
        daysLeft: 7,
        expiresAt,
        startedAt,
        shareCount: 0,
        referralCode,
        referralLink: `shop.66320990292.nood://invite?code=${encodeURIComponent(referralCode)}`,
        claimed: false,
        eligibleToClaim: false,
        claimReason: 'complete_challenge_first',
      },
    ],
  };
}

export async function fetchRewardsStatus(customerId: string): Promise<RewardsStatusFetchResult> {
  const encodedId = encodeURIComponent(customerId);
  const paths = [
    `/api/rewards/status?customerId=${encodedId}`,
    `/api/rewards/challenges?customerId=${encodedId}`,
  ];

  for (const path of paths) {
    try {
      const data = await fetchBackendJson<any>(path);
      const normalized = normalizeRewardsStatusPayload(data, customerId);
      if (normalized) {
        return { status: normalized, usingFallback: false };
      }
    } catch (error) {
      if (__DEV__) {
        console.log('[Rewards] status fetch failed', {
          path,
          message: String((error as any)?.message || error || ''),
        });
      }
    }
  }

  return {
    status: buildFallbackRewardsStatus(customerId),
    usingFallback: true,
  };
}

export async function recordRewardShare(customerId: string, channel = 'whatsapp') {
  return postBackendJson('/api/rewards/referral/share', {
    customerId,
    channel,
  }) as Promise<RewardShareResponse>;
}

export async function claimSpecialReward(customerId: string, challengeId = SPECIAL_REWARD_CHALLENGE_ID) {
  return postBackendJson('/api/rewards/claim', {
    customerId,
    challengeId,
  }) as Promise<RewardClaimResponse>;
}

export async function attributeReferral(referralCode: string, referredCustomerId: string) {
  return postBackendJson('/api/rewards/referral/attributed', {
    referralCode,
    referredCustomerId,
  });
}

export function getPrimaryChallenge(status: RewardsStatusResponse | null | undefined) {
  if (!status?.challenges?.length) return null;
  return (
    status.challenges.find((challenge) => challenge.id === SPECIAL_REWARD_CHALLENGE_ID) ||
    status.challenges[0]
  );
}