require('../config/env').loadEnv();

const domain = process.env.SHOPIFY_STORE_DOMAIN;
const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const version = process.env.SHOPIFY_ADMIN_API_VERSION || '2025-10';
const handle = process.argv[2] || '27-37-n-a217-696808';

const query = `
  query ProductStock($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      totalInventory
      variants(first: 10) {
        edges {
          node {
            title
            inventoryQuantity
            inventoryPolicy
          }
        }
      }
    }
  }
`;

async function main() {
  const response = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables: { handle } }),
  });

  const payload = await response.json();
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
