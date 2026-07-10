const crypto = require('crypto');
const { requirePositiveCents } = require('../lib/money');

const WALLET_LUA = `
  local balanceKey = KEYS[1]
  local transactionKey = KEYS[2]
  local transactionListKey = KEYS[3]
  local idempotencyKey = KEYS[4]
  local operation = ARGV[1]
  local amount = tonumber(ARGV[2])
  local record = ARGV[3]
  local transactionId = ARGV[4]

  local existing = redis.call("GET", idempotencyKey)
  if existing then
    return existing
  end

  local previousBalance = tonumber(redis.call("GET", balanceKey) or "0")
  local nextBalance = previousBalance

  if operation == "credit" then
    nextBalance = previousBalance + amount
  elseif operation == "debit" or operation == "reserve" then
    if previousBalance < amount then
      return cjson.encode({ ok = false, error = "insufficient_balance", previousBalance = previousBalance })
    end
    nextBalance = previousBalance - amount
  else
    return cjson.encode({ ok = false, error = "invalid_operation" })
  end

  redis.call("SET", balanceKey, tostring(nextBalance))
  redis.call("SET", transactionKey, record)
  redis.call("LPUSH", transactionListKey, transactionId)

  local result = cjson.encode({
    ok = true,
    operation = operation,
    transactionId = transactionId,
    previousBalance = previousBalance,
    resultingBalance = nextBalance
  })

  redis.call("SET", idempotencyKey, result)
  return result
`;

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function createTransactionId(prefix = 'wallet_tx') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function parseRedisJson(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function createRedisWalletService({ redis, namespace = 'nood' } = {}) {
  if (!redis) {
    return null;
  }

  function balanceKey(customerId) {
    return `${namespace}:wallet:balance:${safeString(customerId)}`;
  }

  function transactionsKey(customerId) {
    return `${namespace}:wallet:transactions:${safeString(customerId)}`;
  }

  function transactionKey(transactionId) {
    return `${namespace}:wallet:transaction:${safeString(transactionId)}`;
  }

  function idempotencyKey(operationKey) {
    return `${namespace}:wallet:idempotency:${safeString(operationKey)}`;
  }

  async function getBalanceCents(customerId) {
    const raw = await redis.get(balanceKey(customerId));
    const cents = Number(raw || 0);
    return Number.isSafeInteger(cents) ? cents : 0;
  }

  async function listTransactions(customerId, limit = 100) {
    const ids = await redis.lrange(transactionsKey(customerId), 0, Math.max(0, Number(limit) || 100) - 1);
    if (!ids.length) return [];

    const pipeline = redis.pipeline();
    ids.forEach((id) => pipeline.get(transactionKey(id)));
    const rows = await pipeline.exec();
    return rows.map((row) => parseRedisJson(row?.[1])).filter(Boolean);
  }

  async function applyWalletOperation({
    customerId,
    type,
    amountCents,
    idempotencyKey: operationKey,
    source = 'backend',
    providerTransactionId = '',
    shopifyOrderId = '',
    refundId = '',
    reservationId = '',
    metadata = {},
  }) {
    const normalizedCustomerId = safeString(customerId);
    const operation = type === 'credit' ? 'credit' : type === 'reserve' ? 'reserve' : 'debit';
    const cents = requirePositiveCents(amountCents, 'wallet amount');
    const transactionId = createTransactionId(`wallet_${operation}`);
    const now = new Date().toISOString();
    const record = {
      transactionId,
      walletTransactionId: transactionId,
      customerId: normalizedCustomerId,
      type,
      operation,
      status: operation === 'reserve' ? 'reserved' : 'confirmed',
      amountCents: operation === 'credit' ? cents : -cents,
      currency: 'USD',
      source,
      providerTransactionId: safeString(providerTransactionId) || null,
      shopifyOrderId: safeString(shopifyOrderId) || null,
      refundId: safeString(refundId) || null,
      reservationId: safeString(reservationId) || null,
      metadata,
      createdAt: now,
      updatedAt: now,
    };

    const raw = await redis.eval(
      WALLET_LUA,
      4,
      balanceKey(normalizedCustomerId),
      transactionKey(transactionId),
      transactionsKey(normalizedCustomerId),
      idempotencyKey(operationKey || transactionId),
      operation,
      String(cents),
      JSON.stringify(record),
      transactionId
    );
    const result = parseRedisJson(raw);

    if (!result?.ok) {
      const error = new Error(result?.error === 'insufficient_balance' ? 'Insufficient wallet balance.' : 'Wallet operation failed.');
      error.statusCode = result?.error === 'insufficient_balance' ? 400 : 500;
      error.code = result?.error || 'wallet_operation_failed';
      throw error;
    }

    return {
      ...record,
      transactionId: result.transactionId || transactionId,
      walletTransactionId: result.transactionId || transactionId,
      previousBalanceCents: result.previousBalance,
      resultingBalanceCents: result.resultingBalance,
      duplicate: result.transactionId !== transactionId,
    };
  }

  return {
    applyWalletOperation,
    credit: (input) => applyWalletOperation({ ...input, type: 'credit' }),
    debit: (input) => applyWalletOperation({ ...input, type: 'debit' }),
    reserve: (input) => applyWalletOperation({ ...input, type: 'reserve' }),
    getBalanceCents,
    listTransactions,
    keys: {
      balanceKey,
      idempotencyKey,
      transactionKey,
      transactionsKey,
    },
  };
}

module.exports = {
  WALLET_LUA,
  createRedisWalletService,
};
