/**
 * NOOD — Server-authoritative Rewards / Referral / Wallet API.
 *
 * All financial actions require x-push-token identity (never trust a bare
 * customerId for writes). Reads accept customerId for backward compat but
 * resolve balance from the reward_ledger / wallet_transactions tables.
 *
 * Endpoints:
 *   GET  /api/rewards/capabilities     — reward capability flags
 *   GET  /api/rewards/status           — wallet balance + referral challenge
 *   GET  /api/rewards/loyalty/status   — tier/progress/history
 *   GET  /api/wallet/transactions      — wallet transaction history
 *   POST /api/rewards/referral/share       — get/issue referral code
 *   POST /api/rewards/referral/attributed  — attribute a referred signup
 *   POST /api/rewards/claim                — claim referral reward (ledger)
 */

const express = require('express');
const crypto = require('crypto');
const { authenticateCustomer } = require('../services/customer-auth');
const {
  issueReward,
  getWalletBalance,
  listWalletTxns,
} = require('../utils/reward-ledger');
const {
  getLoyalty,
} = require('../utils/loyalty');
const { fireReferralNotification } = require('../utils/notification-triggers');
const {
  getOrCreateReferralCodePersistent,
  attributeReferralPersistent,
  markReferralRewardedPersistent,
} = require('../utils/referral-helper');

const router = express.Router();

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

const REWARD_CAPABILITY_ENV = Object.freeze({
  referralChallenge: 'REWARD_REFERRAL_CHALLENGE_ENABLED',
  styleChallenges: 'REWARD_STYLE_CHALLENGES_ENABLED',
});

function rewardCapabilityEnabled(name) {
  if (process.env.NODE_ENV === 'test') return true;
  const envName = REWARD_CAPABILITY_ENV[name];
  return Boolean(envName) && safeString(process.env[envName]).toLowerCase() === 'true';
}

function requireRewardCapability(res, name) {
  if (rewardCapabilityEnabled(name)) return true;
  res.status(503).json({ success: false, code: 'feature_disabled', message: 'This reward is not available yet.' });
  return false;
}

async function resolveIdentity(req) {
  return authenticateCustomer(req);
}

router.get('/api/rewards/capabilities', async (req, res) => {
  const identity = await resolveIdentity(req);
  if (!identity?.userId) return res.status(401).json({ success: false, message: 'Signed-in identity required' });
  return res.json({
    success: true,
    capabilities: Object.fromEntries(
      Object.keys(REWARD_CAPABILITY_ENV).map((name) => [name, rewardCapabilityEnabled(name)])
    ),
  });
});

// ─── GET /api/rewards/status ────────────────────────────────────────────
router.get('/api/rewards/status', async (req, res) => {
  const identity = await resolveIdentity(req);
  const customerId = identity?.userId || '';
  if (!customerId) return res.status(401).json({ success: false, message: 'Signed-in identity required' });

  const balance = await getWalletBalance(customerId);
  const entry = await getOrCreateReferralCodePersistent(customerId);
  const invites = entry?.invites || [];
  const rewardedCount = invites.filter((i) => i.rewarded).length;
  const goal = 5;
  const now = Date.now();
  const startedAt = Number(entry?.createdAt || now);
  const expiresAt = startedAt + 7 * 24 * 60 * 60 * 1000;
  const expired = now >= expiresAt;
  const eligibleToClaim = invites.length >= goal && !expired;

  return res.json({
    success: true,
    customerId,
    walletBalance: balance.toFixed(2),
    currency: 'USD',
    challenges: [
      {
        id: 'invite_5_friends_7_days',
        title: 'Invite 5 friends in 7 days',
        subtitle: 'Earn $10 NOOD Balance',
        rewardAmount: 10,
        rewardCurrency: 'USD',
        rewardLabel: '$10 USD',
        inviteGoal: goal,
        invitedCount: invites.length,
        daysLeft: Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000))),
        expiresAt: new Date(expiresAt).toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        shareCount: invites.length,
        referralCode: entry.code,
        referralLink: `https://noodcaribbean.com/invite?code=${entry.code}`,
        claimed: rewardedCount >= goal,
        eligibleToClaim,
        claimReason: expired ? 'expired' : eligibleToClaim ? 'eligible' : 'complete_challenge_first',
      },
    ],
  });
});

// ─── GET /api/rewards/loyalty/status ────────────────────────────────────
router.get('/api/rewards/loyalty/status', async (req, res) => {
  const identity = await resolveIdentity(req);
  const customerId = identity?.userId || '';
  if (!customerId) return res.status(401).json({ success: false, message: 'Signed-in identity required' });

  const state = await getLoyalty(customerId);
  return res.json({
    success: true,
    customerId,
    tier: state?.tier || 'member',
    tierPoints: state?.tier_points || 0,
    lifetimePoints: state?.lifetime_points || 0,
    progress: state?.progress || 0,
    nextTier: state?.next_tier || 'bronze',
    tierChangedAt: state?.tier_changed_at || null,
    milestones: state?.milestone_history || [],
  });
});

