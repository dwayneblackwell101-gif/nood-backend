const router = require('express').Router();
const { listDiscounts } = require('../services/shopify-discounts');
router.get('/api/discounts', async (_req, res) => {
  try {
    const all = await listDiscounts();
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, source: 'shopify', fetchedAt: new Date().toISOString(), all,
      automatic: all.filter(x => x.kind === 'automatic'), coupons: all.filter(x => x.kind === 'coupon'), shipping: all.filter(x => x.kind === 'free_shipping') });
  } catch (error) {
    console.error('[DISCOUNTS]', error.message);
    return res.status(503).json({ success: false, message: 'Offers are temporarily unavailable. Please try again.', all: [], automatic: [], coupons: [], shipping: [] });
  }
});
module.exports = { router };
