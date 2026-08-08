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

const TOKENS_FILE = path.join(__dirname, '..', 'push-tokens.json');
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return {};
    const raw = fs.readFileSync(TOKENS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } catch (error) {
    console.error('[PUSH] failed to save tokens:', error.message);
  }
}

function safeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

/** Register (or upsert) a device push token. */
router.post('/api/notifications/register-token', (req, res) => {
  const token = safeString(req.body?.token);
  if (!token) {
    return res.status(400).json({ success: false, message: 'token is required' });
  }

  const tokens = loadTokens();
  tokens[token] = {
    token,
    platform: safeString(req.body?.platform, 'android'),
    deviceId: safeString(req.body?.deviceId),
    userId: safeString(req.body?.userId),
    appVersion: safeString(req.body?.appVersion),
    createdAt: req.body?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveTokens(tokens);

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

module.exports = { router };
