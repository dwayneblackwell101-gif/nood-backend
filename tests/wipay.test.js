const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const wipay = require('../services/wipay');
const sessions = new Map();
let orders = 0;
let credits = 0;
let failOrder = false;
function mock(modulePath, exports) { require.cache[require.resolve(modulePath)] = { id: require.resolve(modulePath), filename: require.resolve(modulePath), loaded: true, exports }; }
mock('../utils/payment-state', {
  savePayment: async s => sessions.set(s.provider_order_id, structuredClone(s)),
  getPayment: async id => structuredClone(sessions.get(id)),
  claimPayment: async (id, capture) => { const s = sessions.get(id); if (s.status !== 'created') return false; s.status = 'captured'; s.capture_id = capture; return true; },
});
mock('../services/promotions', { quoteCart: async () => ({ total: '10.00', subtotal: '10.00', currency: 'USD', lines: [{ variantId: '123', quantity: 1 }] }) });
mock('../services/customer-auth', { authenticateCustomer: async req => req.headers.authorization ? { userId: 'user-1', email: 'test@example.com' } : null });
mock('../utils/reward-ledger', { applyWalletTxn: async () => { credits++; return { ok: true, txnId: 'credit-1', balance: 10 }; } });
wipay.requestPayment = async () => 'https://ttsb.wipayfinancial.com/checkout';
process.env.NODE_ENV = 'test'; process.env.WIPAY_ENVIRONMENT = 'sandbox';
process.env.NOOD_ADMIN_TOKEN = 'sandbox-admin-token-for-tests-only';
const app = express(); app.use(express.json());
app.use(require('../routes/wipay')({ baseUrl: 'https://backend.example',
  buildAppRedirect: (_, params) => `noodapp://payment-result?${new URLSearchParams(params)}`,
  createShopifyOrder: async args => { orders++; assert.equal(args.total, '10.00'); if (failOrder) throw new Error('Simulated timeout'); return { id: 'shop-1', name: '#1' }; },
}));
const server = app.listen(0, '127.0.0.1');
(async () => {
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function create(path, body, auth = false) {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer test' } : {}) }, body: JSON.stringify(body) });
    return { code: res.status, data: await res.json() };
  }
  function proof(id) {
    const s = sessions.get(id); const transaction = `SB-12-1-${id}-20261111000000`;
    return { order_id: id, return_token: s.customer.returnToken, status: 'success', currency: s.currency,
      transaction_id: transaction, hash: crypto.createHash('md5').update(transaction + s.amount + '123').digest('hex') };
  }
  async function callback(params) { const res = await fetch(`${base}/payment-return?${new URLSearchParams(params)}`, { redirect: 'manual' }); return res.headers.get('location'); }
  const first = await create('/create-wipay-payment', { total: 1, cartItems: [{ id: '123', quantity: 1 }] });
  assert.equal(first.code, 200); const id = first.data.order_id;
  assert.equal(sessions.get(id).amount, '10.00');
  assert.match(await callback({ ...proof(id), hash: '0'.repeat(32) }), /payment_not_verified/); assert.equal(orders, 0);
  assert.match(await callback({ ...proof(id), currency: 'TTD' }), /payment_not_verified/);
  assert.match(await callback({ ...proof(id), return_token: 'bad' }), /invalid_payment_session/);
  assert.match(await callback(proof(id)), /status=success/); assert.equal(orders, 1);
  const jsonReturn = await fetch(`${base}/payment-return?${new URLSearchParams(proof(id))}`, { headers: { Accept: 'application/json' } });
  const jsonResult = await jsonReturn.json();
  assert.equal(jsonResult.success, true); assert.equal(jsonResult.shopify_order_name, '#1');
  assert.match(jsonResult.redirect_url, /status=success/); assert.equal(orders, 1);
  assert.match(await callback(proof(id)), /status=success/); assert.equal(orders, 1);
  const other = await create('/create-wipay-payment', { cartItems: [{}] }); const otherId = other.data.order_id;
  assert.match(await callback({ ...proof(id), order_id: otherId, return_token: sessions.get(otherId).customer.returnToken }), /payment_not_verified/);
  assert.equal((await create('/wallet/topup', { amount: '10.00' })).code, 401);
  assert.equal((await create('/wallet/topup', { amount: '10.00', currency: 'TTD' }, true)).code, 400);
  const topup = await create('/wallet/topup', { amount: '10.00', currency: 'USD' }, true);
  assert.equal(topup.code, 200); await callback(proof(topup.data.order_id)); await callback(proof(topup.data.order_id)); assert.equal(credits, 1);
  failOrder = true;
  assert.match(await callback(proof(otherId)), /payment_received_order_review/);
  failOrder = false;
  assert.match(await callback(proof(otherId)), /status=success/); assert.equal(orders, 3);
  await callback(proof(otherId)); assert.equal(orders, 3);
  process.env.NODE_ENV = 'production'; assert.throws(() => wipay.configuration(), /live credentials/);
  process.env.SUPABASE_URL='https://db.example';process.env.SUPABASE_SERVICE_ROLE_KEY='test';
  assert.equal(wipay.configuration({sandboxTest:true}).environment,'sandbox');
  const blocked = await create('/api/admin/payments/wipay-sandbox-test', {cartItems:[{}]});
  assert.equal(blocked.code,401);
  const adminResult=await fetch(base+'/api/admin/payments/wipay-sandbox-test',{method:'POST',headers:{'Content-Type':'application/json','x-admin-token':process.env.NOOD_ADMIN_TOKEN},body:JSON.stringify({cartItems:[{}]})});
  const adminData=await adminResult.json();assert.equal(adminResult.status,200);
  assert.equal(sessions.get(adminData.order_id).provider,'wipay_test');
  assert.match(adminData.return_url,/return_token=/);
  console.log('WiPay tests passed: forged proofs, currency/token/order binding, trusted pricing, replay, wallet auth and credit, interrupted fulfillment, production sandbox rejection');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());

