const fs = require('fs');
const path = require('path');

const STORAGE_DRIVER = String(process.env.STORAGE_DRIVER || 'json').trim().toLowerCase();

// Local development storage only. These JSON files are convenient for testing,
// but production should use a database-backed implementation behind this same
// collection interface so payment state survives deploys and concurrent writes.
class JsonCollection {
  constructor({ name, fileName, keyField }) {
    this.name = name;
    this.filePath = path.join(__dirname, fileName);
    this.keyField = keyField;
    this.items = new Map();
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return;
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows)) return;

      for (const row of rows) {
        const key = row?.[this.keyField];
        if (key) this.items.set(String(key), row);
      }
    } catch (error) {
      console.error(`[NOOD storage] failed to load ${this.name}:`, error.message);
    }
  }

  persist() {
    const rows = Array.from(this.items.values());
    fs.writeFileSync(this.filePath, JSON.stringify(rows, null, 2));
  }

  get(key) {
    return this.items.get(String(key));
  }

  has(key) {
    return this.items.has(String(key));
  }

  set(key, value) {
    this.items.set(String(key), value);
    this.persist();
    return value;
  }

  delete(key) {
    const changed = this.items.delete(String(key));
    if (changed) this.persist();
    return changed;
  }

  values() {
    return Array.from(this.items.values());
  }

  entries() {
    return Array.from(this.items.entries());
  }
}

function createStorage() {
  if (STORAGE_DRIVER !== 'json') {
    throw new Error(
      `Unsupported STORAGE_DRIVER "${STORAGE_DRIVER}". TODO: add a database driver that implements the JsonCollection interface.`
    );
  }

  return {
    pendingOrders: new JsonCollection({
      name: 'pending orders',
      // Local development only: pending-orders.json.
      fileName: 'pending-orders.json',
      keyField: 'orderId',
    }),
    failedPaidOrders: new JsonCollection({
      name: 'failed paid orders',
      // Local development only: failed-paid-orders.json.
      fileName: 'failed-paid-orders.json',
      keyField: 'recoveryId',
    }),
    paymentRecords: new JsonCollection({
      name: 'payment records',
      // Local development only: payment-records.json.
      fileName: 'payment-records.json',
      keyField: 'paymentKey',
    }),
    walletTransactions: new JsonCollection({
      name: 'wallet transactions',
      // Local development only: wallet-transactions.json.
      fileName: 'wallet-transactions.json',
      keyField: 'walletTransactionId',
    }),
  };
}

module.exports = {
  createStorage,
  STORAGE_DRIVER,
};
