process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '0';
process.env.BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || 'http://127.0.0.1:0';
process.env.SHOPIFY_CURRENCY = 'USD';
process.env.PAYMENT_CURRENCY = 'USD';
process.env.WALLET_CURRENCY = 'USD';
process.env.PAYPAL_ENABLED = 'false';
process.env.WIPAY_ENABLED = 'false';
process.env.LOCAL_STATE_FALLBACK_ENABLED = 'true';
process.env.NOOD_DISABLE_BACKGROUND_WORKERS = 'true';
process.env.NOOD_CATALOG_FORCE_JSON = '1';
process.env.SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'test-store.example';
process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || 'fake_storefront_token';
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || 'fake_admin_token';
process.env.SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN || 'fake_order_admin_token';
process.env.SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'fake_webhook_secret';
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'fake_admin_key';
process.env.NOOD_ADMIN_API_KEY = process.env.NOOD_ADMIN_API_KEY || 'fake_nood_admin_key';

const { startServer } = require('../server');

startServer()
  .then((server) => {
    console.log('[NOOD test startup] started without loading .env or .env.local');
    server.close(() => {
      console.log('[NOOD test startup] closed cleanly');
    });
  })
  .catch((error) => {
    console.error('[NOOD test startup] failed:', error.message);
    process.exit(1);
  });