// ─── GET /api/wallet/transactions ───────────────────────────────────────
router.get('/api/wallet/transactions', async (req, res) => {
  const identity = await resolveIdentity(req);
  const customerId = identity?.userId || '';
  if (!customerId) return res.status(401).json({ success: false, message: 'Signed-in identity required' });

  const balance = await getWalletBalance(customerId);
  const txns = await listWalletTxns(customerId);
  return res.json({
    success: true,
    customerId,
    balance: balance.toFixed(2),
    currency: 'USD',
    transactions: txns.map((t) => ({
      txnId: t.txn_id || t.id,
      type: t.type,
      source: t.source,
      amount: Number(t.amount),
      currency: t.currency,
      balanceAfter: Number(t.balance_after || 0),
      reference: t.reference || null,
      createdAt: t.created_at,
    })),
  });
});

// ─── POST /api/rewards/referral/share ───────────────────────────────────
router.post('/api/rewards/referral/share', async (req, res) => {
  const identity = await resolveIdentity(req);
  const customerId = identity?.userId || '';
  if (!customerId) return res.status(401).json({ success: false, message: 'Signed-in identity required' });

  const entry = await getOrCreateReferralCodePersistent(customerId);
  return res.json({
    success: true,
    referralCode: entry.code,
    referralLink: `https://noodcaribbean.com/invite?code=${entry.code}`,
    shareMessage: `Join me on NOOD with code ${entry.code} and help me complete my referral challenge.`,
    invitedCount: entry.invites?.length || 0,
  });
});

// ─── POST /api/rewards/referral/attributed ──────────────────────────────
router.post('/api/rewards/referral/attributed', async (req, res) => {
  const identity = await resolveIdentity(req);
  const referralCode = safeString(req.body?.referralCode, '').toUpperCase();
  const referredCustomerId = identity?.userId || '';

  if (!referralCode || !referredCustomerId) {
    return res.status(401).json({ success: false, message: 'Signed-in identity and referralCode are required' });
  }

  const result = await attributeReferralPersistent(referralCode, referredCustomerId, identity?.email || '');
  if (!result.ok && result.error === 'invalid_code') return res.status(404).json({ success: false, message: 'Invalid referral code' });
  if (!result.ok && result.error === 'self_referral') {
    return res.status(400).json({ success: false, message: 'Cannot refer yourself' });
  }
  if (result.isNew && result.entry.ownerCustomerId) {
    fireReferralNotification({ type: 'referral-joined', userId: result.entry.ownerCustomerId }).catch(() => {});
    if (result.invitedCount >= 5) {
      fireReferralNotification({ type: 'referral-qualified', userId: result.entry.ownerCustomerId }).catch(() => {});
    }
  }
  return res.json({ success: true, message: 'Referral attributed', referralCode, invitedCount: result.invitedCount });
});

// ─── POST /api/rewards/claim (referral reward) ──────────────────────────
router.post('/api/rewards/claim', async (req, res) => {
  const identity = await resolveIdentity(req);
  const customerId = identity?.userId || '';
  const challengeId = safeString(req.body?.challengeId, 'invite_5_friends_7_days');
  if (!customerId) return res.status(401).json({ success: false, message: 'Signed-in identity required' });

  const entry = await getOrCreateReferralCodePersistent(customerId);
  const invites = entry?.invites || [];
  const referralExpiresAt = Number(entry?.createdAt || Date.now()) + 7 * 24 * 60 * 60 * 1000;

  if (Date.now() >= referralExpiresAt) {
    return res.status(400).json({ success: false, message: 'This referral challenge has expired', code: 'expired' });
  }

  if (invites.length < 5) {
    return res.status(400).json({ success: false, message: 'Invite 5 friends before claiming', invitedCount: invites.length });
  }

  const alreadyClaimed = invites.slice(0, 5).every((i) => i.rewarded);
  if (alreadyClaimed) {
    return res.status(400).json({ success: false, message: 'Reward already claimed', code: 'already_claimed' });
  }

  // Idempotent ledger issuance (prevents double reward on replay).
  const issuance = await issueReward({
    user_id: customerId,
    source: 'referral',
    amount: 10,
    currency: 'USD',
    related_id: `referral_${challengeId}`,
    idempotency_key: `referral_reward_${customerId}_${challengeId}`,
    type: 'credit',
    expires_in_ms: 60 * 24 * 60 * 60 * 1000,
    metadata: { challengeId },
  });

  if (issuance.replay) {
    return res.status(400).json({ success: false, message: 'Reward already claimed', code: 'already_claimed' });
  }
  if (!issuance.ok) {
    return res.status(500).json({ success: false, message: 'Failed to issue reward' });
  }

  await markReferralRewardedPersistent(customerId, 5);

  fireReferralNotification({ type: 'referral-reward', userId: customerId }).catch(() => {});

  const balance = await getWalletBalance(customerId);
  return res.json({
    success: true,
    message: 'Reward claimed — $10 NOOD Balance added',
    rewardAmount: 10,
    rewardCurrency: 'USD',
    walletBalance: balance.toFixed(2),
    challengeId,
  });
});

module.exports = { router, rewardCapabilityEnabled };
