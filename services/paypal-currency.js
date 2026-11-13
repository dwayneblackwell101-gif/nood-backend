const axios = require('axios');
const { moneyToCents } = require('./catalog-pricing');
let cachedRate = null;
let pendingRate = null;
const MAX_AGE = 12 * 60 * 60 * 1000;
async function ttdPerUsd() {
  if (cachedRate && cachedRate.expiresAt > Date.now()) return cachedRate;
  if (pendingRate) return pendingRate;
  pendingRate = (async () => {
    const { data } = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 12000 });
    const rate = Number(data?.rates?.TTD);
    const updated = Number(data?.time_last_update_unix) * 1000;
    if (data?.result !== 'success' || data?.base_code !== 'USD' || !Number.isFinite(rate) || rate <= 0 ||
        !Number.isFinite(updated) || updated > Date.now() + 300000 || Date.now() - updated > 48 * 60 * 60 * 1000) {
      throw Object.assign(new Error('Currency conversion is temporarily unavailable. Please try again later.'), { statusCode: 503 });
    }
    cachedRate = { rate, quotedAt: new Date().toISOString(), expiresAt: Date.now() + MAX_AGE };
    return cachedRate;
  })();
  try { return await pendingRate; } finally { pendingRate = null; }
}
function convertTtdToUsd(amount, rate) {
  const cents = moneyToCents(amount);
  if (!cents || !Number.isFinite(rate) || rate <= 0) throw new Error('Invalid conversion amount or rate');
  const usdCents = Math.round(cents / rate);
  if (usdCents < 1) throw Object.assign(new Error('Amount is too small for PayPal checkout'), { statusCode: 400 });
  return (usdCents / 100).toFixed(2);
}
async function quotePayPalSettlement(quote) {
  const currency = String(quote.currency).toUpperCase();
  if (currency === 'USD') return { amount: quote.total, currency: 'USD', sourceAmount: quote.total, sourceCurrency: 'USD' };
  if (currency !== 'TTD') throw Object.assign(new Error('PayPal checkout currently supports store prices in USD or TTD'), { statusCode: 400 });
  const rate = await ttdPerUsd();
  return { amount: convertTtdToUsd(quote.total, rate.rate), currency: 'USD', sourceAmount: quote.total,
    sourceCurrency: currency, ttdPerUsd: rate.rate, quotedAt: rate.quotedAt };
}
function refundSettlement(amount, currency, session) {
  const settlement = session?.quote?.paypalSettlement;
  if (!settlement) {
    if (currency === 'TTD') throw new Error('Original payment conversion record is missing; manual refund review required');
    return { amount, currency };
  }
  const refund = moneyToCents(amount), original = moneyToCents(settlement.sourceAmount), paid = moneyToCents(settlement.amount);
  if (!refund || !original || !paid || refund > original || currency !== settlement.sourceCurrency) throw new Error('Invalid original-payment refund quote');
  // Reuse the captured quote, never today's rate. Full refunds exactly match capture.
  const cents = Number((BigInt(refund) * BigInt(paid) + BigInt(Math.floor(original / 2))) / BigInt(original));
  if (cents < 1) throw new Error('Refund is below the payment currency minimum');
  return { amount: (cents / 100).toFixed(2), currency: settlement.currency };
}
module.exports = { quotePayPalSettlement, convertTtdToUsd, refundSettlement };
