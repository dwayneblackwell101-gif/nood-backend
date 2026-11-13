// Read-only release smoke check. No orders, payments, tokens or customer records are created.
const base = String(process.argv[2] || process.env.BACKEND_BASE_URL || '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) { console.error('Usage: node scripts/check-live-catalog.js https://your-backend'); process.exit(2); }
async function get(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(30000) });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.errors?.length || body?.success === false) {
    throw new Error(`${path}: HTTP ${response.status}; ${body?.errors?.[0]?.message || body?.error || 'request failed'}`);
  }
  return body;
}
(async () => {
  const health = await get('/health');
  if (health?.ok !== true) throw new Error('Health check did not return ok=true');
  console.log('PASS health');
  const list = await get('/api/catalog/products?first=1');
  const edges = list?.data?.products?.edges;
  if (!Array.isArray(edges)) throw new Error('Product list response has no products connection');
  console.log(`PASS product list (${edges.length} sampled)`);
  const product = edges[0]?.node;
  if (product?.handle) {
    const detail = await get('/api/catalog/products/' + encodeURIComponent(product.handle));
    const node = detail?.data?.product || detail?.data?.productByHandle;
    if (node?.handle !== product.handle) throw new Error('Product detail does not match list');
    if (!node?.variants?.edges?.length) throw new Error('Product detail has no variants');
    console.log(`PASS product detail (${node.variants.edges.length} variants)`);
    await get('/api/catalog/search?q=' + encodeURIComponent(product.title.split(' ')[0]) + '&first=1');
    console.log('PASS search');
  } else {
    throw new Error('No published products available to verify detail and search');
  }
  const collections = await get('/api/catalog/collections?first=1');
  if (!Array.isArray(collections?.data?.collections?.edges)) throw new Error('Collections response has no connection');
  console.log('PASS collections');
  console.log('Catalog read checks passed. Payments, database and customer flows require separate verification.');
})().catch(error => { console.error('FAIL', error.message); process.exitCode = 1; });
