/**
 * Push notifications API.
 *
 * - POST /api/notifications/register-token — app registers its Expo push token
 * - POST /api/notifications/send — send a push to all (or one) registered device(s)
 *   e.g. "🔥 HOT: New product drop"
 *
 * Tokens are stored in a JSON file (push-tokens.json) so this works without
 * Supabase. Uses Expo's push API to deliver.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const router = express.Router();

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const { loadTokens, upsertToken, removeToken, isLikelyRealToken } = require('../utils/push-tokens-db');

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

/** Register (or upsert) a device push token. */
router.post('/api/notifications/register-token', async (req, res) => {
  const token = safeString(req.body?.token);
  if (!token) {
    return res.status(400).json({ success: false, message: 'token is required' });
  }

  await upsertToken({
    token,
    platform: safeString(req.body?.platform, 'android'),
    deviceId: safeString(req.body?.deviceId),
    userId: safeString(req.body?.userId),
    appVersion: safeString(req.body?.appVersion),
    createdAt: req.body?.createdAt || new Date().toISOString(),
  });

  const tokens = await loadTokens();
  return res.json({ success: true, message: 'Token registered', tokenCount: Object.keys(tokens).length });
});

/**
 * Send a push notification.
 * Body: { title, body, data?, targetUserId?, token? }
 * - If `token` given → send to that one device.
 * - Else if `targetUserId` given → send to all devices of that user.
 * - Else → send to ALL registered devices (broadcast).
 */
router.post('/api/notifications/send', async (req, res) => {
  const title = safeString(req.body?.title, 'NOOD');
  const body = safeString(req.body?.body);
  const data = req.body?.data && typeof req.body?.data === 'object' ? req.body.data : {};
  const targetToken = safeString(req.body?.token);
  const targetUserId = safeString(req.body?.targetUserId);

  if (!body) {
    return res.status(400).json({ success: false, message: 'body is required' });
  }

  const tokens = loadTokens();
  let recipients = Object.values(tokens);

  if (targetToken) {
    recipients = recipients.filter((t) => t.token === targetToken);
  } else if (targetUserId) {
    recipients = recipients.filter((t) => t.userId === targetUserId);
  }

  // Never send to tokens explicitly flagged as test/fake.
  recipients = recipients.filter((t) => !t.test && isLikelyRealToken(t.token));

  if (!recipients.length) {
    return res.json({ success: false, message: 'No registered devices to notify', sent: 0 });
  }

  const messages = recipients.map((r) => ({
    to: r.token,
    sound: 'default',
    title,
    body,
    data,
  }));

  try {
    const response = await axios.post(EXPO_PUSH_URL, messages, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    const result = response?.data;
    const status = Array.isArray(result?.data) ? result.data : [];

    // Auto-remove invalid (DeviceNotRegistered) tokens so they don't accumulate.
    if (status.length) {
      let removed = 0;
      for (let i = 0; i < status.length; i += 1) {
        const err = status[i]?.details?.error;
        if (err === 'DeviceNotRegistered' && messages[i]?.to) {
          await removeToken(messages[i].to);
          removed += 1;
        }
      }
      if (removed) {
        console.log(`[PUSH] removed ${removed} invalid token(s)`);
      }
    }

    return res.json({
      success: true,
      sent: messages.length,
      details: status,
      message: `Notification sent to ${messages.length} device(s)`,
    });
  } catch (error) {
    console.error('[PUSH] send failed:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to send notification' });
  }
});

/**
 * Trigger a campaign now (for testing / manual sends).
 * POST /api/notifications/campaign { campaign: 'daily-reward' | 'flash-live' | 'cart-nudge' | 'broadcast', title?, body?, data?, targetUserId? }
 */
router.post('/api/notifications/campaign', async (req, res) => {
  const campaign = safeString(req.body?.campaign, 'broadcast');
  const title = safeString(req.body?.title);
  const body = safeString(req.body?.body);
  const data = req.body?.data && typeof req.body?.data === 'object' ? req.body.data : {};
  const targetUserId = safeString(req.body?.targetUserId);

  const templates = {
    'daily-reward': {
      title: title || 'Your daily reward is waiting 🎁',
      body: body || 'Claim your NOOD reward and keep your streak alive!',
      data: { ...data, type: 'daily-reward-reminder' },
    },
    'flash-live': {
      title: title || '⚡ Flash Sale LIVE',
      body: body || 'Up to 70% off — prices go back up when the timer hits zero!',
      data: { ...data, type: 'flash-sale', screen: 'modal' },
    },
    'hot-product': {
      title: title || '🔥 HOT DROP',
      body: body || 'A product you will love just landed. Shop it before it sells out!',
      data: { ...data, type: 'product_promo', screen: 'home' },
    },
    'price-drop': {
      title: title || '📉 Price Drop',
      body: body || 'An item on your wishlist just dropped in price!',
      data: { ...data, type: 'price_drop', screen: 'wishlist' },
    },
  };

  const template = templates[campaign] || {
    title: title || 'NOOD',
    body: body || 'Something great is waiting for you!',
    data: { ...data, type: 'general' },
  };

  const tokens = loadTokens();
  let recipients = Object.values(tokens);
  if (targetUserId) recipients = recipients.filter((t) => t.userId === targetUserId);

  if (!recipients.length) {
    return res.json({ success: false, message: 'No registered devices', sent: 0 });
  }

  const messages = recipients.map((r) => ({
    to: r.token,
    sound: 'default',
    title: template.title,
    body: template.body,
    data: template.data,
  }));

  try {
    const response = await axios.post(EXPO_PUSH_URL, messages, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    return res.json({
      success: true,
      sent: messages.length,
      campaign,
      details: response?.data?.data || [],
    });
  } catch (error) {
    console.error('[PUSH] campaign send failed:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to send campaign' });
  }
});

module.exports = { router };
