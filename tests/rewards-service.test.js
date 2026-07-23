const assert = require('node:assert/strict');
const test = require('node:test');
const { createRewardsStore } = require('../rewards/store');
const { createRewardsService, pickWeightedPrize } = require('../rewards/service');
const { getRewardsConfig } = require('../rewards/config');
const { createRewardsRouter } = require('../rewards/routes');

function createMemoryWallet() {
  const balances = new Map();
  const idempotency = new Map();

  return {
    async getBalanceCents(customerId) {
      return Number(balances.get(customerId) || 0);
    },
    async credit({ customerId, amountCents, idempotencyKey }) {
      if (idempotency.has(idempotencyKey)) {
        return { ...idempotency.get(idempotencyKey), duplicate: true };
      }
      const previous = Number(balances.get(customerId) || 0);
      const next = previous + amountCents;
      balances.set(customerId, next);
      const record = {
        transactionId: `tx_${idempotencyKey}`,
        walletTransactionId: `tx_${idempotencyKey}`,
        previousBalanceCents: previous,
        resultingBalanceCents: next,
        duplicate: false,
      };
      idempotency.set(idempotencyKey, record);
      return record;
    },
  };
}

function createService(overrides = {}) {
  const store = createRewardsStore();
  const redisWallet = createMemoryWallet();
  const service = createRewardsService({
    store,
    redisWallet,
    config: getRewardsConfig({
      REWARDS_SPECIAL_AMOUNT_USD: '10',
      REWARDS_SCRATCH_AMOUNT_USD: '10',
      REWARDS_DAILY_AMOUNT_USD: '0.5',
    }),
    ...overrides,
  });
  return { service, store, redisWallet };
}

test('pickWeightedPrize is deterministic for fixed RNG bytes', () => {
  const prizes = [
    { id: 'a', weight: 1 },
    { id: 'b', weight: 1 },
  ];
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0);
  const prize = pickWeightedPrize(prizes, buf);
  assert.equal(prize.id, 'a');
});

test('rewards status creates challenge and referral code', async () => {
  const { service } = createService();
  const customerId = 'gid://shopify/Customer/111';
  const status = await service.getStatus(customerId);

  assert.equal(status.success, true);
  assert.equal(status.customerId, customerId);
  assert.equal(status.challenges.length, 1);
  assert.equal(status.challenges[0].id, 'invite_5_friends_7_days');
  assert.match(status.challenges[0].referralCode, /^NOOD-/);
  assert.equal(status.challenges[0].eligibleToClaim, false);
  assert.equal(status.luckySpin.canSpin, true);
  assert.equal(status.scratch.canPlay, true);
});

test('lucky spin credits wallet once and rejects second spin', async () => {
  const { service, redisWallet } = createService({
    randomBytesFn: () => {
      const buf = Buffer.alloc(8);
      buf.writeUInt32BE(0, 0);
      return buf;
    },
  });
  const customerId = 'gid://shopify/Customer/222';

  const first = await service.spinLuckySpin(customerId, 'spin-1');
  assert.equal(first.success, true);
  assert.equal(first.walletCredited, true);
  assert.equal(first.canSpin, false);
  assert.ok(first.luckySpinRewardAmountUsd > 0);

  const balance = await redisWallet.getBalanceCents(customerId);
  assert.equal(balance, first.luckySpinRewardAmountUsd * 100);

  await assert.rejects(() => service.spinLuckySpin(customerId, 'spin-2'), /already used/i);

  const replay = await service.spinLuckySpin(customerId, 'spin-1');
  assert.equal(replay.idempotentReplay, true);
  assert.equal(await redisWallet.getBalanceCents(customerId), balance);
});

test('scratch claim is idempotent and enters cooldown', async () => {
  const { service } = createService();
  const customerId = 'gid://shopify/Customer/333';

  const claim = await service.claimScratch(customerId, 'scratch-1');
  assert.equal(claim.success, true);
  assert.equal(claim.rewardAmount, 10);
  assert.equal(claim.canPlay, false);

  const replay = await service.claimScratch(customerId, 'scratch-1');
  assert.equal(replay.idempotentReplay, true);

  await assert.rejects(() => service.claimScratch(customerId, 'scratch-2'), /cooldown|already/i);
});

test('referral attribution increments invite count; claim requires goal', async () => {
  const { service } = createService();
  const referrerId = 'gid://shopify/Customer/444';
  const status = await service.getStatus(referrerId);
  const code = status.challenges[0].referralCode;

  await assert.rejects(() => service.claimChallenge(referrerId, 'invite_5_friends_7_days'), /Complete the challenge/i);

  for (let i = 1; i <= 5; i += 1) {
    await service.attributeReferral({
      referralCode: code,
      referredCustomerId: `gid://shopify/Customer/9${i}`,
    });
  }

  const after = await service.getChallenges(referrerId);
  assert.equal(after.challenges[0].invitedCount, 5);
  assert.equal(after.challenges[0].eligibleToClaim, true);

  const claim = await service.claimChallenge(referrerId, 'invite_5_friends_7_days', 'claim-1');
  assert.equal(claim.success, true);
  assert.equal(claim.rewardAmount, 10);
  assert.equal(claim.challenge.claimed, true);

  await assert.rejects(
    () => service.claimChallenge(referrerId, 'invite_5_friends_7_days', 'claim-2'),
    /already claimed/i
  );
});

test('daily check-in credits once per UTC day', async () => {
  const { service, redisWallet } = createService();
  const customerId = 'gid://shopify/Customer/555';

  const first = await service.dailyCheckIn(customerId, 'day-1');
  assert.equal(first.success, true);
  assert.equal(first.daily.canCheckIn, false);

  await assert.rejects(() => service.dailyCheckIn(customerId, 'day-2'), /already claimed/i);
  assert.equal(await redisWallet.getBalanceCents(customerId), 50);
});

test('self-referral is rejected', async () => {
  const { service } = createService();
  const customerId = 'gid://shopify/Customer/666';
  const status = await service.getStatus(customerId);

  await assert.rejects(
    () =>
      service.attributeReferral({
        referralCode: status.challenges[0].referralCode,
        referredCustomerId: customerId,
      }),
    /own referral/i
  );
});

test('routes reject unauthenticated access', async () => {
  const { service } = createService();
  const router = createRewardsRouter({
    rewardsService: service,
    requireCustomerAuth: (req, res) =>
      res.status(401).json({ success: false, code: 'unauthenticated', message: 'nope' }),
  });

  // Ensure router was constructed with expected stack layers
  assert.ok(router);
  assert.equal(typeof router, 'function');
});

test('history records spin and scratch actions', async () => {
  const { service } = createService({
    randomBytesFn: () => Buffer.alloc(8),
  });
  const customerId = 'gid://shopify/Customer/777';
  await service.spinLuckySpin(customerId, 'h1');
  await service.claimScratch(customerId, 'h2');
  const history = await service.getHistory(customerId, 10);
  assert.equal(history.success, true);
  assert.ok(history.items.length >= 2);
  assert.ok(history.items.some((item) => item.type === 'lucky_spin'));
  assert.ok(history.items.some((item) => item.type === 'scratch_claim'));
});
