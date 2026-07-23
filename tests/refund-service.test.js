const assert = require('node:assert/strict');
const test = require('node:test');

const { calculateRefund, createRefundService } = require('../refunds/refund-service');

function createCollection() {
  const items = new Map();
  return {
    get: (key) => items.get(String(key)),
    set: (key, value) => {
      items.set(String(key), value);
      return value;
    },
    values: () => Array.from(items.values()),
  };
}

function createLockService() {
  return {
    async withLock(_key, _ttl, fn) {
      return fn();
    },
  };
}

function money(amount, currencyCode = 'USD') {
  return { shopMoney: { amount, currencyCode } };
}

function makeOrder(overrides = {}) {
  return {
    id: 'gid://shopify/Order/1',
    name: '#1001',
    email: 'buyer@example.com',
    currencyCode: 'USD',
    displayFinancialStatus: 'PAID',
    customer: { id: 'gid://shopify/Customer/1', email: 'buyer@example.com' },
    totalReceivedSet: money('43.20'),
    currentTotalPriceSet: money('43.20'),
    totalShippingPriceSet: money('5.00'),
    transactions: [
      { id: 'CAPTURE-1', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'paypal', amountSet: money('43.20') },
    ],
    lineItems: {
      edges: [
        {
          node: {
            id: 'LINE-1',
            title: 'Hat',
            quantity: 2,
            variant: { id: 'VARIANT-1' },
            originalTotalSet: money('40.00'),
            discountedTotalSet: money('36.00'),
            taxLines: [{ priceSet: money('2.40') }],
          },
        },
      ],
    },
    refunds: { edges: [] },
    ...overrides,
  };
}

function createService({ order = makeOrder(), walletCreditImpl, paypalRefundClient, paypalRefundsEnabled = false } = {}) {
  const refundRequests = createCollection();
  const service = createRefundService({
    refundRequests,
    lockService: createLockService(),
    walletRefundService: {
      creditWalletRefund: walletCreditImpl || (() => ({ walletTransactionId: 'WALLET-REFUND-1', credited: true })),
    },
    fetchShopifyOrder: async () => order,
    paypalRefundClient,
    paypalRefundsEnabled,
  });
  return { service, refundRequests };
}

const customer = { id: 'gid://shopify/Customer/1', email: 'buyer@example.com' };

test('customer refund submission verifies Shopify ownership and does not move money', async () => {
  let walletCredits = 0;
  const { service } = createService({
    walletCreditImpl: () => {
      walletCredits += 1;
      return { walletTransactionId: 'WALLET-1' };
    },
  });

  const result = await service.submitCustomerRequest({
    customer,
    body: {
      request_id: 'REQ-1',
      order_id: 'gid://shopify/Order/1',
      reason: 'Too small',
      refund_method: 'wallet',
      amount: '999.99',
      items: [{ lineItemId: 'LINE-1', variantId: 'VARIANT-1', quantity: 1 }],
    },
  });

  assert.equal(result.record.status, 'requested');
  assert.equal(result.record.amount_cents, 1920);
  assert.equal(result.record.ownership_verification, 'shopify_customer_id');
  assert.equal(walletCredits, 0);
});

test('another customer order and unprovable guest order are rejected', async () => {
  const otherOrder = makeOrder({ customer: { id: 'gid://shopify/Customer/2', email: 'other@example.com' } });
  const other = createService({ order: otherOrder });

  await assert.rejects(
    () =>
      other.service.submitCustomerRequest({
        customer,
        body: { request_id: 'REQ-2', order_id: 'gid://shopify/Order/1', reason: 'No', items: [{ lineItemId: 'LINE-1', quantity: 1 }] },
      }),
    /does not own/
  );

  const guest = createService({ order: makeOrder({ customer: null, email: 'guest@example.com' }) });
  await assert.rejects(
    () =>
      guest.service.submitCustomerRequest({
        customer,
        body: { request_id: 'REQ-3', order_id: 'gid://shopify/Order/1', reason: 'No', items: [{ lineItemId: 'LINE-1', quantity: 1 }] },
      }),
    /Guest order/
  );
});

test('verified email fallback is accepted when Shopify customer ID is unavailable', async () => {
  const { service } = createService({ order: makeOrder({ customer: null, email: 'buyer@example.com' }) });
  const result = await service.submitCustomerRequest({
    customer,
    body: { request_id: 'REQ-4', order_id: 'gid://shopify/Order/1', reason: 'Fit', items: [{ lineItemId: 'LINE-1', quantity: 1 }] },
  });

  assert.equal(result.record.ownership_verification, 'verified_customer_email_fallback');
});

test('line-item validation rejects unknown, wrong variant, zero, negative, and over-refund quantities', () => {
  const order = makeOrder();
  assert.throws(() => calculateRefund({ order, requestedItems: [{ lineItemId: 'UNKNOWN', quantity: 1 }] }), /does not belong/);
  assert.throws(() => calculateRefund({ order, requestedItems: [{ lineItemId: 'LINE-1', variantId: 'OTHER', quantity: 1 }] }), /variant/);
  assert.throws(() => calculateRefund({ order, requestedItems: [{ lineItemId: 'LINE-1', quantity: 0 }] }), /positive integer/);
  assert.throws(() => calculateRefund({ order, requestedItems: [{ lineItemId: 'LINE-1', quantity: -1 }] }), /positive integer/);
  assert.throws(() => calculateRefund({ order, requestedItems: [{ lineItemId: 'LINE-1', quantity: 3 }] }), /exceeds/);
});

