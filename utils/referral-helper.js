/**
 * Referral store helper — durable JSON persistence (Supabase migration of
 * referral-store.json is supported; JSON remains the working store until the
 * referral_records table is populated).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { supabaseAdmin } = require('./supabase-admin');

function storeFile() {
  return process.env.REFERRAL_STORE_FILE || path.join(__dirname, '..', 'referral-store.json');
}

function loadReferralStore() {
  try {
    if (!fs.existsSync(storeFile())) return { byCode: new Map(), byOwner: new Map() };
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    const byCode = new Map(Object.entries(raw.byCode || {}));
    const byOwner = new Map();
    for (const entry of byCode.values()) {
      if (entry.ownerCustomerId) byOwner.set(entry.ownerCustomerId, entry);
    }
    return { byCode, byOwner };
  } catch {
    return { byCode: new Map(), byOwner: new Map() };
  }
}

function persistReferralStore(store) {
  try {
    const raw = { byCode: Object.fromEntries(store.byCode), byOwner: Object.fromEntries(store.byOwner) };
    fs.writeFileSync(storeFile(), JSON.stringify(raw, null, 2));
  } catch {}
}

function getOrCreateReferralCode(customerId) {
  const store = loadReferralStore();
  let entry = store.byOwner.get(customerId);
  if (!entry) {
    const suffix = String(customerId).replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase().padStart(6, '0');
    const code = `NOOD-${suffix}`;
    entry = { code, ownerCustomerId: customerId, invites: [], createdAt: Date.now() };
    store.byCode.set(code, entry);
    store.byOwner.set(customerId, entry);
    persistReferralStore(store);
  }
  return entry;
}

function getReferralEntry(customerId) {
  const store = loadReferralStore();
  return store.byOwner.get(customerId) || null;
}

function referralCodeFor(customerId) {
  return `NOOD-${crypto.createHash('sha256').update(String(customerId)).digest('hex').slice(0, 8).toUpperCase()}`;
}

async function getOrCreateReferralCodePersistent(customerId) {
  if (!supabaseAdmin) return getOrCreateReferralCode(customerId);
  const { data: existing, error: readError } = await supabaseAdmin.from('referral_codes').select('*').eq('owner_user_id', customerId).maybeSingle();
  if (readError) throw readError;
  let row = existing;
  if (!row) {
    const { data, error } = await supabaseAdmin.from('referral_codes').upsert({
      owner_user_id: customerId, code: referralCodeFor(customerId),
    }, { onConflict: 'owner_user_id' }).select().single();
    if (error) throw error;
    row = data;
  }
  const { data: records, error } = await supabaseAdmin.from('referral_records').select('*').eq('owner_user_id', customerId).order('created_at');
  if (error) throw error;
  return {
    code: row.code,
    ownerCustomerId: customerId,
    createdAt: new Date(row.created_at).getTime(),
    invites: (records || []).map((record) => ({
      referredCustomerId: record.referred_user_id,
      createdAt: new Date(record.created_at).getTime(),
      rewarded: record.status === 'rewarded',
    })),
  };
}

async function attributeReferralPersistent(referralCode, referredCustomerId, referredEmail = '') {
  if (!supabaseAdmin) {
    const store = loadReferralStore();
    const entry = store.byCode.get(referralCode);
    if (!entry) return { ok: false, error: 'invalid_code' };
    if (entry.ownerCustomerId === referredCustomerId) return { ok: false, error: 'self_referral' };
    const invites = entry.invites || [];
    const isNew = !invites.some((invite) => invite.referredCustomerId === referredCustomerId);
    if (isNew) invites.push({ referredCustomerId, createdAt: Date.now(), rewarded: false });
    entry.invites = invites;
    store.byCode.set(referralCode, entry);
    store.byOwner.set(entry.ownerCustomerId, entry);
    persistReferralStore(store);
    return { ok: true, entry, isNew, invitedCount: invites.length };
  }
  const { data: codeRow, error: codeError } = await supabaseAdmin.from('referral_codes').select('*').eq('code', referralCode).maybeSingle();
  if (codeError) throw codeError;
  if (!codeRow) return { ok: false, error: 'invalid_code' };
  if (codeRow.owner_user_id === referredCustomerId) return { ok: false, error: 'self_referral' };
  const idempotencyKey = `referral:${codeRow.owner_user_id}:${referredCustomerId}`;
  const { data, error } = await supabaseAdmin.from('referral_records').upsert({
    referral_code: referralCode, owner_user_id: codeRow.owner_user_id, referred_user_id: referredCustomerId,
    referred_email: referredEmail || null, status: 'joined', idempotency_key: idempotencyKey,
  }, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select();
  if (error) throw error;
  const { count } = await supabaseAdmin.from('referral_records').select('*', { count: 'exact', head: true }).eq('owner_user_id', codeRow.owner_user_id);
  return { ok: true, entry: { ownerCustomerId: codeRow.owner_user_id, code: referralCode }, isNew: Boolean(data?.length), invitedCount: count || 0 };
}

async function markReferralRewardedPersistent(ownerUserId, limit = 5) {
  if (!supabaseAdmin) {
    const store = loadReferralStore();
    const entry = store.byOwner.get(ownerUserId);
    if (!entry) return 0;
    let marked = 0;
    for (const invite of entry.invites || []) {
      if (marked >= limit) break;
      if (!invite.rewarded) { invite.rewarded = true; marked += 1; }
    }
    store.byOwner.set(ownerUserId, entry);
    store.byCode.set(entry.code, entry);
    persistReferralStore(store);
    return marked;
  }
  const { data, error } = await supabaseAdmin.from('referral_records').select('id').eq('owner_user_id', ownerUserId).neq('status', 'rewarded').order('created_at').limit(limit);
  if (error) throw error;
  if (!data?.length) return 0;
  const { error: updateError } = await supabaseAdmin.from('referral_records').update({ status: 'rewarded', rewarded_at: new Date().toISOString(), updated_at: new Date().toISOString() }).in('id', data.map((row) => row.id));
  if (updateError) throw updateError;
  return data.length;
}

module.exports = { loadReferralStore, persistReferralStore, getOrCreateReferralCode, getReferralEntry,
  getOrCreateReferralCodePersistent, attributeReferralPersistent, markReferralRewardedPersistent };
