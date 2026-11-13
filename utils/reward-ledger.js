/**
 * NOOD — Server-authoritative reward ledger + wallet.
 *
 * The authoritative balance is DERIVED from immutable ledger entries — never
 * from client state. Every credit/debit/reversal/expiry is an idempotent
 * ledger row keyed by idempotency_key (UNIQUE in DB) so replays are rejected.
 *
 * Tables:
 *   reward_ledger        — immutable reward/credit transactions
 *   wallet_transactions  — wallet debit/credit history (balance_after snapshot)
 *
 * Fraud controls:
 *   - idempotency_key UNIQUE → duplicate credit / replay rejected at DB level
 *   - negative balance guard   → debit rejected when balance insufficient
 *   - status transitions       → redeemed credits can't be re-redeemed
 *   - no client-issued credit  → only this module writes balances
 */

const { supabaseAdmin } = require('./supabase-admin');
const crypto = require('crypto');

// ═══ JSON fallback (for tests + unconfigured DB) ═══════════════════════
const fs = require('fs');
const path = require('path');
const walletLocks = new Map();

function ledgerFile() {
  return process.env.PUSH_LEDGER_FILE || path.join(__dirname, '..', 'reward-ledger-state.json');
}
function walletFile() {
  return process.env.PUSH_WALLET_FILE || path.join(__dirname, '..', 'wallet-state.json');
}

function loadJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveJsonFile(file, rows) {
  try {
    fs.writeFileSync(file, JSON.stringify(rows.slice(-5000), null, 2));
  } catch {
    // non-fatal
  }
}

function nowIso() {
  return new Date().toISOString();
}

function rewardExpirationEnabled() {
  return String(process.env.REWARD_EXPIRATION_ENABLED || '').trim().toLowerCase() === 'true';
}

/** Generate a deterministic idempotency key. */
function makeIdempotencyKey(source, userId, seed) {
  const safe = String(seed || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const hash = crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 12);
  return `noo_${source}_${userId}_${safe}_${hash}`;
}

