const assert = require('node:assert/strict');
const test = require('node:test');
const { createInventoryReservationService } = require('../inventory/reservation');

test('reservation holds stock and blocks concurrent oversell', async () => {
  const service = createInventoryReservationService({ redis: null });
  const catalog = new Map([['gid://shopify/ProductVariant/1', 2]]);

  const getAvailableQty = async (variantId) => catalog.get(variantId) ?? 0;

  const first = await service.reserveLines({
    reservationId: 'r1',
    lines: [{ variantId: 'gid://shopify/ProductVariant/1', quantity: 2 }],
    getAvailableQty,
    customerId: 'c1',
    checkoutSessionId: 's1',
  });
  assert.equal(first.status, 'active');
  assert.equal(first.lines.length, 1);

  await assert.rejects(
    () =>
      service.reserveLines({
        reservationId: 'r2',
        lines: [{ variantId: 'gid://shopify/ProductVariant/1', quantity: 1 }],
        getAvailableQty,
        customerId: 'c2',
        checkoutSessionId: 's2',
      }),
    /Insufficient inventory/i
  );

  await service.releaseReservation('r1');

  const third = await service.reserveLines({
    reservationId: 'r3',
    lines: [{ variantId: 'gid://shopify/ProductVariant/1', quantity: 1 }],
    getAvailableQty,
    customerId: 'c3',
    checkoutSessionId: 's3',
  });
  assert.equal(third.status, 'active');
});

test('reservation is idempotent for same reservation id', async () => {
  const service = createInventoryReservationService({ redis: null });
  const getAvailableQty = async () => 5;

  const first = await service.reserveLines({
    reservationId: 'same',
    lines: [{ variantId: 'gid://shopify/ProductVariant/9', quantity: 1 }],
    getAvailableQty,
  });
  const second = await service.reserveLines({
    reservationId: 'same',
    lines: [{ variantId: 'gid://shopify/ProductVariant/9', quantity: 1 }],
    getAvailableQty,
  });
  assert.equal(second.duplicate, true);
  assert.equal(first.reservationId, second.reservationId);
  assert.equal(await service.getReservedQuantity('gid://shopify/ProductVariant/9'), 1);
});

test('CONTINUE policy variants are not reserved when resolver returns null', async () => {
  const service = createInventoryReservationService({ redis: null });
  const getAvailableQty = async () => null;

  const result = await service.reserveLines({
    reservationId: 'open-stock',
    lines: [{ variantId: 'gid://shopify/ProductVariant/open', quantity: 99 }],
    getAvailableQty,
  });
  assert.equal(result.lines.length, 0);
  assert.equal(await service.getReservedQuantity('gid://shopify/ProductVariant/open'), 0);
});

test('commit marks reservation committed', async () => {
  const service = createInventoryReservationService({ redis: null });
  const getAvailableQty = async () => 3;
  await service.reserveLines({
    reservationId: 'commit-me',
    lines: [{ variantId: 'gid://shopify/ProductVariant/2', quantity: 1 }],
    getAvailableQty,
  });
  const committed = await service.commitReservation('commit-me');
  assert.equal(committed.record.status, 'committed');
});
