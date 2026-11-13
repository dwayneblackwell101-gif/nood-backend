const express = require('express');
const axios = require('axios');
const { rateLimit } = require('express-rate-limit');
const { khielKey, khielOpenAIReply } = require('../services/khiel-openai');

function practiceEnabled(env = process.env) {
  return Boolean(khielKey(env)) || (env.NODE_ENV === 'development' && env.NOOD_AI_FREE_CHAT_ENABLED === 'true' && env.GROQ_FREE_TIER_CONFIRMED === 'true');
}
function validMessages(messages) {
  return Array.isArray(messages) && messages.length > 0 && messages.length <= 9 &&
    messages.every((m, i) => m && typeof m === 'object' && !Array.isArray(m) &&
      Object.keys(m).every((k) => ['role', 'content'].includes(k)) &&
      m.role === (i % 2 === 0 ? 'user' : 'assistant') && typeof m.content === 'string' &&
      m.content.trim().length > 0 && m.content.length <= 2000) && messages.at(-1).role === 'user';
}
function createPracticeRouter({ enabled = practiceEnabled, request = axios.post,
  apiKey = () => process.env.GROQ_API_KEY, model = () => process.env.GROQ_TEST_MODEL || 'openai/gpt-oss-20b',
  openaiKey = khielKey, openaiReply = khielOpenAIReply } = {}) {
  const router = express.Router();
  const bases = ['/api/support/nood-ai/practice', '/api/support/khiel'];
  let busy = false;
  const minute = rateLimit({ windowMs: 60000, limit: 10, keyGenerator: () => 'practice',
    message: { success: false, message: 'Free preview limit reached. Try again in a minute.' } });
  const daily = rateLimit({ windowMs: 86400000, limit: 100, keyGenerator: () => 'practice',
    message: { success: false, message: 'Daily free preview limit reached.' } });
  router.use(bases, (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled()) return res.status(404).json({ success: false, message: 'Support is unavailable. Please contact a person.' });
    next();
  });
  router.get(bases.map((base) => `${base}/status`), (_req, res) => res.json({ success: true, available: Boolean(openaiKey() || apiKey()), provider: openaiKey() ? 'openai' : 'groq', voice: openaiKey() ? 'openai' : 'device' }));
  router.post(bases.map((base) => `${base}/message`), (req, res, next) => {
    if (!req.body || Object.keys(req.body).some((k) => k !== 'messages') || !validMessages(req.body.messages)) {
      return res.status(400).json({ success: false, message: 'Send a short conversation ending with your question.' });
    }
    next();
  }, minute, daily, async (req, res) => {
    if (busy) return res.status(409).json({ success: false, message: 'Please wait for the current answer.' });
    if (!openaiKey() && (!apiKey() || !['openai/gpt-oss-20b', 'openai/gpt-oss-120b'].includes(model()))) {
      return res.status(503).json({ success: false, message: 'Free provider is not configured.' });
    }
    busy = true;
    try {
      if (openaiKey()) {
        const message = await openaiReply({ req, messages: req.body.messages, apiKey: openaiKey(), request });
        return res.json({ success: true, message, provider: 'openai' });
      }
      const { data } = await request('https://api.groq.com/openai/v1/chat/completions', {
        model: model(), stream: false, max_completion_tokens: 700,
        messages: [{ role: 'system', content: `You are Khiel AI, a friendly AI assistant in a development preview of the NOOD shopping app. Your name is Khiel.
Hold a natural conversation and answer general questions briefly, usually in two to four sentences suitable for speech.
You have no access to live products, prices, customer accounts, orders, tracking, refunds or approved store policies.
Never invent those details. Explain this preview cannot look them up and suggest the human support button.
You cannot change orders, issue refunds, take payments or connect an agent. Never claim you did.
Never ask for passwords, payment details or personal account information. Do not repeat sensitive information.
The app has Account and Help & Support screens. Do not invent other navigation or promise unverified features.
Do not claim to be a human. Avoid markdown formatting in spoken answers.` }, ...req.body.messages],
      }, { headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        timeout: 25000, maxContentLength: 512 * 1024, maxRedirects: 0 });
      const choice = data?.choices?.[0];
      if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) throw new Error('invalid_reply');
      res.json({ success: true, message: choice.message.content.trim().slice(0, 2000), provider: 'groq' });
    } catch (error) {
      res.status(error.response?.status === 429 ? 429 : 503).json({ success: false,
        message: error.response?.status === 429 ? 'The AI usage limit was reached. Please try later.' : 'Support is unavailable. Your question is kept. Try again shortly.' });
    } finally { busy = false; }
  });
  router.post(bases.map((base) => `${base}/speech`), minute, daily, async (req, res) => {
    if (!openaiKey()) return res.status(404).json({ success: false, message: 'Cloud voice is not enabled. Use device voice.' });
    if (!req.body || Object.keys(req.body).some((key) => key !== 'text') || typeof req.body.text !== 'string' || !req.body.text.trim() || req.body.text.length > 2000) return res.status(400).json({ success: false, message: 'A short reply is required.' });
    if (busy) return res.status(409).json({ success: false, message: 'Please wait for the current reply.' });
    busy = true;
    try {
      const { data } = await request('https://api.openai.com/v1/audio/speech', {
        model: 'gpt-4o-mini-tts', voice: 'cedar', input: req.body.text, response_format: 'mp3',
        instructions: 'Speak warmly and clearly, in a calm conversational voice. You are Khiel, an AI support assistant.',
      }, { headers: { Authorization: `Bearer ${openaiKey()}`, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer', timeout: 25000, maxContentLength: 2 * 1024 * 1024, maxRedirects: 0 });
      if (!data?.byteLength) throw new Error('empty_audio');
      res.json({ success: true, audioBase64: Buffer.from(data).toString('base64') });
    } catch { res.status(503).json({ success: false, message: 'Spoken playback is unavailable. You can read the reply.' }); }
    finally { busy = false; }
  });
  return router;
}
module.exports = { createPracticeRouter, practiceEnabled, validMessages };
