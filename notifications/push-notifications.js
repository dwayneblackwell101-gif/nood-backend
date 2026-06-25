const express = require('express');
const axios = require('axios');

const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
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

function createNotificationsRouter({ pushTokens }) {
  const router = express.Router();

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

  router.post('/send', async (req, res) => {
    try {
      const title = safeString(req.body?.title);
      const body = safeString(req.body?.body);
      const data =
        req.body?.data && typeof req.body.data === 'object' && !Array.isArray(req.body.data)
          ? req.body.data
          : {};

      if (!title || !body) {
        return res.status(400).json({
          ok: false,
          message: 'title and body are required.',
        });
      }

      const savedTokens = pushTokens
        .values()
        .map((entry) => safeString(entry?.token))
        .filter((token) => isValidExpoPushToken(token));

      const uniqueTokens = Array.from(new Set(savedTokens));
      logNotifications('send started', { tokenCount: uniqueTokens.length });

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