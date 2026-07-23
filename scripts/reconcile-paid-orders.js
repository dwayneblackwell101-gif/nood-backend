require('../config/env').loadEnv();

const fs = require('fs');
const { createStorage } = require('../storage');
const { createRedisLockService } = require('../storage/redis-lock');
const { createPaymentStateService } = require('../payments/payment-state');
const { createPayPalReconciliationService } = require('../payments/reconciliation-service');
const { verifyPayPalPayment } = require('../payments/paypal-verification');
const { getPayPalOrder, hasPayPalCredentials } = require('../paypal');

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function redact(value) {
  const raw = String(value || '');
  if (!raw) return '';
  return raw.length <= 12 ? '[redacted]' : `${raw.slice(0, 6)}...[redacted]`;
}

function loadFixture(file) {
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sanitize(result = {}) {
  return {
    status: result.status,
    recoveryId: redact(result.recoveryId || result.reconciliation?.recoveryId),
    paymentId: redact(result.paymentId || result.reconciliation?.paymentId),
    shopifyOrderId: result.shopifyOrderId || result.shopifyOrder?.id || '',
    reason: result.reason || result.verification?.reason || '',
    verificationStatus: result.verification?.status || '',
  };
}

async function main() {
  const apply = hasFlag('--apply');
  const confirmed = hasFlag('--confirm-production-reconciliation');
  const provider = String(arg('provider', 'paypal')).toLowerCase();
  const paymentIdFilter = arg('payment-id');
  const recoveryIdFilter = arg('recovery-id');
  const fixture = loadFixture(arg('fixture'));
  const limit = Math.min(Math.max(Number(arg('limit') || process.env.RECONCILIATION_MAX_BATCH_SIZE || 50), 1), Number(process.env.RECONCILIATION_MAX_BATCH_SIZE || 50));

  if (provider !== 'paypal') {
    if (apply) throw new Error('Apply mode supports provider=paypal only. WiPay is not processed automatically.');
  }
  if (apply && !confirmed) throw new Error('Apply mode requires --confirm-production-reconciliation.');
  if (apply && process.env.NODE_ENV === 'test') throw new Error('Reconciliation apply mode is not allowed in NODE_ENV=test.');
  if (apply && !hasPayPalCredentials()) throw new Error('PayPal credentials are required for reconciliation apply mode.');

  const storage = fixture ? null : createStorage();
  if (storage?.ready) await storage.ready;
  if (apply && !storage?.redis) throw new Error('Redis is required for reconciliation apply mode.');

  const records = fixture?.records || (storage ? Array.from(storage.failedPaidOrders.items.values()) : []);
  const paymentRecords = fixture?.payments || [];
  const redis = storage?.redis || null;
  const paymentState = fixture
    ? {
        getPayment: async (id) => paymentRecords.find((record) => record.paymentId === id) || null,
        getByProviderTransaction: async (_provider, id) =>
          paymentRecords.find((record) => record.providerOrderId === id || record.providerTransactionId === id) || null,
        transitionPayment: async (_id, _state, patch) => ({ ...patch }),
      }
    : createPaymentStateService({ redis, namespace: process.env.REDIS_NAMESPACE || 'nood' });
  const lockService = fixture
    ? { withLock: async (_key, _ttl, fn) => fn() }
    : createRedisLockService({ redis, namespace: process.env.REDIS_NAMESPACE || 'nood' });
  const reconciliationRecords = fixture ? new Map() : storage.reconciliationRecords;
  const service = createPayPalReconciliationService({
    paymentState,
    lockService,
    reconciliationRecords,
    failedPaidOrders: fixture ? new Map(records.map((record) => [record.recoveryId, record])) : storage.failedPaidOrders.items,
    paypalVerifier: {
      verify: (input) => verifyPayPalPayment({
        ...input,
        paypalClient: fixture
          ? { getOrder: async () => fixture.paypalOrder }
          : { getOrder: getPayPalOrder },
      }),
    },
    shopifyLookup: async () => fixture?.shopifyLookup || { found: false },
    createShopifyOrder: async () => {
      if (!apply) throw new Error('dry_run_no_mutation');
      if (fixture) return fixture.shopifyOrder || { id: 'gid://shopify/Order/test', name: '#TEST' };
      throw new Error('CLI apply Shopify order creation is disabled; use admin recovery route for apply.');
    },
    getCatalogCache: async () => fixture?.catalogCache || { getAllProducts: async () => fixture?.products || [] },
    expectedMerchantId: process.env.PAYPAL_MERCHANT_ID || '',
    lockTtlSeconds: Number(process.env.RECONCILIATION_LOCK_TTL_SECONDS || 120),
  });

  const summary = { mode: apply ? 'apply' : 'dry-run', scanned: 0, results: [] };
  for (const record of records) {
    if (summary.scanned >= limit) break;
    if (provider && String(record.provider || '').toLowerCase() !== provider) continue;
    if (recoveryIdFilter && record.recoveryId !== recoveryIdFilter) continue;
    if (paymentIdFilter && record.paymentId !== paymentIdFilter) continue;
    summary.scanned += 1;
    const result = await service.reconcileRecovery({ recoveryRecord: record, apply, actor: 'cli' });
    summary.results.push(sanitize({ ...result, recoveryId: record.recoveryId }));
  }

  const auditFile = arg('audit-file');
  if (auditFile) fs.writeFileSync(auditFile, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error('[reconciliation failed]', error.message);
  process.exit(1);
});
