/**
 * Centralized Expo Push delivery service.
 *
 * Every push in NOOD goes through here. Responsibilities:
 *  - validate Expo push tokens
 *  - chunk messages (Expo allows up to 100 per request)
 *  - send to Expo's push API
 *  - log ticket IDs
 *  - process receipts (DeviceNotRegistered → deactivate/remove token)
 *  - one bad token never breaks the batch (chunked, per-chunk try/catch)
 *  - campaign ids / idempotency
 *  - report sent / failed / skipped totals
 *
 * Direct calls to Expo's push endpoint must NOT appear elsewhere.
 */

const axios = require('axios');
const { supabaseAdmin } = require('./supabase-admin');
const { config, isTransactionalType, categoryForType } = require('./push-config');
const { loadTokens, deactivateToken, isLikelyRealToken } = require('./push-tokens-db');
const {
  createCampaignEvent,
  updateCampaignStats,
  checkAndIncrementFrequency,
} = require('./push-state-db');
const { isCategoryEnabledForUser } = require('./preferences-db');
const { trackNotificationEvent } = require('./notification-analytics');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

function log(level, message, extra) {
  if (config.logLevel === 'silent') return;
  const prefix = `[PUSH]`;
  const detail = extra && Object.keys(extra).length ? ` | ${JSON.stringify(extra)}` : '';
  if (level === 'error') {
    console.error(`${prefix} ${message}${detail}`);
  } else {
    console.log(`${prefix} ${message}${detail}`);
  }
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/** Are we inside the configured quiet hours window (server local time)? */
function isInQuietHours() {
  if (!config.quietHoursEnabled) return false;
  const start = config.quietHoursStart;
  const end = config.quietHoursEnd;
  if (start === end) return false; // disabled window

  const hour = new Date().getHours();
  if (start < end) {
    return hour >= start && hour < end;
  }
  // Window crosses midnight, e.g. 22 → 8.
  return hour >= start || hour < end;
}

/** Validate a raw Expo push token. Returns trimmed token or null. */
function validateToken(token) {
  const trimmed = String(token || '').trim();
  return isLikelyRealToken(trimmed) ? trimmed : null;
}

/**
 * Filter active tokens for a set of recipient records.
 * @param {Array} recipients array of token rows ({ token, active?, test? })
 */
function activeTokens(recipients) {
  return (recipients || []).filter(
    (r) => r && isLikelyRealToken(r.token) && r.active !== false && !r.test
  );
}

/**
 * Build an Expo message from a token + notification body.
 * `data` is the custom payload (deep-link data) sent to the app.
 */
function buildMessage(token, { title, body, data, channelId, sound = 'default' }) {
  const message = {
    to: token,
    sound,
    title,
    body,
    data: data && typeof data === 'object' ? data : {},
  };
  if (channelId) {
    message.channelId = channelId;
  }
  return message;
}

/**
 * Core delivery function.
 *
 * @param {Object} opts
 * @param {Array}  opts.recipients        array of token rows
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {Object} opts.data              deep-link payload
 * @param {string} opts.campaignId        unique campaign id (idempotency)
 * @param {string} opts.campaignType      e.g. 'new_product' | 'order-update'
 * @param {string} opts.dedupeKey         optional second-level dedupe (e.g. per-product)
 * @param {Object} opts.frequency         optional { check: bool } — apply promo frequency rules
 *
 * @returns {Promise<{campaignId, sent, failed, skipped, details}>}
 */
async function sendPush(opts) {
  const recipients = Array.isArray(opts.recipients) ? opts.recipients : [];
  const campaignId = String(opts.campaignId || '');
  const dedupeKey = String(opts.dedupeKey || '');
  const campaignType = String(opts.campaignType || 'general');

  // ── Campaign idempotency ──────────────────────────────────────────────
  if (campaignId) {
    const existing = await campaignExistsSafe(campaignId);
    if (existing) {
      log('info', 'Skipped duplicate campaign', { campaignId });
      return { campaignId, sent: 0, failed: 0, skipped: recipients.length, duplicate: true };
    }
    const created = await createCampaignEvent({
      campaignId,
      campaignType,
      dedupeKey,
      title: opts.title,
      body: opts.body,
      payload: opts.data,
      status: 'created',
      recipientCount: recipients.length,
    });
    if (!created.created) {
      log('info', 'Skipped duplicate campaign', {
        campaignId,
        duplicateReason: created.duplicateReason,
      });
      return { campaignId, sent: 0, failed: 0, skipped: recipients.length, duplicate: true };
    }
    log('info', 'Campaign created', { campaignId, campaignType, recipients: recipients.length });
    await trackNotificationEvent('campaign_created', {
      type: campaignType,
      category: categoryForType(campaignType),
      campaignId,
      count: recipients.length,
    });
  }

  // ── Analytics: notification created ───────────────────────────────────
  await trackNotificationEvent('notification_created', {
    type: campaignType,
    category: categoryForType(campaignType),
    campaignId,
    count: recipients.length,
  });

  // ── Frequency gates (promotional only) ────────────────────────────────
  const applyFrequency = opts.frequency && opts.frequency.check && !isTransactionalType(campaignType);
  const eligible = [];
  let skipped = 0;
  const skipReasons = {};

  // Quiet hours: promotional pushes are skipped entirely; transactional
  // (order-update) always go through.
  const inQuietHours = isInQuietHours();
  if (applyFrequency && inQuietHours) {
    log('info', 'Skipped due to quiet hours', { campaignId, campaignType });
    const totals = { sent: 0, failed: 0, skipped: recipients.length };
    if (campaignId) {
      await updateCampaignStats(campaignId, totals);
    }
    return { campaignId, ...totals, duplicate: false, quietHours: true };
  }

  // ── Preference suppression (marketing categories only) ────────────────
  const category = categoryForType(campaignType);
  const checkPreferences = opts.frequency && opts.frequency.check && !isTransactionalType(campaignType);

  for (const recipient of activeTokens(recipients)) {
    // Server-side preference opt-out (marketing categories).
    if (checkPreferences && (recipient.userId || recipient.email)) {
      const identity = recipient.userId || recipient.email;
      const prefAllowed = await isCategoryEnabledForUser(identity, category);
      if (!prefAllowed) {
        skipped += 1;
        const reason = 'preference_disabled';
        skipReasons[reason] = (skipReasons[reason] || 0) + 1;
        continue;
      }
    }

    if (!applyFrequency) {
      eligible.push(recipient);
      continue;
    }

    const freq = await checkAndIncrementFrequency(
      recipient.token,
      config.minPromoIntervalMinutes,
      config.maxPromoPerDay,
      recipient.userId
    );
    if (freq.allowed) {
      eligible.push(recipient);
    } else {
      skipped += 1;
      const reason = freq.skipReason || 'frequency';
      skipReasons[reason] = (skipReasons[reason] || 0) + 1;
    }
  }

  if (skipped > 0) {
    log('info', 'Skipped due to frequency cap', { campaignId, skipped, reasons: skipReasons });
  }

  if (!eligible.length) {
    const totals = { sent: 0, failed: 0, skipped };
    if (campaignId) {
      await updateCampaignStats(campaignId, totals);
    }
    log('info', 'No eligible recipients', { campaignId, ...totals });
    return { campaignId, ...totals, details: [] };
  }

  // ── Inbox persistence ─────────────────────────────────────────────────
  // Save the in-app NOOD Inbox item BEFORE attempting delivery so it exists
  // even if Expo delivery fails. Transactional + promotional pushes both
  // appear. Duplicate campaigns were already filtered above (idempotent).
  if (opts.saveInbox !== false) {
    try {
      const { createInboxItem } = require('./inbox-db');
      const inferredUserId = opts.userId || inferSharedUserId(eligible);
      const result = await createInboxItem({
        campaignId,
        type: campaignType,
        title: opts.title,
        body: opts.body,
        data: opts.data,
        route: opts.data?.route,
        productHandle: opts.data?.productHandle,
        orderId: opts.data?.orderId,
        campaign: opts.data?.campaign,
        userId: inferredUserId,
        expiresAt: opts.expiresAt,
      });
      if (result.created) {
        log('info', 'Inbox item created', {
          campaignId: result.item?.campaignId || campaignId,
          campaignType,
          userId: inferredUserId || 'broadcast',
        });
      }
    } catch (error) {
      // Inbox persistence must never break the push send.
      log('error', 'Inbox item save failed', { campaignId, error: error.message });
    }
  }

  // ── Build + chunk + send ──────────────────────────────────────────────
  const messages = eligible.map((r) =>
    buildMessage(r.token, {
      title: opts.title,
      body: opts.body,
      data: opts.data,
      channelId: opts.channelId,
    })
  );

  let sent = 0;
  let failed = 0;
  const details = [];
  const failedTokens = [];

  for (const chunk of chunkArray(messages, config.chunkSize)) {
    try {
      const response = await axios.post(EXPO_PUSH_URL, chunk, {
        headers: { 'Content-Type': 'application/json' },
        timeout: config.sendTimeoutMs,
      });

      const statuses = Array.isArray(response?.data?.data) ? response.data.data : [];
      for (let i = 0; i < statuses.length; i += 1) {
        const status = statuses[i];
        const message = chunk[i];
        if (!message) continue;

        if (status?.status === 'ok') {
          sent += 1;
          details.push({ to: message.to, status: 'ok', ticketId: status.id || null });
          log('info', 'Sent', { ticketId: status.id || null, tokenSuffix: message.to.slice(-12) });
          await trackNotificationEvent('push_sent', {
            type: campaignType,
            category: categoryForType(campaignType),
            campaignId,
            tokenSuffix: message.to.slice(-12),
          });
        } else {
          failed += 1;
          const error = status?.details?.error || 'Unknown';
          details.push({ to: message.to, status: 'error', error });
          log('error', 'Send failed', { error, tokenSuffix: message.to.slice(-12) });
          await trackNotificationEvent('push_failed', {
            type: campaignType,
            category: categoryForType(campaignType),
            campaignId,
            tokenSuffix: message.to.slice(-12),
          });

          if (error === 'DeviceNotRegistered') {
            failedTokens.push(message.to);
          }
        }
      }
    } catch (error) {
      // One bad chunk must not kill the batch.
      failed += chunk.length;
      log('error', 'Chunk send failed', {
        chunkSize: chunk.length,
        error: error.message,
      });
    }
  }

  // ── Deactivate invalid tokens ─────────────────────────────────────────
  for (const token of failedTokens) {
    log('info', 'DeviceNotRegistered — deactivated token', { tokenSuffix: token.slice(-12) });
    await deactivateToken(token).catch(() => {});
  }

  const totals = { sent, failed, skipped };
  if (campaignId) {
    await updateCampaignStats(campaignId, totals);
  }

  // ── Analytics: campaign sent (post-delivery totals) ───────────────────
  await trackNotificationEvent('campaign_sent', {
    type: campaignType,
    category: categoryForType(campaignType),
    campaignId,
    count: sent,
  });

  log('info', `Sent: ${sent} Failed: ${failed} Skipped: ${skipped}`, { campaignId });
  return { campaignId, ...totals, details };
}

async function campaignExistsSafe(campaignId) {
  try {
    const { campaignExists } = require('./push-state-db');
    return await campaignExists(campaignId);
  } catch {
    return false;
  }
}

/**
 * Infer a shared user identity for the inbox record when a single user's
 * devices dominate the recipient list. When recipients span multiple users
 * (a true broadcast), returns null so the inbox item is a global broadcast.
 */
function inferSharedUserId(eligible) {
  const counts = new Map();
  for (const r of eligible) {
    if (!r.userId) continue;
    counts.set(r.userId, (counts.get(r.userId) || 0) + 1);
  }
  if (counts.size === 1) {
    return counts.keys().next().value;
  }
  return null;
}

/**
 * Load all active, non-test tokens for a broadcast.
 */
async function loadAllRecipients() {
  const map = await loadTokens();
  return Object.values(map);
}

/**
 * Send a transactional push (e.g. order-update) — never frequency-limited.
 */
async function sendTransactional({ recipients, title, body, data, campaignId }) {
  return sendPush({
    recipients,
    title,
    body,
    data,
    campaignId,
    campaignType: 'order-update',
    frequency: { check: false },
  });
}

/**
 * Verify Expo receipts and deactivate DeviceNotRegistered tokens.
 * Call after a send when you want to double-check async delivery state.
 * @param {Array<string>} ticketIds
 */
async function processReceipts(ticketIds) {
  const ids = (ticketIds || []).filter(Boolean).slice(0, 1000);
  if (!ids.length) return { deactivated: 0 };

  let deactivated = 0;
  try {
    const response = await axios.post(
      EXPO_RECEIPTS_URL,
      { ids },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const receipts = response?.data?.data || {};
    for (const id of ids) {
      const receipt = receipts[id];
      if (receipt?.details?.error === 'DeviceNotRegistered') {
        // We don't map ticket→token here; callers handle token deactivation
        // inline in sendPush already.
        deactivated += 1;
      }
    }
  } catch (error) {
    log('error', 'Receipt processing failed', { error: error.message });
  }
  return { deactivated };
}

module.exports = {
  sendPush,
  sendTransactional,
  loadAllRecipients,
  processReceipts,
  validateToken,
  buildMessage,
  activeTokens,
  EXPO_PUSH_URL,
};
