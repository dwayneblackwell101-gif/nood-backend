/**
 * Server-authoritative rewards configuration.
 * Clients must never decide eligibility or prize amounts.
 */

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function envInt(name, fallback) {
  const raw = safeString(process.env[name]);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function envFloat(name, fallback) {
  const raw = safeString(process.env[name]);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const SPECIAL_REWARD_CHALLENGE_ID = 'invite_5_friends_7_days';

const LUCKY_SPIN_PRIZES = [
  { id: 'spin_5', amountUsd: 5, unlockRequirementUsd: 25, label: '$5 USD', weight: 40 },
  { id: 'spin_10', amountUsd: 10, unlockRequirementUsd: 40, label: '$10 USD', weight: 30 },
  { id: 'spin_15', amountUsd: 15, unlockRequirementUsd: 60, label: '$15 USD', weight: 20 },
  { id: 'spin_20', amountUsd: 20, unlockRequirementUsd: 80, label: '$20 USD', weight: 10 },
];

function getRewardsConfig(env = process.env) {
  return {
    currency: 'USD',
    deepLinkScheme: safeString(env.APP_DEEP_LINK_SCHEME, 'shop.66320990292.nood'),
    specialChallenge: {
      id: SPECIAL_REWARD_CHALLENGE_ID,
      title: 'Invite 5 friends in 7 days',
      subtitle: 'Bring your circle to NOOD and unlock your reward faster.',
      rewardAmountUsd: envFloat('REWARDS_SPECIAL_AMOUNT_USD', 10),
      rewardLabel: safeString(env.REWARDS_SPECIAL_LABEL, '$10 USD NOOD Balance'),
      inviteGoal: envInt('REWARDS_SPECIAL_INVITE_GOAL', 5),
      durationDays: envInt('REWARDS_SPECIAL_DURATION_DAYS', 7),
    },
    luckySpin: {
      prizes: LUCKY_SPIN_PRIZES,
      // One-time lifetime spin by default (matches client copy).
      oneTime: String(env.REWARDS_LUCKY_SPIN_ONE_TIME || 'true').toLowerCase() !== 'false',
    },
    scratch: {
      amountUsd: envFloat('REWARDS_SCRATCH_AMOUNT_USD', 10),
      cooldownDays: envInt('REWARDS_SCRATCH_COOLDOWN_DAYS', 14),
      tokensWhenEligible: 1,
    },
    daily: {
      amountUsd: envFloat('REWARDS_DAILY_AMOUNT_USD', 0.5),
      streakBonusEvery: envInt('REWARDS_DAILY_STREAK_EVERY', 7),
      streakBonusUsd: envFloat('REWARDS_DAILY_STREAK_BONUS_USD', 2),
    },
    missions: [
      {
        id: 'first_order',
        title: 'Complete your first order',
        rewardAmountUsd: envFloat('REWARDS_MISSION_FIRST_ORDER_USD', 5),
      },
      {
        id: 'browse_10',
        title: 'Browse 10 products',
        target: 10,
        rewardAmountUsd: envFloat('REWARDS_MISSION_BROWSE_USD', 1),
      },
    ],
    shareChannels: new Set(['whatsapp', 'sms', 'instagram', 'facebook', 'twitter', 'x', 'copy', 'system', 'other']),
    rateLimits: {
      statusPerMinute: envInt('REWARDS_RATE_STATUS_PER_MIN', 60),
      mutatePerMinute: envInt('REWARDS_RATE_MUTATE_PER_MIN', 20),
      attributionPerHour: envInt('REWARDS_RATE_ATTR_PER_HOUR', 10),
    },
    fraud: {
      maxReferralsPerDay: envInt('REWARDS_MAX_REFERRALS_PER_DAY', 20),
      maxSameIpAttributionsPerDay: envInt('REWARDS_MAX_SAME_IP_ATTR_PER_DAY', 15),
      minAccountAgeSecondsForClaim: envInt('REWARDS_MIN_ACCOUNT_AGE_SECONDS', 0),
    },
    lockTtlSeconds: envInt('REWARDS_LOCK_TTL_SECONDS', 30),
    idempotencyTtlSeconds: envInt('REWARDS_IDEMPOTENCY_TTL_SECONDS', 60 * 60 * 24 * 30),
    historyLimit: envInt('REWARDS_HISTORY_LIMIT', 100),
  };
}

module.exports = {
  SPECIAL_REWARD_CHALLENGE_ID,
  LUCKY_SPIN_PRIZES,
  getRewardsConfig,
};
