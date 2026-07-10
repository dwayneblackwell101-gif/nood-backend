require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { createRedisClient } = require('../storage/redis-collection');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const NAMESPACE = String(process.env.REDIS_NAMESPACE || 'nood').trim() || 'nood';

const FILES = [
  { file: 'pending-orders.json', keyField: 'orderId', prefix: `${NAMESPACE}:storage:pendingOrders:` },
  { file: 'payment-records.json', keyField: 'paymentKey', prefix: `${NAMESPACE}:storage:paymentRecords:` },
  { file: 'failed-paid-orders.json', keyField: 'recoveryId', prefix: `${NAMESPACE}:storage:failedPaidOrders:` },
  { file: 'refund-requests.json', keyField: 'request_id', prefix: `${NAMESPACE}:storage:refundRequests:` },
  { file: 'wallet-transactions.json', keyField: 'walletTransactionId', prefix: `${NAMESPACE}:storage:walletTransactions:` },
  { file: 'push-tokens.json', keyField: 'token', prefix: `${NAMESPACE}:storage:pushTokens:` },
];

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function redact(value) {
  const raw = String(value || '');
  if (!raw) return '';
  return raw.length <= 8 ? '[redacted]' : `${raw.slice(0, 4)}...[redacted]`;
}

function validateRecord(row, file) {
  const issues = [];
  if (file === 'wallet-transactions.json') {
    const currency = String(row.currency || '').toUpperCase();
    if (currency && currency !== 'USD') issues.push(`legacy_currency_${currency}`);
    if (!currency) issues.push('missing_currency');
  }
  return issues;
}

async function main() {
  if (!REDIS_URL) {
    throw new Error('REDIS_URL is required for migration.');
  }

  const redis = createRedisClient(REDIS_URL);
  await redis.connect();

  const summary = {
    mode: APPLY ? 'apply' : 'dry-run',
    migrated: 0,
    skippedExisting: 0,
    invalid: 0,
    files: [],
  };

  for (const config of FILES) {
    const filePath = path.join(ROOT, config.file);
    const rows = safeReadJson(filePath);
    const fileSummary = { file: config.file, rows: rows.length, migrated: 0, skippedExisting: 0, invalid: 0 };
    const indexKey = `${config.prefix}__index`;

    for (const row of rows) {
      const key = row?.[config.keyField];
      const issues = validateRecord(row, config.file);
      if (!key || issues.length) {
        fileSummary.invalid += 1;
        summary.invalid += 1;
        console.log('[migration review]', {
          file: config.file,
          key: redact(key),
          issues,
        });
        continue;
      }

      const recordKey = `${config.prefix}${String(key)}`;
      const exists = await redis.exists(recordKey);
      if (exists) {
        fileSummary.skippedExisting += 1;
        summary.skippedExisting += 1;
        continue;
      }

      if (APPLY) {
        await redis.multi().set(recordKey, JSON.stringify(row)).sadd(indexKey, String(key)).exec();
      }

      fileSummary.migrated += 1;
      summary.migrated += 1;
    }

    summary.files.push(fileSummary);
  }

  await redis.quit();
  console.log(JSON.stringify(summary, null, 2));
  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to write records to Redis.');
  }
}

main().catch((error) => {
  console.error('[migration failed]', error.message);
  process.exit(1);
});
