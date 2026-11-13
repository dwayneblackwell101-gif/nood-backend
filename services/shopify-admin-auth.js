const axios = require('axios');
let cached = null;
let pending = null;
async function getAdminToken() {
  const clientId = String(process.env.SHOPIFY_CLIENT_ID || '').trim();
  const secret = String(process.env.SHOPIFY_CLIENT_SECRET || '').trim();
  if (!clientId || !secret) {
    const legacy = String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '').trim();
    if (!legacy) throw new Error('Shopify Admin credentials are not configured');
    return legacy;
  }
  const domain = String(process.env.SHOPIFY_STORE_DOMAIN || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain)) throw new Error('Invalid Shopify store domain');
  const cacheKey = `${domain}:${clientId}:${secret}`;
  if (cached?.key === cacheKey && cached.expiresAt > Date.now()) return cached.token;
  if (!pending || pending.key !== cacheKey) {
    const promise = (async () => {
      const { data } = await axios.post(`https://${domain}/admin/oauth/access_token`, {
        grant_type: 'client_credentials', client_id: clientId, client_secret: secret,
      }, { timeout: 15000 });
      if (!data?.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 60) {
        throw new Error('Shopify did not return a valid expiring Admin token');
      }
      cached = { key: cacheKey, token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) - 60) * 1000 };
      return cached.token;
    })();
    pending = { key: cacheKey, promise };
    promise.finally(() => { if (pending?.promise === promise) pending = null; }).catch(() => {});
  }
  return pending.promise;
}
function hasAdminCredentials() {
  return Boolean((process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) || process.env.SHOPIFY_ADMIN_ACCESS_TOKEN);
}
module.exports = { getAdminToken, hasAdminCredentials };
