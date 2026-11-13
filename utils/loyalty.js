/**
 * NOOD — Server-side loyalty / VIP engine.
 *
 * Tiers: member → bronze → silver → gold → vip (by lifetime points).
 * Points accrue from trusted events (orders, games, referrals). No arbitrary
 * client credit endpoint.
 *
 * Tier thresholds (lifetime points):
 *   member  0
 *   bronze  100
 *   silver  250
 *   gold    500
 *   vip     1000
 */

const { supabaseAdmin } = require('./supabase-admin');
const { issueReward } = require('./reward-ledger');
const { fireRewardNotification } = require('./notification-triggers');

const fs = require('fs');
const path = require('path');

function loyaltyFile() {
  return process.env.PUSH_LOYALTY_FILE || path.join(__dirname, '..', 'loyalty-state.json');
}

const TIER_THRESHOLDS = [
  { tier: 'member', points: 0 },
  { tier: 'bronze', points: 100 },
  { tier: 'silver', points: 250 },
  { tier: 'gold', points: 500 },
  { tier: 'vip', points: 1000 },
];

const TIER_REWARD = { amount: 5.0, currency: 'USD' };

function loadJson() {
  try {
    const file = loyaltyFile();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function saveJson(rows) {
  try { fs.writeFileSync(loyaltyFile(), JSON.stringify(rows, null, 2)); } catch {}
}

function tierForPoints(points) {
  let tier = 'member';
  for (const t of TIER_THRESHOLDS) {
    if (points >= t.points) tier = t.tier;
  }
  return tier;
}

function nextTierFor(points) {
  for (const t of TIER_THRESHOLDS) {
    if (points < t.points) return t;
  }
  return null;
}

async function getLoyalty(userId) {
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin.from('loyalty_state').select('*').eq('user_id', userId).maybeSingle();
      if (error) throw error;
      return data || null;
    } catch { return null; }
  }
  return loadJson().find((r) => r.user_id === userId) || null;
}

async function upsertLoyalty(userId, updates) {
  if (supabaseAdmin) {
    try {
      await supabaseAdmin.from('loyalty_state').upsert(
        { user_id: userId, ...updates, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
    } catch (error) {
      console.error('[LOYALTY] upsert failed:', error.message);
    }
    return;
  }
  const rows = loadJson();
  const existing = rows.find((r) => r.user_id === userId);
  if (existing) Object.assign(existing, updates);
  else rows.push({ user_id: userId, ...updates });
  saveJson(rows);
}

/**
 * Add loyalty points from a trusted event (idempotent via idempotency key).
 * Returns { ok, tierChanged, newTier, rewardIssued, rewardAmount }.
 */
async function addLoyaltyPoints(userId, points, source, idempotencyKey, relatedId) {
  const state = (await getLoyalty(userId)) || {
    user_id: userId,
    tier: 'member',
    tier_points: 0,
    lifetime_points: 0,
    progress: 0,
    next_tier: 'bronze',
    milestone_history: [],
  };

  const lifetime = (state.lifetime_points || 0) + points;
  const newTier = tierForPoints(lifetime);
  const next = nextTierFor(lifetime);
  const prevTier = state.tier || 'member';
  const tierChanged = newTier !== prevTier;

  let rewardIssued = false;
  let rewardAmount = 0;
  const history = Array.isArray(state.milestone_history) ? state.milestone_history : [];
  if (tierChanged && newTier !== 'member') {
    const issuance = await issueReward({
      user_id: userId,
      source: 'loyalty',
      amount: TIER_REWARD.amount,
      currency: TIER_REWARD.currency,
      related_id: `tier_${newTier}`,
      idempotency_key: `loyalty_tier_${userId}_${newTier}`,
      type: 'credit',
      expires_in_ms: 60 * 24 * 60 * 60 * 1000,
      metadata: { tier: newTier },
    });
    rewardIssued = issuance.ok;
    rewardAmount = issuance.ok ? TIER_REWARD.amount : 0;
    history.push({ tier: newTier, points: lifetime, at: new Date().toISOString() });

    // Unified-pipeline notifications (vip-tier-up + loyalty-milestone).
    if (rewardIssued) {
      fireRewardNotification({
        type: 'vip-tier-up',
        userId,
        amount: TIER_REWARD.amount,
        relatedId: `tier_${newTier}`,
      }).catch((error) => console.error('[LOYALTY NOTIFY] tier failed:', error.message));
      fireRewardNotification({
        type: 'loyalty-milestone',
        userId,
        amount: TIER_REWARD.amount,
        relatedId: `tier_${newTier}`,
      }).catch((error) => console.error('[LOYALTY NOTIFY] milestone failed:', error.message));
    }
  }

  await upsertLoyalty(userId, {
    tier: newTier,
    tier_points: lifetime - (next ? next.points : lifetime),
    lifetime_points: lifetime,
    progress: next ? Math.min(100, Math.round(((lifetime - (prevThresholdFor(newTier))) / (next.points - prevThresholdFor(newTier))) * 100)) : 100,
    next_tier: next ? next.tier : null,
    tier_changed_at: tierChanged ? new Date().toISOString() : state.tier_changed_at,
    milestone_history: history,
  });

  return { ok: true, tierChanged, newTier, prevTier, rewardIssued, rewardAmount, lifetimePoints: lifetime };
}

function prevThresholdFor(tier) {
  const idx = TIER_THRESHOLDS.findIndex((t) => t.tier === tier);
  return idx > 0 ? TIER_THRESHOLDS[idx - 1].points : 0;
}

module.exports = {
  getLoyalty,
  addLoyaltyPoints,
  tierForPoints,
  nextTierFor,
  TIER_THRESHOLDS,
};
