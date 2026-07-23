const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 500;
const MAX_DATA_KEYS = 20;
const MAX_DATA_VALUE_LENGTH = 500;
const VALID_AUDIENCES = new Set(['all']);
const INVALID_TOKEN_ERRORS = new Set([
  'DeviceNotRegistered',
  'InvalidCredentials',
  'MismatchSenderId',
  'InvalidRecipient',
]);

function logNotifications(message, detail) {
  if (detail !== undefined) {
    console.log(`[NOTIFICATIONS] ${message}`, detail);
    return;
  }
  console.log(`[NOTIFICATIONS] ${message}`);
}

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isValidExpoPushToken(token) {
  const trimmed = safeString(token);
  return /^ExponentPushToken\[/.test(trimmed) || /^ExpoPushToken\[/.test(trimmed);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function rejectMissingAdminAuth(_req, res) {
  return res.status(503).json({
    ok: false,
    message: 'Admin notification auth is not configured.',
  });
}

function sanitizeNotificationData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {};
  }

  const safeData = {};
  for (const [key, value] of Object.entries(data).slice(0, MAX_DATA_KEYS)) {
    const safeKey = safeString(key).replace(/[^\w.-]/g, '').slice(0, 64);
    if (!safeKey) continue;

    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      safeData[safeKey] = String(value).slice(0, MAX_DATA_VALUE_LENGTH);
    }
  }

  return safeData;
}

function validateSendRequest(body = {}) {
  const title = safeString(body.title).slice(0, MAX_TITLE_LENGTH);
  const messageBody = safeString(body.body).slice(0, MAX_BODY_LENGTH);
  const audience = safeString(body.audience || 'all').toLowerCase();
  const errors = [];

  if (!title) errors.push('title is required.');
  if (!messageBody) errors.push('body is required.');
  if (safeString(body.title).length > MAX_TITLE_LENGTH) {
    errors.push(`title must be ${MAX_TITLE_LENGTH} characters or less.`);
  }
  if (safeString(body.body).length > MAX_BODY_LENGTH) {
    errors.push(`body must be ${MAX_BODY_LENGTH} characters or less.`);
  }
  if (!VALID_AUDIENCES.has(audience)) {
    errors.push('audience must be "all".');
  }

  return {
    errors,
    value: {
      title,
      body: messageBody,
      audience,
      data: sanitizeNotificationData(body.data),
    },
  };
}

function createNotificationsRouter({ pushTokens, requireAdminApiKey = rejectMissingAdminAuth }) {
  const router = express.Router();
  const sendLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.NOTIFICATION_SEND_RATE_LIMIT || 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      message: 'Too many notification send attempts. Please try again shortly.',
    },
  });

  router.get('/health', (req, res) => {
    res.json({ ok: true, service: 'notifications' });
  });

  router.post('/register-token', async (req, res) => {
    try {
      const token = safeString(req.body?.token);
      if (!isValidExpoPushToken(token)) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid Expo push token format.',
        });
      }

      const now = new Date().toISOString();
      const existing = pushTokens.get(token);
      const record = {
        token,
        platform: safeString(req.body?.platform) || null,
        deviceId: safeString(req.body?.deviceId) || null,
        userId: safeString(req.body?.userId) || null,
        appVersion: safeString(req.body?.appVersion) || null,
        createdAt: existing?.createdAt || safeString(req.body?.createdAt) || now,
        updatedAt: now,
      };

      pushTokens.set(token, record);
      logNotifications('token registered', {
        tokenSuffix: token.slice(-12),
        platform: record.platform,
        userId: record.userId || null,
      });

      return res.json({ ok: true });
    } catch (error) {
      logNotifications('send error', {
        context: 'register-token',
        message: error?.message || String(error),
      });
      return res.status(500).json({
        ok: false,
        message: 'Failed to register push token.',
      });
    }
  });

  async function sendPushMessages(messages) {
    const response = await axios.post(EXPO_PUSH_SEND_URL, messages, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 20000,
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      throw new Error(
        `Expo push API failed with ${response.status}: ${JSON.stringify(response.data || {})}`
      );
    }

    return response.data;
  }

  router.post('/send', sendLimiter, requireAdminApiKey, async (req, res) => {
    try {
      const validation = validateSendRequest(req.body);

      if (validation.errors.length) {
        return res.status(400).json({
          ok: false,
          message: validation.errors[0],
          validationErrors: validation.errors,
        });
      }

      const { title, body, data, audience } = validation.value;
      const savedTokens = pushTokens
        .values()
        .map((entry) => safeString(entry?.token))
        .filter((token) => isValidExpoPushToken(token));

      const uniqueTokens = Array.from(new Set(savedTokens));
      logNotifications('send started', { audience, tokenCount: uniqueTokens.length });

      if (!uniqueTokens.length) {
        return res.json({
          ok: true,
          sent: 0,
          message: 'No push tokens registered',
        });
      }

      const messageChunks = chunkArray(uniqueTokens, 100);
      const tickets = [];
      const removedTokens = [];

      for (const tokenChunk of messageChunks) {
        const payload = tokenChunk.map((to) => ({
          to,
          sound: 'default',
          title,
          body,
          data,
        }));

        let result;
        try {
          result = await sendPushMessages(payload);
        } catch (error) {
          logNotifications('send error', {
            context: 'expo-push-api',
            message: error?.message || String(error),
          });
          continue;
        }

        const chunkTickets = Array.isArray(result?.data) ? result.data : [];
        chunkTickets.forEach((ticket, index) => {
          const token = tokenChunk[index];
          tickets.push({ token, ticket });
          logNotifications('send ticket result', {
            tokenSuffix: token ? token.slice(-12) : null,
            status: ticket?.status || 'unknown',
            message: ticket?.message || null,
            details: ticket?.details || null,
          });

          const errorCode = safeString(ticket?.details?.error);
          if (ticket?.status === 'error' && INVALID_TOKEN_ERRORS.has(errorCode) && token) {
            if (pushTokens.delete(token)) {
              removedTokens.push(token);
              logNotifications('invalid token removed', {
                tokenSuffix: token.slice(-12),
                error: errorCode,
              });
            }
          }
        });
      }

      const sentCount = tickets.filter((entry) => entry.ticket?.status === 'ok').length;

      return res.json({
        ok: true,
        sent: sentCount,
        attempted: uniqueTokens.length,
        removedInvalidTokens: removedTokens.length,
        tickets,
      });
    } catch (error) {
      logNotifications('send error', {
        context: 'send-notification',
        message: error?.message || String(error),
      });
      return res.status(500).json({
        ok: false,
        message: 'Failed to send notifications.',
      });
    }
  });

  return router;
}

module.exports = createNotificationsRouter;
module.exports.isValidExpoPushToken = isValidExpoPushToken;
module.exports.sanitizeNotificationData = sanitizeNotificationData;
module.exports.validateSendRequest = validateSendRequest;
