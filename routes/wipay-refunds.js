const express = require('express');
const { supabaseAdmin: db } = require('../utils/supabase-admin');
const { verifyWebhook } = require('../services/wipay-refund-api');
const { acceptRefundEvent } = require('../services/wipay-refunds');
const router = express.Router();

router.post('/webhooks/wipay/refunds/:environment', async (req, res) => {
  const environment = req.params.environment;
  if (!['live', 'sandbox'].includes(environment)) return res.sendStatus(404);
  const secret = process.env[environment === 'live' ? 'WIPAY_WEBHOOK_SECRET' : 'WIPAY_SANDBOX_WEBHOOK_SECRET'];
  if (!secret) return res.status(503).json({ success: false, message: 'WiPay refund notifications not configured' });
  if (!verifyWebhook(req, secret)) return res.sendStatus(401);
  const event = req.body;
  if (!event || typeof event.id !== 'string' || event.id.length > 100 || !event.id ||
      event.id !== req.get('X-WiPay-Webhook-Id') || event.event !== req.get('X-WiPay-Webhook-Event') ||
      !Number.isFinite(Date.parse(event.occurred_at))) return res.sendStatus(400);
  if (event.event === 'webhook.test') return res.sendStatus(200);
  if (event.api_family !== 'payments_api') return res.sendStatus(400);
  if (!['payment.refund_requested', 'payment.refunded', 'payment.refund_rejected'].includes(event.event)) return res.sendStatus(200);
  if (typeof event.data?.transaction_id !== 'string' || event.data.transaction_id.length > 150) return res.sendStatus(400);
  if (!db) return res.sendStatus(503);
  try {
    const row = { event_id: event.id, environment, event: event.event,
      transaction_id: event.data.transaction_id, occurred_at: event.occurred_at };
    const inserted = await db.from('wipay_webhook_events').insert(row);
    if (inserted.error && inserted.error.code !== '23505') throw inserted.error;
    const stored = await db.from('wipay_webhook_events').select('*').eq('event_id', event.id).single();
    if (stored.error) throw stored.error;
    if (stored.data.environment !== environment || stored.data.transaction_id !== row.transaction_id || stored.data.event !== row.event) return res.sendStatus(409);
    if (stored.data.processed_at) return res.sendStatus(200);
    const result = await acceptRefundEvent(event, environment);
    if (result?.processing) return res.sendStatus(503); // Retry until Shopify sync has finished.
    const saved = await db.from('wipay_webhook_events').update({ processed_at: new Date().toISOString() }).eq('event_id', event.id);
    if (saved.error) throw saved.error;
    return res.sendStatus(200);
  } catch (error) {
    console.warn('[WiPay refund webhook] processing failed');
    return res.sendStatus(503);
  }
});
module.exports = { router };