function makeTxnId() {
  return `txn_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

// ─── Reward ledger ──────────────────────────────────────────────────────

/**
 * Issue a reward/credit ledger entry (idempotent).
 *
 * @param {object} opts
 *   user_id, source, amount (positive), currency, points,
 *   related_id, idempotency_key, expires_in_ms, metadata, type
 * @returns {Promise<{ ok, transactionId, existing, error? }>}
 */
async function issueReward(opts) {
  const userId = String(opts.user_id || '').trim();
  const amount = Number(opts.amount);
  if (!userId || !Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: 'invalid_issuance' };
  }

  const idempotencyKey = opts.idempotency_key || makeIdempotencyKey(opts.source, userId, opts.related_id || opts.seed || Date.now());

  // Check existing (replay guard) BEFORE insert.
  const existing = await findByIdempotency(idempotencyKey);
  if (existing) {
    return { ok: false, existing: true, transactionId: existing.transaction_id, replay: true };
  }

  const entry = {
    transaction_id: makeTxnId(),
    user_id: userId,
    type: opts.type || 'credit',
    source: opts.source || 'admin',
    amount,
    currency: opts.currency || 'USD',
    points: Number(opts.points || 0),
    status: 'issued',
    issued_at: nowIso(),
    // Wallet credits and reward expiry must be accounted for atomically as
    // spendable lots. Until that migration is enabled, issued wallet money is
    // non-expiring so the app never removes unrelated top-up funds.
    expires_at: rewardExpirationEnabled() && opts.expires_in_ms
      ? new Date(Date.now() + opts.expires_in_ms).toISOString()
      : null,
    related_id: opts.related_id || null,
    idempotency_key: idempotencyKey,
    metadata: opts.metadata || {},
  };

  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin.rpc('issue_reward_atomic', {
        p_user_id: userId,
        p_source: entry.source,
        p_amount: amount,
        p_currency: entry.currency,
        p_points: entry.points,
        p_related_id: entry.related_id,
        p_idempotency_key: idempotencyKey,
        p_expires_at: entry.expires_at,
        p_metadata: entry.metadata,
        p_max_prize: Number(process.env.REWARD_MAX_PRIZE_USD || 25),
        p_user_daily_limit: Number(process.env.REWARD_USER_DAILY_LIMIT_USD || 50),
        p_user_monthly_limit: Number(process.env.REWARD_USER_MONTHLY_LIMIT_USD || 250),
        p_global_daily_budget: Number(process.env.REWARD_GLOBAL_DAILY_BUDGET_USD || 1000),
      });
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('[LEDGER] issue failed:', error.message);
      return { ok: false, error: error.message };
    }
  }

  // JSON fallback.
  const rows = loadJsonFile(ledgerFile());
  if (rows.some((r) => r.idempotency_key === idempotencyKey)) {
    return { ok: false, existing: true, replay: true };
  }
  rows.push(entry);
  saveJsonFile(ledgerFile(), rows);
  const walletCredit = await applyWalletTxn({
    user_id: userId,
    amount,
    currency: entry.currency,
    type: 'credit',
    source: `reward_${entry.source}`,
    reference: entry.transaction_id,
    idempotency_key: `reward-wallet:${idempotencyKey}`,
    metadata: { rewardTransactionId: entry.transaction_id },
  });
  if (!walletCredit.ok && !walletCredit.replay) {
    saveJsonFile(ledgerFile(), rows.filter((row) => row.transaction_id !== entry.transaction_id));
    return { ok: false, error: 'wallet_credit_failed' };
  }
  return { ok: true, transactionId: entry.transaction_id, walletTxnId: walletCredit.txnId, balance: walletCredit.balance };
}

async function findByIdempotency(idempotencyKey) {
  if (!idempotencyKey) return null;
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('reward_ledger')
        .select('*')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    } catch {
      return null;
    }
  }
  return loadJsonFile(ledgerFile()).find((r) => r.idempotency_key === idempotencyKey) || null;
}

/**
 * Mark a reward entry as redeemed (idempotent — already-redeemed returns false).
 */
async function redeemReward(transactionId, user_id) {
  if (supabaseAdmin) {
    try {
      const { data: entry, error } = await supabaseAdmin
        .from('reward_ledger')
        .select('*')
        .eq('transaction_id', transactionId)
        .maybeSingle();
      if (error) throw error;
      if (!entry) return { ok: false, reason: 'not_found' };
      if (entry.user_id !== user_id) return { ok: false, reason: 'not_owner' };
      if (entry.status === 'redeemed') return { ok: false, reason: 'already_redeemed', replay: true };
      if (entry.status === 'expired') return { ok: false, reason: 'expired' };
      if (entry.expires_at && new Date(entry.expires_at).getTime() < Date.now()) {
        return { ok: false, reason: 'expired' };
      }
      const { error: updErr } = await supabaseAdmin
        .from('reward_ledger')
        .update({ status: 'redeemed', redeemed_at: nowIso() })
        .eq('transaction_id', transactionId)
        .eq('status', 'issued'); // optimistic lock
      if (updErr) throw updErr;
      return { ok: true };
    } catch (error) {
      console.error('[LEDGER] redeem failed:', error.message);
      return { ok: false, reason: 'db_error' };
    }
  }
  // JSON fallback.
  const rows = loadJsonFile(ledgerFile());
  const entry = rows.find((r) => r.transaction_id === transactionId);
  if (!entry) return { ok: false, reason: 'not_found' };
  if (entry.user_id !== user_id) return { ok: false, reason: 'not_owner' };
  if (entry.status === 'redeemed') return { ok: false, reason: 'already_redeemed', replay: true };
  entry.status = 'redeemed';
  entry.redeemed_at = nowIso();
  saveJsonFile(ledgerFile(), rows);
  return { ok: true };
}

/**
 * Compute the authoritative available balance for a user.
 * Balance = sum(non-expired, non-reversed credits) − sum(redeemed credits).
 * Never trusts client state.
 */
async function getRewardBalance(userId) {
  const entries = await listLedgerForUser(userId);
  let balance = 0;
  for (const e of entries) {
    if (e.status === 'reversed') continue;
    if (e.status === 'expired') continue;
    if (e.expires_at && new Date(e.expires_at).getTime() < Date.now()) continue;
    if (e.status === 'redeemed') continue;
    if (e.type === 'debit' || e.type === 'expire') {
      balance -= Math.abs(Number(e.amount));
    } else {
      balance += Number(e.amount);
    }
  }
  return Math.max(0, balance);
}

async function listLedgerForUser(userId) {
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('reward_ledger')
        .select('*')
        .eq('user_id', userId)
        .order('issued_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('[LEDGER] list failed:', error.message);
      return [];
    }
  }
  return loadJsonFile(ledgerFile()).filter((r) => r.user_id === userId);
}

// ─── Wallet ─────────────────────────────────────────────────────────────

/**
 * Apply a wallet transaction (credit/debit) idempotently with a negative
 * balance guard. Returns the balance AFTER the operation.
 */
async function applyWalletTxn(opts) {
  const userId = String(opts.user_id || '').trim();
  const amount = Number(opts.amount);
  if (!userId || !Number.isFinite(amount)) {
    return { ok: false, error: 'invalid_txn' };
  }

  const idempotencyKey = opts.idempotency_key || makeIdempotencyKey(`wallet_${opts.source}`, userId, opts.reference || Date.now());

  if (!supabaseAdmin && !opts.__lockHeld) {
    const previous = walletLocks.get(userId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    walletLocks.set(userId, queued);
    await previous;
    try {
      return await applyWalletTxn({ ...opts, idempotency_key: idempotencyKey, __lockHeld: true });
    } finally {
      release();
      if (walletLocks.get(userId) === queued) walletLocks.delete(userId);
    }
  }

  // Production uses one database transaction with an advisory lock. This is
  // the only safe way to prevent two simultaneous purchases overspending the
  // same balance.
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin.rpc('apply_wallet_transaction_atomic', {
        p_user_id: userId,
        p_amount: amount,
        p_currency: opts.currency || 'USD',
        p_type: opts.type || (amount >= 0 ? 'credit' : 'debit'),
        p_source: opts.source || 'admin',
        p_reference: opts.reference || null,
        p_idempotency_key: idempotencyKey,
        p_metadata: opts.metadata || {},
        p_reverses_transaction_id: opts.reverses_transaction_id || null,
      });
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('[WALLET] atomic txn failed:', error.message);
      return { ok: false, error: 'wallet_atomic_transaction_failed' };
    }
  }

  // JSON fallback is for local development/tests only.
  // Replay guard.
  const existing = await findWalletTxn(idempotencyKey);
  if (existing) {
    return { ok: false, replay: true, balance: existing.balance_after, txnId: existing.txn_id };
  }

  const balance = await getWalletBalance(userId);

  // Negative balance guard: a debit must not push balance below 0.
  if (amount < 0 && balance + amount < 0) {
    return { ok: false, error: 'insufficient_balance', balance };
  }

  const txn = {
    txn_id: makeTxnId(),
    user_id: userId,
    type: opts.type || (amount >= 0 ? 'credit' : 'debit'),
    source: opts.source || 'admin',
    amount,
    currency: opts.currency || 'USD',
    balance_after: balance + amount,
    reference: opts.reference || null,
    idempotency_key: idempotencyKey,
    created_at: nowIso(),
    metadata: opts.metadata || {},
  };

  const rows = loadJsonFile(walletFile());
  if (rows.some((r) => r.idempotency_key === idempotencyKey)) {
    return { ok: false, replay: true, balance };
  }
  rows.push(txn);
  saveJsonFile(walletFile(), rows);
  return { ok: true, balance: txn.balance_after, txnId: txn.txn_id };
}

async function findWalletTxn(idempotencyKey) {
  if (!idempotencyKey) return null;
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('wallet_transactions')
        .select('*')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    } catch {
      return null;
    }
  }
  return loadJsonFile(walletFile()).find((r) => r.idempotency_key === idempotencyKey) || null;
}

/** Wallet balance = sum of immutable signed transactions, including reversals. */
async function getWalletBalance(userId) {
  const txns = await listWalletTxns(userId);
  let balance = 0;
  for (const t of txns) {
    balance += Number(t.amount);
  }
  return Math.max(0, balance);
}

async function listWalletTxns(userId) {
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('wallet_transactions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('[WALLET] list failed:', error.message);
      return [];
    }
  }
  return loadJsonFile(walletFile()).filter((r) => r.user_id === userId);
}

/** Expire all issued rewards that have passed their expires_at. */
async function expireOverdueRewards(userId) {
  if (!rewardExpirationEnabled()) return { expired: 0, disabled: true };
  const entries = await listLedgerForUser(userId);
  let expired = 0;
  for (const e of entries) {
    if (e.status !== 'issued') continue;
    if (!e.expires_at) continue;
    if (new Date(e.expires_at).getTime() < Date.now()) {
      if (supabaseAdmin) {
        await supabaseAdmin
          .from('reward_ledger')
          .update({ status: 'expired' })
          .eq('transaction_id', e.transaction_id)
          .eq('status', 'issued');
      } else {
        const rows = loadJsonFile(ledgerFile());
        const row = rows.find((r) => r.transaction_id === e.transaction_id);
        if (row) { row.status = 'expired'; saveJsonFile(ledgerFile(), rows); }
      }
      expired += 1;
    }
  }
  return { expired };
}

// ─── Expiring rewards (for notifications) ───────────────────────────────

/** Find rewards expiring within `withinMs` that have not been notified yet. */
async function findExpiringRewards(userId, withinMs = 24 * 60 * 60 * 1000) {
  if (!rewardExpirationEnabled()) return [];
  const entries = await listLedgerForUser(userId);
  const now = Date.now();
  return entries.filter((e) => {
    if (e.status !== 'issued') return false;
    if (!e.expires_at) return false;
    const exp = new Date(e.expires_at).getTime();
    if (exp <= now) return false;
    return exp - now <= withinMs;
  });
}

module.exports = {
  issueReward,
  redeemReward,
  getRewardBalance,
  listLedgerForUser,
  applyWalletTxn,
  getWalletBalance,
  listWalletTxns,
  expireOverdueRewards,
  findExpiringRewards,
  makeIdempotencyKey,
  makeTxnId,
};
