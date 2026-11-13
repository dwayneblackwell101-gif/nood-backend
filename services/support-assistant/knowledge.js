const { storefrontGraphql } = require('../../routes/catalog');

function createKnowledgeTools(graphql = storefrontGraphql) {
  return {
    async searchProducts(query) {
      const result = await graphql(`query NoodAIProducts($query: String!) {
        products(first: 5, query: $query) { nodes {
          title handle description availableForSale
          priceRange { minVariantPrice { amount currencyCode } }
          variants(first: 10) { nodes { title availableForSale price { amount currencyCode } } }
        } }
      }`, { query: String(query).trim().slice(0, 160) });
      return (result.data?.products?.nodes || []).map((p) => ({
        title: p.title, handle: p.handle, description: String(p.description || '').slice(0, 1500),
        availableForSale: p.availableForSale, priceRange: p.priceRange, variants: p.variants?.nodes || [],
      }));
    },
    async getSupportPolicies() {
      // Deployment-owned, approved content only. Never accept policies from a chat request.
      try {
        const policies = JSON.parse(process.env.NOOD_AI_POLICIES_JSON || '[]');
        if (!Array.isArray(policies)) return { available: false, policies: [] };
        const approved = policies.slice(0, 8).filter((p) =>
          typeof p.title === 'string' && typeof p.text === 'string' &&
          typeof p.url === 'string' && /^https:\/\/(www\.)?noodcaribbean\.com\//.test(p.url)
        ).map((p) => ({ title: p.title.slice(0, 100), text: p.text.slice(0, 2500), url: p.url }));
        return { available: approved.length > 0, policies: approved };
      } catch { return { available: false, policies: [] }; }
    },
  };
}
module.exports = { createKnowledgeTools };
