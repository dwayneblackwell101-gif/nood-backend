require('../config/env').loadEnv();

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getAdminApiKey() {
  return trim(process.env.NOOD_ADMIN_API_KEY) || trim(process.env.ADMIN_API_KEY);
}

function getAdminHeaders() {
  const key = getAdminApiKey();
  if (!key) {
    throw new Error('NOOD_ADMIN_API_KEY or ADMIN_API_KEY is missing in .env');
  }

  const headers = {
    'Content-Type': 'application/json',
  };

  if (trim(process.env.NOOD_ADMIN_API_KEY)) {
    headers['x-nood-admin-api-key'] = trim(process.env.NOOD_ADMIN_API_KEY);
  } else {
    headers['x-admin-key'] = trim(process.env.ADMIN_API_KEY);
  }

  return headers;
}

function getBaseUrl() {
  const configured = trim(process.env.BACKEND_BASE_URL);
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const port = trim(process.env.PORT) || '3000';
  const host = trim(process.env.LOCAL_IP) || '127.0.0.1';
  return `http://${host}:${port}`;
}

async function requestJson(method, route, options = {}) {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${route}`;
  const response = await fetch(url, {
    method,
    headers: options.headers || {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.message || data?.error || `${method} ${route} failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

async function runReady() {
  const data = await requestJson('GET', '/ready');
  printJson(data);
}

async function runSyncStatus() {
  const data = await requestJson('GET', '/api/sync/shopify/products/status');
  printJson(data);
}

async function runSync() {
  const restart = process.argv.includes('--restart');
  const route = restart
    ? '/api/sync/shopify/products?restart=1&pages=250&pageSize=50'
    : '/api/sync/shopify/products?pages=250&pageSize=50';
  const data = await requestJson('POST', route, {
    headers: getAdminHeaders(),
    body: restart ? { restart: true, pages: 250, pageSize: 50 } : { pages: 250, pageSize: 50 },
  });
  printJson(data);
}

async function main() {
  const command = trim(process.argv[2]) || 'ready';

  try {
    if (command === 'ready') {
      await runReady();
      return;
    }

    if (command === 'sync') {
      await runSync();
      return;
    }

    if (command === 'sync:status') {
      await runSyncStatus();
      return;
    }

    if (command === 'sync:restart') {
      process.argv.push('--restart');
      await runSync();
      return;
    }

    if (command === 'collections:rebuild') {
      const data = await requestJson('POST', '/api/catalog/admin/rebuild-collections', {
        headers: getAdminHeaders(),
        body: {},
      });
      printJson(data);
      return;
    }

    throw new Error(
      `Unknown command "${command}". Use ready, sync, sync:restart, sync:status, or collections:rebuild.`
    );
  } catch (error) {
    if (error.data) {
      printJson(error.data);
    } else {
      console.error(error.message || error);
    }
    process.exit(1);
  }
}

void main();
