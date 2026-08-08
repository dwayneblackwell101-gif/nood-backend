/**
 * Notification campaign engine — Temu-style automated pushes.
 *
 * Runs every 15 minutes and fires scheduled campaigns to registered users:
 *  - Daily reward reminder (once/day)
 *  - Flash sale live (during flash windows)
 *  - Price drop / hot product (when triggered by the API)
 *  - Cart abandonment nudge (users who synced a cart but didn't buy)
 *
 * Tokens live in push-tokens.json (registered by the app). Uses Expo's
 * push API. Campaigns are time-gated so users aren't spammed.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TOKENS_FILE = path.join(__dirname, '..', 'push-tokens.json');
const STATE_FILE = path.join(__dirname, '..', 'campaign-state.json');
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[CAMPAIGNS] save failed:', error.message);
  }
}

function loadTokens() {
  return loadJson(TOKENS_FILE, {});
}

function loadState() {
  return loadJson(STATE_FILE, { lastSent: {}, sentToday: {} });
}

function saveState(state) {
  saveJson(STATE_FILE, state);
}

/** Send a push to one or more tokens. */
async function sendPush(tokens, { title, body, data }) {
  if (!tokens.length) return 0;

  const messages = tokens.map((t) => ({
    to: t.token,
    sound: 'default',
    title,
    body,
    data: data || {},
  }));

  try {
    const response = await axios.post(EXPO_PUSH_URL, messages, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    return messages.length;
  } catch (error) {
    console.error('[CAMPAIGNS] send failed:', error.message);
    return 0;
  }
}

function tokensForUser(state, userId) {
  return Object.values(loadTokens()).filter((t) => t.userId === userId);
}

function tokensForAll() {
  return Object.values(loadTokens());
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function hasSentToday(state, campaign, userId) {
  const key = `${campaign}:${userId || 'all'}`;
  return state.sentToday[key] === todayKey();
}

function markSentToday(state, campaign, userId) {
  const key = `${campaign}:${userId || 'all'}`;
  state.sentToday[key] = todayKey();
  saveState(state);
}

/**
 * Runs all campaigns. Exposed for manual trigger + scheduled interval.
 */
async function runCampaigns() {
  const state = loadState();
  const all = tokensForAll();

  // 1. Daily reward reminder — once per day, ~6pm local.
  const hour = new Date().getHours();
  if (hour === 18 && !hasSentToday(state, 'daily-reward', 'all')) {
    await sendPush(all, {
      title: 'Your daily reward is waiting 🎁',
      body: 'Claim your NOOD reward and keep your streak alive!',
      data: { type: 'daily-reward-reminder' },
    });
    markSentToday(state, 'daily-reward', 'all');
    console.log('[CAMPAIGNS] sent daily-reward to', all.length);
  }

  // 2. Flash sale live — during active flash windows (6-10, 14-18, 22-2).
  const isFlashActive =
    (hour >= 6 && hour < 10) || (hour >= 14 && hour < 18) || (hour >= 22);
  if (isFlashActive && !hasSentToday(state, 'flash-live', 'all')) {
    await sendPush(all, {
      title: '⚡ Flash Sale LIVE',
      body: 'Up to 70% off — when the clock hits zero, prices go back up!',
      data: { type: 'flash-sale', screen: 'modal' },
    });
    markSentToday(state, 'flash-live', 'all');
    console.log('[CAMPAIGNS] sent flash-live to', all.length);
  }

  // 3. Personalized cart nudge — per user (only if they have a cart).
  const cartUsers = loadJson(path.join(__dirname, '..', 'cart-users.json'), {});
  for (const [userId, cart] of Object.entries(cartUsers)) {
    if (hasSentToday(state, 'cart-nudge', userId)) continue;
    const userTokens = tokensForUser(state, userId);
    if (!userTokens.length) continue;

    const items = Array.isArray(cart?.items) ? cart.items : [];
    if (items.length) {
      await sendPush(userTokens, {
        title: '🛒 Still thinking about it?',
        body: 'You left items in your cart — complete your order before they sell out!',
        data: { type: 'cart_reminder', screen: 'cart' },
      });
      markSentToday(state, 'cart-nudge', userId);
      console.log('[CAMPAIGNS] cart-nudge to', userId);
    }
  }

  return { sent: true };
}

// Run every 15 minutes.
setInterval(() => {
  runCampaigns().catch((e) => console.error('[CAMPAIGNS] interval error:', e.message));
}, 15 * 60 * 1000);

// Also run once on startup (after 30s so the server is up).
setTimeout(() => {
  runCampaigns().catch((e) => console.error('[CAMPAIGNS] startup error:', e.message));
}, 30000);

module.exports = { runCampaigns };