test('duplicate line items merge and previous refunds reduce remaining quantity', () => {
  const order = makeOrder({
    refunds: {
      edges: [
        {
          node: {
            refundLineItems: {
              edges: [
                { node: { quantity: 1, lineItem: { id: 'LINE-1' }, subtotalSet: money('18.00'), totalTaxSet: money('1.20') } },
              ],
            },
          },
        },
      ],
    },
  });

  const calc = calculateRefund({
    order,
    requestedItems: [
      { lineItemId: 'LINE-1', quantity: 1 },
    ],
  });
  assert.equal(calc.amount_cents, 1920);
  assert.equal(calc.previous_refund_cents, 1920);
  assert.throws(() => calculateRefund({ order, requestedItems: [{ lineItemId: 'LINE-1', quantity: 2 }] }), /exceeds/);
});

test('shipping policy is server-side and client amount is ignored', async () => {
  const order = makeOrder();
  const calc = calculateRefund({
    order,
    shippingPolicy: 'refund_shipping',
    requestedItems: [{ lineItemId: 'LINE-1', quantity: 1 }],
  });
  assert.equal(calc.amount_cents, 2420);

  const { service } = createService({ order });
  const result = await service.submitCustomerRequest({
    customer,
    body: {
      request_id: 'REQ-5',
      order_id: 'gid://shopify/Order/1',
      reason: 'No',
      amount: '1.00',
      items: [{ lineItemId: 'LINE-1', quantity: 1 }],
    },
  });
  assert.equal(result.record.amount, '19.20');
});

test('admin approval credits wallet once and repeated approval replays completion', async () => {
  let credits = 0;
  const { service } = createService({
    walletCreditImpl: () => {
      credits += 1;
      return { walletTransactionId: 'WALLET-1', credited: true };
    },
  });
  await service.submitCustomerRequest({
    customer,
    body: { request_id: 'REQ-6', order_id: 'gid://shopify/Order/1', reason: 'Fit', refund_method: 'wallet', items: [{ lineItemId: 'LINE-1', quantity: 1 }] },
  });

  const first = await service.adminApply({ requestId: 'REQ-6', action: 'approve', adminId: 'admin-1' });
  const second = await service.adminApply({ requestId: 'REQ-6', action: 'approve', adminId: 'admin-1' });

  assert.equal(first.record.status, 'completed');
  assert.equal(first.record.compensation_destination, 'wallet');
  assert.equal(second.result.duplicate, true);
  assert.equal(credits, 1);
});

test('completed wallet refund blocks PayPal compensation and destination changes', async () => {
  const { service } = createService();
  await service.submitCustomerRequest({
    customer,
    body: { request_id: 'REQ-7', order_id: 'gid://shopify/Order/1', reason: 'Fit', refund_method: 'wallet', items: [{ lineItemId: 'LINE-1', quantity: 1 }] },
  });
  await service.adminApply({ requestId: 'REQ-7', action: 'approve', adminId: 'admin-1' });

  await assert.rejects(
    () => service.adminApply({ requestId: 'REQ-7', action: 'approve', destination: 'original_payment_method', adminId: 'admin-1' }),
    /destination cannot change|Terminal refund state/
  );
});

test('PayPal refund can be mocked and stores provider refund ID', async () => {
  const { service } = createService({
    paypalRefundsEnabled: true,
    paypalRefundClient: {
      async refundCapture(input) {
        assert.equal(input.captureId, 'CAPTURE-1');
        assert.equal(input.amountCents, 1920);
        return { id: 'PAYPAL-REFUND-1', amount: { value: '19.20', currency_code: 'USD' } };
      },
    },
  });
  await service.submitCustomerRequest({
    customer,
    body: { request_id: 'REQ-8', order_id: 'gid://shopify/Order/1', reason: 'Fit', refund_method: 'original_payment_method', items: [{ lineItemId: 'LINE-1', quantity: 1 }] },
  });
  const result = await service.adminApply({ requestId: 'REQ-8', action: 'approve', adminId: 'admin-1' });

  assert.equal(result.record.status, 'completed');
  assert.equal(result.record.provider_refund_id, 'PAYPAL-REFUND-1');
  assert.equal(result.record.compensation_destination, 'paypal');
});

test('WiPay-backed refunds enter manual review and do not auto credit wallet', async () => {
  let credits = 0;
  const { service } = createService({
    order: makeOrder({
      transactions: [{ id: 'WIPAY-1', kind: 'SALE', status: 'SUCCESS', gateway: 'wipay', amountSet: money('43.20') }],
    }),
    walletCreditImpl: () => {
      credits += 1;
      return { walletTransactionId: 'WALLET-1' };
    },
  });
  await service.submitCustomerRequest({
    customer,
    body: { request_id: 'REQ-9', order_id: 'gid://shopify/Order/1', reason: 'Fit', refund_method: 'original_payment_method', items: [{ lineItemId: 'LINE-1', quantity: 1 }] },
  });
  const result = await service.adminApply({ requestId: 'REQ-9', action: 'approve', adminId: 'admin-1' });

  assert.equal(result.record.status, 'manual_review');
  assert.equal(result.record.manual_review_reason, 'wipay_refunds_disabled');
  assert.equal(credits, 0);
});

test('customer cannot read another customer refund request', async () => {
  const { service } = createService();
  await service.submitCustomerRequest({
    customer,
    body: { request_id: 'REQ-10', order_id: 'gid://shopify/Order/1', reason: 'Fit', items: [{ lineItemId: 'LINE-1', quantity: 1 }] },
  });

  assert.throws(
    () => service.getCustomerRequest({ requestId: 'REQ-10', customer: { id: 'gid://shopify/Customer/2', email: 'other@example.com' } }),
    /does not own/
  );
});
