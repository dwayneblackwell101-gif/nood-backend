const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadEnv, resetEnvForTests } = require('../config/env');

const ORIGINAL_ENV = { ...process.env };

function resetProcessEnv(next = {}) {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV, next);
  resetEnvForTests();
}

function makeTempEnvDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nood-env-test-'));
  fs.writeFileSync(path.join(dir, '.env'), 'NOOD_ENV_FILE_MARKER=from_env\nSHOPIFY_CURRENCY=USD\n');
  fs.writeFileSync(path.join(dir, '.env.local'), 'NOOD_ENV_LOCAL_MARKER=from_env_local\nPAYPAL_ENABLED=true\n');
  return dir;
}

test.afterEach(() => {
  resetProcessEnv();
});

test('NODE_ENV=test does not load .env or .env.local', () => {
  const rootDir = makeTempEnvDir();
  resetProcessEnv({
    NODE_ENV: 'test',
    SHOPIFY_CURRENCY: 'USD',
    PAYMENT_CURRENCY: 'USD',
    WALLET_CURRENCY: 'USD',
  });

  const env = loadEnv({ rootDir, forceReload: true });

  assert.equal(env.NODE_ENV, 'test');
  assert.equal(process.env.NOOD_ENV_FILE_MARKER, undefined);
  assert.equal(process.env.NOOD_ENV_LOCAL_MARKER, undefined);
});

test('production does not load local environment files', () => {
  const rootDir = makeTempEnvDir();
  resetProcessEnv({
    NODE_ENV: 'production',
    SHOPIFY_CURRENCY: 'USD',
    PAYMENT_CURRENCY: 'USD',
    WALLET_CURRENCY: 'USD',
    PAYPAL_ENABLED: 'false',
    WIPAY_ENABLED: 'false',
  });

  loadEnv({ rootDir, forceReload: true });

  assert.equal(process.env.NOOD_ENV_FILE_MARKER, undefined);
  assert.equal(process.env.NOOD_ENV_LOCAL_MARKER, undefined);
});

test('production server config only requires WiPay credentials when WiPay is enabled', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const guard = source.slice(
    source.indexOf('function assertProductionConfig()'),
    source.indexOf('function isValidPositiveMoney')
  );

  assert.match(guard, /const wiPayEnabled =/);
  assert.match(guard, /if \(wiPayEnabled && !WIPAY_ACCOUNT_NUMBER\)/);
  assert.match(guard, /if \(wiPayEnabled && WIPAY_ENVIRONMENT === 'live' && !WIPAY_API_KEY\)/);
});

test('development loads local files without overwriting existing process variables', () => {
  const rootDir = makeTempEnvDir();
  resetProcessEnv({
    NODE_ENV: 'development',
    PAYPAL_ENABLED: 'false',
    SHOPIFY_CURRENCY: 'USD',
    PAYMENT_CURRENCY: 'USD',
    WALLET_CURRENCY: 'USD',
  });

  const env = loadEnv({ rootDir, forceReload: true });

  assert.equal(process.env.NOOD_ENV_FILE_MARKER, 'from_env');
  assert.equal(process.env.NOOD_ENV_LOCAL_MARKER, 'from_env_local');
  assert.equal(env.PAYPAL_ENABLED, false);
});

test('validation errors name variables without exposing secret values', () => {
  resetProcessEnv({
    NODE_ENV: 'development',
    PAYPAL_ENABLED: 'maybe-secret-value',
    SHOPIFY_CURRENCY: 'USD',
    PAYMENT_CURRENCY: 'USD',
    WALLET_CURRENCY: 'USD',
  });

  assert.throws(
    () => loadEnv({ rootDir: makeTempEnvDir(), forceReload: true }),
    (error) => {
      assert.match(error.message, /PAYPAL_ENABLED/);
      assert.equal(error.message.includes('maybe-secret-value'), false);
      return true;
    }
  );
});

test('invalid TTL and unsupported currencies are rejected', () => {
  resetProcessEnv({
    NODE_ENV: 'test',
    PAYMENT_LOCK_TTL_SECONDS: '0',
    SHOPIFY_CURRENCY: 'USD',
    PAYMENT_CURRENCY: 'USD',
    WALLET_CURRENCY: 'USD',
  });
  assert.throws(() => loadEnv({ rootDir: makeTempEnvDir(), forceReload: true }), /PAYMENT_LOCK_TTL_SECONDS/);

  resetProcessEnv({
    NODE_ENV: 'test',
    SHOPIFY_CURRENCY: 'TTD',
    PAYMENT_CURRENCY: 'USD',
    WALLET_CURRENCY: 'USD',
  });
  assert.throws(() => loadEnv({ rootDir: makeTempEnvDir(), forceReload: true }), /SHOPIFY_CURRENCY/);
});

test('importing server does not start listener or background workers', () => {
  resetProcessEnv({
    NODE_ENV: 'test',
    PORT: '0',
    BACKEND_BASE_URL: 'http://127.0.0.1:0',
    SHOPIFY_CURRENCY: 'USD',
    PAYMENT_CURRENCY: 'USD',
    WALLET_CURRENCY: 'USD',
    SHOPIFY_STOREFRONT_ACCESS_TOKEN: 'fake',
    SHOPIFY_WEBHOOK_SECRET: 'fake',
    ADMIN_API_KEY: 'fake',
    NOOD_ADMIN_API_KEY: 'fake',
  });

  const serverModule = require('../server');

  assert.equal(typeof serverModule.app, 'function');
  assert.equal(typeof serverModule.startServer, 'function');
});
