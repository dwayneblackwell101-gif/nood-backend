const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nood-commerce-'));
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.PUSH_WALLET_FILE = path.join(temp, 'wallet.json');
process.env.PUSH_LEDGER_FILE = path.join(temp, 'ledger.json');

const { moneyToCents, toVariantGid } = require('../services/catalog-pricing');
const { applyWalletTxn, getWalletBalance, issueReward, listLedgerForUser } = require('../utils/reward-ledger');
const { calculateTrustedRefund } = require('../routes/refunds');
const { calculateDiscount, cleanCode } = require('../services/promotions');
const { ANALYTICS_EVENTS, SUPPORT_CATEGORIES } = require('../routes/platform');
const { rewardCapabilityEnabled } = require('../routes/rewards');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}`); throw error; }
}

(async () => {
  console.log('\nNOOD commerce integrity tests\n');
  await test('strict money parsing rejects malformed values', () => {
    assert.strictEqual(moneyToCents('10.25'), 1025);
    assert.strictEqual(moneyToCents('10.2'), 1020);
    assert.strictEqual(moneyToCents('-1'), null);
    assert.strictEqual(moneyToCents('1.234'), null);
    assert.strictEqual(moneyToCents('10abc'), null);
  });
  await test('Shopify variant IDs normalize without double-prefixing', () => {
    assert.strictEqual(toVariantGid('123'), 'gid://shopify/ProductVariant/123');
    assert.strictEqual(toVariantGid('gid://shopify/ProductVariant/456'), 'gid://shopify/ProductVariant/456');
    assert.strictEqual(toVariantGid('bad-id'), '');
  });
  await test('concurrent wallet debits cannot overspend', async () => {
    await applyWalletTxn({ user_id: 'concurrent', amount: 10, currency: 'USD', source: 'test', idempotency_key: 'seed' });
    const results = await Promise.all([
      applyWalletTxn({ user_id: 'concurrent', amount: -8, currency: 'USD', source: 'order', idempotency_key: 'debit-a' }),
      applyWalletTxn({ user_id: 'concurrent', amount: -8, currency: 'USD', source: 'order', idempotency_key: 'debit-b' }),
    ]);
    assert.strictEqual(results.filter((r) => r.ok).length, 1);
    assert.strictEqual(await getWalletBalance('concurrent'), 2);
  });
  await test('reversal restores a prior debit exactly once', async () => {
    await applyWalletTxn({ user_id: 'reverse', amount: 10, currency: 'USD', source: 'test', idempotency_key: 'r-seed' });
    const debit = await applyWalletTxn({ user_id: 'reverse', amount: -4, currency: 'USD', source: 'order', idempotency_key: 'r-debit' });
    await applyWalletTxn({ user_id: 'reverse', amount: 4, currency: 'USD', type: 'reversal', source: 'reversal', idempotency_key: 'r-reverse', reverses_transaction_id: debit.txnId });
    const replay = await applyWalletTxn({ user_id: 'reverse', amount: 4, currency: 'USD', type: 'reversal', source: 'reversal', idempotency_key: 'r-reverse', reverses_transaction_id: debit.txnId });
    assert.strictEqual(replay.replay, true);
    assert.strictEqual(await getWalletBalance('reverse'), 10);
  });
  await test('issued rewards credit the spendable wallet ledger', async () => {
    const result = await issueReward({ user_id: 'reward-user', source: 'test', amount: 5, currency: 'USD', related_id: 'reward-1', idempotency_key: 'reward-1' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(await getWalletBalance('reward-user'), 5);
  });
  await test('spendable rewards do not advertise unsafe expiry by default', async () => {
    await issueReward({ user_id: 'non-expiring', source: 'test', amount: 2, currency: 'USD', idempotency_key: 'non-expiring-1', expires_in_ms: 1 });
    const entries = await listLedgerForUser('non-expiring');
    assert.strictEqual(entries[0].expires_at, null);
  });
  await test('refund amount and currency come from purchased server items', () => {
    const quote = calculateTrustedRefund({
      total: 30,
      currency: 'USD',
      items: [
        { variantId: 'gid://shopify/ProductVariant/1', title: 'One', quantity: 2, price: '10.00' },
        { variantId: 'gid://shopify/ProductVariant/2', title: 'Two', quantity: 1, price: '10.00' },
      ],
    }, [{ id: 'gid://shopify/ProductVariant/1', quantity: 1 }]);
    assert.strictEqual(quote.ok, true);
    assert.strictEqual(quote.amount, 10);
    assert.strictEqual(quote.currency, 'USD');
  });
  await test('refund rejects unknown or excessive item quantities', () => {
    const order = { total: 10, currency: 'USD', items: [{ variantId: 'v1', quantity: 1, price: 10 }] };
    assert.strictEqual(calculateTrustedRefund(order, [{ id: 'not-owned', quantity: 1 }]).ok, false);
    assert.strictEqual(calculateTrustedRefund(order, [{ id: 'v1', quantity: 2 }]).ok, false);
  });
  await test('coupon discount is capped, currency-bound, and never exceeds subtotal', () => {
    const percent = { currency: 'USD', min_subtotal: 20, discount_type: 'percent', discount_value: 50, max_discount: 12 };
    assert.strictEqual(calculateDiscount(percent, 3000, 'USD'), 1200);
    assert.strictEqual(calculateDiscount(percent, 1900, 'USD'), 0);
    assert.strictEqual(calculateDiscount(percent, 3000, 'TTD'), 0);
    const fixed = { currency: 'USD', min_subtotal: 0, discount_type: 'fixed', discount_value: 50, max_discount: null };
    assert.strictEqual(calculateDiscount(fixed, 3000, 'USD'), 3000);
  });
  await test('coupon codes are normalized before lookup', () => {
    assert.strictEqual(cleanCode('  summer-25!! '), 'SUMMER-25');
    assert.strictEqual(cleanCode('a'.repeat(60)).length, 40);
  });
  await test('analytics and support accept only allowlisted values', () => {
    assert.ok(ANALYTICS_EVENTS.has('order'));
    assert.ok(!ANALYTICS_EVENTS.has('password'));
    assert.ok(SUPPORT_CATEGORIES.has('payment'));
    assert.ok(!SUPPORT_CATEGORIES.has('admin'));
  });
  await test('reward capabilities fail closed and enable independently', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousReferral = process.env.REWARD_REFERRAL_CHALLENGE_ENABLED;
    process.env.NODE_ENV = 'production';
    delete process.env.REWARD_REFERRAL_CHALLENGE_ENABLED;
    assert.strictEqual(rewardCapabilityEnabled('referralChallenge'), false);
    process.env.REWARD_REFERRAL_CHALLENGE_ENABLED = 'true';
    assert.strictEqual(rewardCapabilityEnabled('referralChallenge'), true);
    assert.strictEqual(rewardCapabilityEnabled('styleChallenges'), false);
    if (previousNodeEnv == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousReferral == null) delete process.env.REWARD_REFERRAL_CHALLENGE_ENABLED; else process.env.REWARD_REFERRAL_CHALLENGE_ENABLED = previousReferral;
  });
  console.log(`\n${passed} passed, 0 failed\n`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
