/**
 * Server-authoritative rewards business logic.
 * Eligibility, prize selection, and wallet credits are decided only here.
 */

const crypto = require('crypto');
const { getRewardsConfig, SPECIAL_REWARD_CHALLENGE_ID } = require('./config');
const { centsToUsd, usdToCents } = require('../lib/money');
const { normalizeShopifyCustomerId } = require('../auth/customer-auth');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function errorWithCode(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function daysBetweenMs(ms) {
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function utcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function pickWeightedPrize(prizes, rngBytes) {
  const list = Array.isArray(prizes) ? prizes : [];
  const totalWeight = list.reduce((sum, prize) => sum + Math.max(1, Number(prize.weight || 1)), 0);
  let cursor = 0;
  // Use first 4 bytes of random for selection
  const roll = (rngBytes.readUInt32BE(0) % totalWeight) + 1;
  for (const prize of list) {
    cursor += Math.max(1, Number(prize.weight || 1));
    if (roll <= cursor) return prize;
  }
  return list[list.length - 1] || null;
}

function buildReferralCode(customerId) {
  const numeric = safeString(customerId).match(/(\d+)$/)?.[1] || '';
  const suffix = (numeric || crypto.randomBytes(3).toString('hex')).slice(-6).toUpperCase();
  return `NOOD-${suffix.padStart(6, '0').slice(-6)}`;
}

function buildReferralLink(config, code) {
  const scheme = safeString(config.deepLinkScheme, 'shop.66320990292.nood');
  return `${scheme}://invite?code=${encodeURIComponent(code)}`;
}

function createRewardsService({
  store,
  redisWallet = null,
  lockService = null,
  config = getRewardsConfig(),
  nowFn = () => new Date(),
  randomBytesFn = (n) => crypto.randomBytes(n),
} = {}) {
  if (!store) {
    throw new Error('Rewards store is required.');
  }

  async function audit(event, detail = {}) {
    const entry = {
      event,
      at: nowFn().toISOString(),
      ...detail,
      // Never store tokens
      token: undefined,
    };
    await store.pushAudit(entry);
    await store.incrMetric(`event:${event}`);
    console.log('[REWARDS AUDIT]', {
      event,
      customerId: detail.customerId || null,
      actionId: detail.actionId || null,
      code: detail.code || null,
      success: detail.success,
    });
  }

  async function withCustomerLock(customerId, fn) {
    if (!lockService?.withLock) {
      return fn();
    }
    return lockService.withLock(`rewards:${safeString(customerId)}`, config.lockTtlSeconds, fn);
  }

  async function checkRateLimit(bucket, limit, windowSeconds, code = 'rate_limited') {
    const count = await store.incrRate(bucket, windowSeconds);
    if (count > limit) {
      throw errorWithCode('Too many rewards requests. Please try again shortly.', 429, code);
    }
  }

  async function getWalletBalanceUsd(customerId) {
    if (redisWallet?.getBalanceCents) {
      return centsToUsd(await redisWallet.getBalanceCents(customerId));
    }
    return '0.00';
  }

  async function creditWallet({ customerId, amountUsd, operationKey, source, metadata = {} }) {
    if (!redisWallet?.credit) {
      throw errorWithCode(
        'Wallet ledger is unavailable. Rewards cannot be credited.',
        503,
        'wallet_unavailable'
      );
    }

    const amountCents = usdToCents(String(Number(amountUsd).toFixed(2)));
    if (amountCents <= 0) {
      throw errorWithCode('Invalid reward amount.', 500, 'invalid_reward_amount');
    }

    const result = await redisWallet.credit({
      customerId,
      amountCents,
      idempotencyKey: operationKey,
      source,
      metadata,
    });

    return {
      walletTransactionId: result.walletTransactionId || result.transactionId,
      resultingBalanceUsd: centsToUsd(result.resultingBalanceCents),
      duplicate: Boolean(result.duplicate),
    };
  }

  async function ensureReferralCode(profile) {
    if (profile.referralCode) return profile;
    let code = buildReferralCode(profile.customerId);
    // Collision resistance: append random if taken by another customer
    const existingOwner = await store.getCustomerIdByReferralCode(code);
    if (existingOwner && existingOwner !== profile.customerId) {
      code = `NOOD-${randomBytesFn(3).toString('hex').toUpperCase()}`;
    }
    profile.referralCode = code;
    await store.setReferralCodeIndex(code, profile.customerId);
    return store.saveProfile(profile);
  }

  function ensureChallenge(profile) {
    const now = nowFn();
    const challengeCfg = config.specialChallenge;
    if (profile.challenge?.id === challengeCfg.id) {
      return profile;
    }

    const startedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + challengeCfg.durationDays * 24 * 60 * 60 * 1000).toISOString();
    profile.challenge = {
      id: challengeCfg.id,
      startedAt,
      expiresAt,
      invitedCount: 0,
      shareCount: 0,
      invitedCustomerIds: [],
      claimed: false,
      claimedAt: null,
      claimWalletTransactionId: null,
    };
    return profile;
  }

  function serializeChallenge(profile, configRef = config) {
    const challenge = profile.challenge;
    const cfg = configRef.specialChallenge;
    if (!challenge) {
      return null;
    }

    const now = nowFn();
    const expiresAtMs = new Date(challenge.expiresAt).getTime();
    const expired = Number.isFinite(expiresAtMs) && expiresAtMs < now.getTime();
    const daysLeft = expired
      ? 0
      : daysBetweenMs(Math.max(0, expiresAtMs - now.getTime()));

    let claimReason = 'complete_challenge_first';
    if (challenge.claimed) claimReason = 'already_claimed';
    else if (expired) claimReason = 'expired';
    else if (Number(challenge.invitedCount || 0) >= cfg.inviteGoal) claimReason = 'eligible';

    return {
      id: challenge.id || cfg.id,
      title: cfg.title,
      subtitle: cfg.subtitle,
      rewardAmount: cfg.rewardAmountUsd,
      rewardCurrency: configRef.currency,
      rewardLabel: cfg.rewardLabel,
      inviteGoal: cfg.inviteGoal,
      invitedCount: Number(challenge.invitedCount || 0),
      daysLeft,
      expiresAt: challenge.expiresAt,
      startedAt: challenge.startedAt,
      shareCount: Number(challenge.shareCount || 0),
      referralCode: profile.referralCode || '',
      referralLink: buildReferralLink(configRef, profile.referralCode || ''),
      claimed: Boolean(challenge.claimed),
      eligibleToClaim: claimReason === 'eligible',
      claimReason,
    };
  }

  function serializeLuckySpin(profile) {
    const usedAt = profile.luckySpin?.usedAt || null;
    const used = Boolean(usedAt);
    const canSpin = config.luckySpin.oneTime ? !used : true;
    return {
      success: true,
      customerId: profile.customerId,
      canSpin,
      used,
      luckySpinUsedAt: usedAt,
      luckySpinRewardAmountUsd: profile.luckySpin?.amountUsd ?? null,
      alreadyClaimed: used,
      demoOnly: false,
      walletCredited: used,
      prize: used
        ? {
            id: profile.luckySpin.prizeId,
            amountUsd: profile.luckySpin.amountUsd,
            unlockRequirementUsd: profile.luckySpin.unlockRequirementUsd,
            label: profile.luckySpin.label,
          }
        : null,
    };
  }

  function serializeScratch(profile) {
    const completedAt = profile.scratch?.completedAt || null;
    const cooldownMs = config.scratch.cooldownDays * 24 * 60 * 60 * 1000;
    let cooldownDaysRemaining = 0;
    let nextAvailableAt = null;
    let canPlay = true;

    if (completedAt) {
      const completedMs = new Date(completedAt).getTime();
      const elapsed = nowFn().getTime() - completedMs;
      if (elapsed < cooldownMs) {
        canPlay = false;
        cooldownDaysRemaining = Math.max(1, daysBetweenMs(cooldownMs - elapsed));
        nextAvailableAt = new Date(completedMs + cooldownMs).toISOString();
      }
    }

    return {
      success: true,
      canPlay,
      scratchTokens: canPlay ? config.scratch.tokensWhenEligible : 0,
      nextAvailableAt,
      completedAt,
      cooldownDaysRemaining,
      alreadyClaimed: Boolean(completedAt) && !canPlay,
      popupEligible: canPlay,
    };
  }

  function serializeDaily(profile) {
    const today = utcDateKey(nowFn());
    const last = profile.daily?.lastCheckInDate || null;
    return {
      canCheckIn: last !== today,
      lastCheckInDate: last,
      streak: Number(profile.daily?.streak || 0),
      totalCheckIns: Number(profile.daily?.totalCheckIns || 0),
      rewardAmountUsd: config.daily.amountUsd,
      currency: config.currency,
    };
  }

  function serializeMissions(profile) {
    return (config.missions || []).map((mission) => {
      const state = profile.missions?.[mission.id] || {};
      return {
        id: mission.id,
        title: mission.title,
        target: mission.target || 1,
        progress: Number(state.progress || 0),
        completed: Boolean(state.completed),
        claimed: Boolean(state.claimed),
        rewardAmountUsd: mission.rewardAmountUsd,
        currency: config.currency,
      };
    });
  }

  async function loadReadyProfile(customerId) {
    let profile = await store.getOrCreateProfile(customerId);
    profile = await ensureReferralCode(profile);
    profile = ensureChallenge(profile);
    if (!profile.challenge?.startedAt) {
      profile = ensureChallenge(profile);
    }
    return store.saveProfile(profile);
  }

  async function getStatus(customerId, risk = {}) {
    await checkRateLimit(
      `status:${customerId}:${utcDateKey(nowFn())}:${nowFn().getUTCMinutes()}`,
      config.rateLimits.statusPerMinute,
      60
    );

    const profile = await loadReadyProfile(customerId);
    const walletBalance = await getWalletBalanceUsd(customerId);
    const challenges = [serializeChallenge(profile)].filter(Boolean);

    await audit('status_read', {
      customerId,
      success: true,
      ipHash: hashValue(risk.ip),
    });

    return {
      success: true,
      customerId,
      walletBalance,
      currency: config.currency,
      challenges,
      luckySpin: serializeLuckySpin(profile),
      scratch: serializeScratch(profile),
      daily: serializeDaily(profile),
      missions: serializeMissions(profile),
    };
  }

  async function getChallenges(customerId) {
    const status = await getStatus(customerId);
    return {
      success: true,
      customerId,
      walletBalance: status.walletBalance,
      currency: status.currency,
      challenges: status.challenges,
    };
  }

  async function recordShare(customerId, channel, risk = {}) {
    await checkRateLimit(`mutate:${customerId}`, config.rateLimits.mutatePerMinute, 60);

    const normalizedChannel = safeString(channel, 'other').toLowerCase();
    if (!config.shareChannels.has(normalizedChannel)) {
      throw errorWithCode('Share channel is not allowed.', 400, 'invalid_channel');
    }

    return withCustomerLock(customerId, async () => {
      let profile = await loadReadyProfile(customerId);
      profile.challenge.shareCount = Number(profile.challenge.shareCount || 0) + 1;
      profile = await store.saveProfile(profile);

      const challenge = serializeChallenge(profile);
      const actionId = store.createActionId('share');
      await store.pushHistory(
        customerId,
        {
          actionId,
          type: 'referral_share',
          channel: normalizedChannel,
          at: nowFn().toISOString(),
        },
        config.historyLimit
      );
      await audit('referral_share', {
        customerId,
        actionId,
        success: true,
        channel: normalizedChannel,
        ipHash: hashValue(risk.ip),
      });

      return {
        success: true,
        referralCode: profile.referralCode,
        referralLink: buildReferralLink(config, profile.referralCode),
        shareMessage: `Join me on NOOD Caribbean! Use my invite code ${profile.referralCode}`,
        challenge,
      };
    });
  }

  async function attributeReferral({ referralCode, referredCustomerId, risk = {} }) {
    const code = safeString(referralCode).toUpperCase();
    const referredId = normalizeShopifyCustomerId(referredCustomerId) || safeString(referredCustomerId);

    if (!code || !referredId) {
      throw errorWithCode('referralCode and referredCustomerId are required.', 400, 'validation_error');
    }

    await checkRateLimit(`attr:${hashValue(risk.ip || referredId)}`, config.rateLimits.attributionPerHour, 3600);

    const referrerId = await store.getCustomerIdByReferralCode(code);
    if (!referrerId) {
      throw errorWithCode('Referral code is invalid.', 404, 'not_eligible');
    }

    if (referrerId === referredId) {
      throw errorWithCode('You cannot use your own referral code.', 400, 'not_eligible');
    }

    const existing = await store.getAttribution(referredId);
    if (existing) {
      return {
        success: true,
        duplicate: true,
        code: 'already_claimed',
        message: 'Referral already attributed for this customer.',
        attribution: existing,
      };
    }

    // Fraud: cap same IP attributions
    if (risk.ip) {
      const ipCount = await store.incrRate(`attr_ip:${hashValue(risk.ip)}:${utcDateKey(nowFn())}`, 86400);
      if (ipCount > config.fraud.maxSameIpAttributionsPerDay) {
        await audit('referral_attr_blocked', {
          customerId: referredId,
          success: false,
          code: 'fraud_ip_limit',
          ipHash: hashValue(risk.ip),
        });
        throw errorWithCode('Referral attribution temporarily blocked.', 429, 'rate_limited');
      }
    }

    return withCustomerLock(referrerId, async () => {
      let referrer = await loadReadyProfile(referrerId);
      const dayKey = utcDateKey(nowFn());
      const dayCount = await store.incrRate(`attr_ref:${referrerId}:${dayKey}`, 86400);
      if (dayCount > config.fraud.maxReferralsPerDay) {
        throw errorWithCode('Daily referral limit reached.', 429, 'rate_limited');
      }

      const now = nowFn();
      const expiresAtMs = new Date(referrer.challenge.expiresAt).getTime();
      if (Number.isFinite(expiresAtMs) && expiresAtMs < now.getTime()) {
        throw errorWithCode('Referral challenge has expired.', 400, 'expired');
      }

      if ((referrer.challenge.invitedCustomerIds || []).includes(referredId)) {
        return {
          success: true,
          duplicate: true,
          code: 'already_claimed',
          message: 'This customer was already counted for the referrer.',
        };
      }

      referrer.challenge.invitedCustomerIds = [
        ...(referrer.challenge.invitedCustomerIds || []),
        referredId,
      ];
      referrer.challenge.invitedCount = referrer.challenge.invitedCustomerIds.length;
      referrer = await store.saveProfile(referrer);

      const attribution = {
        referralCode: code,
        referrerCustomerId: referrerId,
        referredCustomerId: referredId,
        attributedAt: now.toISOString(),
        ipHash: hashValue(risk.ip),
        deviceHash: hashValue(risk.deviceId),
      };
      await store.saveAttribution(attribution);

      const actionId = store.createActionId('attr');
      await store.pushHistory(
        referrerId,
        {
          actionId,
          type: 'referral_attributed',
          referredCustomerId: referredId,
          at: attribution.attributedAt,
        },
        config.historyLimit
      );
      await audit('referral_attributed', {
        customerId: referrerId,
        actionId,
        success: true,
        referredCustomerId: referredId,
        ipHash: hashValue(risk.ip),
      });

      return {
        success: true,
        duplicate: false,
        attribution,
        challenge: serializeChallenge(referrer),
      };
    });
  }

  async function claimChallenge(customerId, challengeId, idempotencyKey, risk = {}) {
    await checkRateLimit(`mutate:${customerId}`, config.rateLimits.mutatePerMinute, 60);

    const key = safeString(idempotencyKey) || `claim:${safeString(challengeId || SPECIAL_REWARD_CHALLENGE_ID)}`;
    const cached = await store.getIdempotency(customerId, key);
    if (cached) {
      await audit('claim_idempotent_replay', { customerId, success: true, code: 'idempotent' });
      return { ...cached, idempotentReplay: true };
    }

    return withCustomerLock(customerId, async () => {
      const again = await store.getIdempotency(customerId, key);
      if (again) return { ...again, idempotentReplay: true };

      let profile = await loadReadyProfile(customerId);
      const challenge = serializeChallenge(profile);
      if (!challenge) {
        throw errorWithCode('Challenge not found.', 404, 'not_eligible');
      }
      if (safeString(challengeId) && challenge.id !== challengeId) {
        throw errorWithCode('Challenge not found.', 404, 'not_eligible');
      }
      if (challenge.claimReason === 'already_claimed') {
        throw errorWithCode('Reward already claimed.', 409, 'already_claimed');
      }
      if (challenge.claimReason === 'expired') {
        throw errorWithCode('Challenge has expired.', 400, 'expired');
      }
      if (challenge.claimReason !== 'eligible') {
        throw errorWithCode('Complete the challenge before claiming.', 400, 'not_eligible');
      }

      const operationKey = `reward:claim:${customerId}:${challenge.id}`;
      const credit = await creditWallet({
        customerId,
        amountUsd: challenge.rewardAmount,
        operationKey,
        source: 'rewards_challenge_claim',
        metadata: { challengeId: challenge.id },
      });

      profile.challenge.claimed = true;
      profile.challenge.claimedAt = nowFn().toISOString();
      profile.challenge.claimWalletTransactionId = credit.walletTransactionId;
      profile = await store.saveProfile(profile);

      const actionId = store.createActionId('claim');
      const response = {
        success: true,
        message: 'Reward claimed successfully.',
        walletBalance: credit.resultingBalanceUsd,
        rewardAmount: challenge.rewardAmount,
        rewardCurrency: config.currency,
        challenge: serializeChallenge(profile),
        actionId,
        walletTransactionId: credit.walletTransactionId,
      };

      await store.saveIdempotency(customerId, key, response, config.idempotencyTtlSeconds);
      await store.pushHistory(
        customerId,
        {
          actionId,
          type: 'challenge_claim',
          amountUsd: challenge.rewardAmount,
          at: nowFn().toISOString(),
          walletTransactionId: credit.walletTransactionId,
        },
        config.historyLimit
      );
      await audit('challenge_claim', {
        customerId,
        actionId,
        success: true,
        amountUsd: challenge.rewardAmount,
        ipHash: hashValue(risk.ip),
        idempotencyKeyHash: hashValue(key),
      });

      return response;
    });
  }

  async function getLuckySpinStatus(customerId) {
    await checkRateLimit(`status:${customerId}:spin`, config.rateLimits.statusPerMinute, 60);
    const profile = await loadReadyProfile(customerId);
    return serializeLuckySpin(profile);
  }

  async function spinLuckySpin(customerId, idempotencyKey, risk = {}) {
    await checkRateLimit(`mutate:${customerId}`, config.rateLimits.mutatePerMinute, 60);
    const key = safeString(idempotencyKey) || 'lucky-spin:spin';
    const cached = await store.getIdempotency(customerId, key);
    if (cached) return { ...cached, idempotentReplay: true };

    return withCustomerLock(customerId, async () => {
      const again = await store.getIdempotency(customerId, key);
      if (again) return { ...again, idempotentReplay: true };

      let profile = await loadReadyProfile(customerId);
      if (config.luckySpin.oneTime && profile.luckySpin?.usedAt) {
        throw errorWithCode('Lucky Spin already used.', 409, 'already_claimed');
      }

      const rng = randomBytesFn(8);
      const prize = pickWeightedPrize(config.luckySpin.prizes, rng);
      if (!prize) {
        throw errorWithCode('Lucky Spin prize pool is empty.', 500, 'not_eligible');
      }

      const operationKey = `reward:lucky_spin:${customerId}`;
      const credit = await creditWallet({
        customerId,
        amountUsd: prize.amountUsd,
        operationKey,
        source: 'rewards_lucky_spin',
        metadata: { prizeId: prize.id, rngHash: hashValue(rng.toString('hex')) },
      });

      profile.luckySpin = {
        usedAt: nowFn().toISOString(),
        prizeId: prize.id,
        amountUsd: prize.amountUsd,
        unlockRequirementUsd: prize.unlockRequirementUsd,
        label: prize.label,
        walletTransactionId: credit.walletTransactionId,
      };
      profile = await store.saveProfile(profile);

      const actionId = store.createActionId('spin');
      const response = {
        ...serializeLuckySpin(profile),
        success: true,
        walletCredited: true,
        walletBalance: credit.resultingBalanceUsd,
        actionId,
        walletTransactionId: credit.walletTransactionId,
      };

      await store.saveIdempotency(customerId, key, response, config.idempotencyTtlSeconds);
      await store.pushHistory(
        customerId,
        {
          actionId,
          type: 'lucky_spin',
          amountUsd: prize.amountUsd,
          prizeId: prize.id,
          at: profile.luckySpin.usedAt,
          walletTransactionId: credit.walletTransactionId,
        },
        config.historyLimit
      );
      await audit('lucky_spin', {
        customerId,
        actionId,
        success: true,
        amountUsd: prize.amountUsd,
        prizeId: prize.id,
        ipHash: hashValue(risk.ip),
        idempotencyKeyHash: hashValue(key),
      });

      return response;
    });
  }

  async function getScratchStatus(customerId) {
    await checkRateLimit(`status:${customerId}:scratch`, config.rateLimits.statusPerMinute, 60);
    const profile = await loadReadyProfile(customerId);
    return serializeScratch(profile);
  }

  async function claimScratch(customerId, idempotencyKey, risk = {}) {
    await checkRateLimit(`mutate:${customerId}`, config.rateLimits.mutatePerMinute, 60);
    const key = safeString(idempotencyKey) || 'scratch:claim';
    const cached = await store.getIdempotency(customerId, key);
    if (cached) return { ...cached, idempotentReplay: true };

    return withCustomerLock(customerId, async () => {
      const again = await store.getIdempotency(customerId, key);
      if (again) return { ...again, idempotentReplay: true };

      let profile = await loadReadyProfile(customerId);
      const status = serializeScratch(profile);
      if (!status.canPlay) {
        throw errorWithCode(
          status.alreadyClaimed ? 'Scratch Prize is on cooldown.' : 'Not eligible for Scratch Prize.',
          409,
          status.alreadyClaimed ? 'already_claimed' : 'not_eligible'
        );
      }

      const amountUsd = config.scratch.amountUsd;
      // Stable per play-cycle so retries never double-credit; after cooldown a new cycle key applies.
      const cycleKey = status.completedAt
        ? status.canPlay
          ? `after_${status.completedAt}`
          : status.completedAt
        : 'first';
      const operationKey = `reward:scratch:${customerId}:${cycleKey}`;

      const credit = await creditWallet({
        customerId,
        amountUsd,
        operationKey,
        source: 'rewards_scratch',
        metadata: { amountUsd, cycleKey },
      });

      profile.scratch = {
        completedAt: nowFn().toISOString(),
        amountUsd,
        walletTransactionId: credit.walletTransactionId,
      };
      profile = await store.saveProfile(profile);

      const actionId = store.createActionId('scratch');
      const response = {
        ...serializeScratch(profile),
        success: true,
        walletBalance: credit.resultingBalanceUsd,
        rewardAmount: amountUsd,
        rewardCurrency: config.currency,
        message: 'Scratch Prize claimed.',
        actionId,
        walletTransactionId: credit.walletTransactionId,
      };

      await store.saveIdempotency(customerId, key, response, config.idempotencyTtlSeconds);
      await store.pushHistory(
        customerId,
        {
          actionId,
          type: 'scratch_claim',
          amountUsd,
          at: profile.scratch.completedAt,
          walletTransactionId: credit.walletTransactionId,
        },
        config.historyLimit
      );
      await audit('scratch_claim', {
        customerId,
        actionId,
        success: true,
        amountUsd,
        ipHash: hashValue(risk.ip),
        idempotencyKeyHash: hashValue(key),
      });

      return response;
    });
  }

  async function dailyCheckIn(customerId, idempotencyKey, risk = {}) {
    await checkRateLimit(`mutate:${customerId}`, config.rateLimits.mutatePerMinute, 60);
    const today = utcDateKey(nowFn());
    const key = safeString(idempotencyKey) || `daily:${today}`;
    const cached = await store.getIdempotency(customerId, key);
    if (cached) return { ...cached, idempotentReplay: true };

    return withCustomerLock(customerId, async () => {
      const again = await store.getIdempotency(customerId, key);
      if (again) return { ...again, idempotentReplay: true };

      let profile = await loadReadyProfile(customerId);
      if (profile.daily?.lastCheckInDate === today) {
        throw errorWithCode('Daily reward already claimed today.', 409, 'already_claimed');
      }

      const yesterday = utcDateKey(new Date(nowFn().getTime() - 24 * 60 * 60 * 1000));
      let streak = 1;
      if (profile.daily?.lastCheckInDate === yesterday) {
        streak = Number(profile.daily.streak || 0) + 1;
      }

      let amountUsd = config.daily.amountUsd;
      let bonusUsd = 0;
      if (config.daily.streakBonusEvery > 0 && streak % config.daily.streakBonusEvery === 0) {
        bonusUsd = config.daily.streakBonusUsd;
        amountUsd += bonusUsd;
      }

      const credit = await creditWallet({
        customerId,
        amountUsd,
        operationKey: `reward:daily:${customerId}:${today}`,
        source: 'rewards_daily_checkin',
        metadata: { streak, bonusUsd },
      });

      profile.daily = {
        lastCheckInDate: today,
        streak,
        totalCheckIns: Number(profile.daily?.totalCheckIns || 0) + 1,
      };
      profile = await store.saveProfile(profile);

      const actionId = store.createActionId('daily');
      const response = {
        success: true,
        daily: serializeDaily(profile),
        rewardAmount: amountUsd,
        bonusUsd,
        walletBalance: credit.resultingBalanceUsd,
        rewardCurrency: config.currency,
        actionId,
      };

      await store.saveIdempotency(customerId, key, response, config.idempotencyTtlSeconds);
      await store.pushHistory(
        customerId,
        {
          actionId,
          type: 'daily_checkin',
          amountUsd,
          streak,
          at: nowFn().toISOString(),
          walletTransactionId: credit.walletTransactionId,
        },
        config.historyLimit
      );
      await audit('daily_checkin', {
        customerId,
        actionId,
        success: true,
        amountUsd,
        streak,
        ipHash: hashValue(risk.ip),
      });

      return response;
    });
  }

  async function getHistory(customerId, limit = 50) {
    await checkRateLimit(`status:${customerId}:history`, config.rateLimits.statusPerMinute, 60);
    const items = await store.listHistory(customerId, Math.min(limit, config.historyLimit));
    return {
      success: true,
      customerId,
      items,
    };
  }

  async function progressMission(customerId, missionId, increment = 1) {
    // Server-side mission progress hooks (orders/browse) can call this later.
    return withCustomerLock(customerId, async () => {
      let profile = await loadReadyProfile(customerId);
      const mission = (config.missions || []).find((m) => m.id === missionId);
      if (!mission) {
        throw errorWithCode('Mission not found.', 404, 'not_eligible');
      }
      const state = profile.missions[missionId] || { progress: 0, completed: false, claimed: false };
      if (state.claimed) {
        return { success: true, mission: serializeMissions(profile).find((m) => m.id === missionId) };
      }
      state.progress = Number(state.progress || 0) + Math.max(1, Number(increment) || 1);
      const target = mission.target || 1;
      if (state.progress >= target) {
        state.completed = true;
      }
      profile.missions[missionId] = state;
      profile = await store.saveProfile(profile);
      return { success: true, mission: serializeMissions(profile).find((m) => m.id === missionId) };
    });
  }

  async function claimMission(customerId, missionId, idempotencyKey, risk = {}) {
    await checkRateLimit(`mutate:${customerId}`, config.rateLimits.mutatePerMinute, 60);
    const key = safeString(idempotencyKey) || `mission:${missionId}`;
    const cached = await store.getIdempotency(customerId, key);
    if (cached) return { ...cached, idempotentReplay: true };

    return withCustomerLock(customerId, async () => {
      const again = await store.getIdempotency(customerId, key);
      if (again) return { ...again, idempotentReplay: true };

      let profile = await loadReadyProfile(customerId);
      const mission = (config.missions || []).find((m) => m.id === missionId);
      if (!mission) {
        throw errorWithCode('Mission not found.', 404, 'not_eligible');
      }
      const state = profile.missions[missionId] || { progress: 0, completed: false, claimed: false };
      if (state.claimed) {
        throw errorWithCode('Mission reward already claimed.', 409, 'already_claimed');
      }
      if (!state.completed && Number(state.progress || 0) < (mission.target || 1)) {
        throw errorWithCode('Mission is not complete.', 400, 'not_eligible');
      }

      const credit = await creditWallet({
        customerId,
        amountUsd: mission.rewardAmountUsd,
        operationKey: `reward:mission:${customerId}:${missionId}`,
        source: 'rewards_mission',
        metadata: { missionId },
      });

      state.completed = true;
      state.claimed = true;
      state.claimedAt = nowFn().toISOString();
      state.walletTransactionId = credit.walletTransactionId;
      profile.missions[missionId] = state;
      profile = await store.saveProfile(profile);

      const actionId = store.createActionId('mission');
      const response = {
        success: true,
        mission: serializeMissions(profile).find((m) => m.id === missionId),
        rewardAmount: mission.rewardAmountUsd,
        walletBalance: credit.resultingBalanceUsd,
        rewardCurrency: config.currency,
        actionId,
      };

      await store.saveIdempotency(customerId, key, response, config.idempotencyTtlSeconds);
      await store.pushHistory(
        customerId,
        {
          actionId,
          type: 'mission_claim',
          missionId,
          amountUsd: mission.rewardAmountUsd,
          at: nowFn().toISOString(),
          walletTransactionId: credit.walletTransactionId,
        },
        config.historyLimit
      );
      await audit('mission_claim', {
        customerId,
        actionId,
        success: true,
        missionId,
        amountUsd: mission.rewardAmountUsd,
        ipHash: hashValue(risk.ip),
      });

      return response;
    });
  }

  return {
    getStatus,
    getChallenges,
    recordShare,
    attributeReferral,
    claimChallenge,
    getLuckySpinStatus,
    spinLuckySpin,
    getScratchStatus,
    claimScratch,
    dailyCheckIn,
    getHistory,
    progressMission,
    claimMission,
    config,
  };
}

module.exports = {
  createRewardsService,
  pickWeightedPrize,
  buildReferralCode,
  errorWithCode,
};
