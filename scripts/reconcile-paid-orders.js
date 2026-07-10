require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { createRedisClient } = require('../storage/redis-collection');

const APPLY = process.argv.includes('--apply');
const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const NAMESPACE = String(process.env.REDIS_NAMESPACE || 'nood').trim() || 'nood';

function getArg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

function redact(value) {
  const raw = String(value || '');
  if (!raw) return '';
  return raw.length <= 10 ? '[redacted]' : `${raw.slice(0, 5)}...[redacted]`;
}

async function main() {
  if (!REDIS_URL) {
    throw new Error('REDIS_URL is required.');
  }

  const providerFilter = getArg('provider').toLowerCase();
  const paymentIdFilter = getArg('payment-id');
  const limit = Math.min(Math.max(Number(getArg('limit') || 50), 1), 250);
  const redis = createRedisClient(REDIS_URL);
  await redis.connect();

  const indexKey = `${NAMESPACE}:storage:paymentRecords:__index`;
  const keys = await redis.smembers(indexKey);
  const summary = {
    mode: APPLY ? 'apply' : 'dry-run',
    scanned: 0,
    candidates: 0,
    requiresManualProviderVerification: 0,
    applyBlocked: APPLY,
    records: [],
  };

  for (const key of keys) {
    if (summary.scanned >= limit) break;
    const raw = await redis.get(`${NAMESPACE}:storage:paymentRecords:${key}`);
    if (!raw) continue;
    summary.scanned += 1;

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }

    const provider = String(record.provider || '').toLowerCase();
    const status = String(record.status || '').toLowerCase();
    const paymentId = String(record.paymentId || record.paymentKey || key);

    if (providerFilter && provider !== providerFilter) continue;
    if (paymentIdFilter && paymentId !== paymentIdFilter) continue;
    if (!['payment_received_order_review', 'requires_reconciliation', 'provider_confirmed'].includes(status)) {
      continue;
    }

    summary.candidates += 1;
    summary.requiresManualProviderVerification += 1;
    summary.records.push({
      paymentId: redact(paymentId),
      provider,
      status,
      orderId: redact(record.orderId),
      transactionId: redact(record.transactionId),
      action: APPLY
        ? 'blocked_provider_verification_not_implemented'
        : 'dry_run_provider_verification_required',
    });
  }

  await redis.quit();
  console.log(JSON.stringify(summary, null, 2));
  if (APPLY) {
    console.log('Apply mode is intentionally blocked until PayPal/WiPay verification adapters are wired.');
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error('[reconciliation failed]', error.message);
  process.exit(1);
});
