const assert = require('node:assert/strict');
const test = require('node:test');
const {
  transformStorefrontProduct,
  compactProductForCache,
  buildProductGalleryImages,
} = require('../catalog/transform');

test('storefront transform keeps variants and does not force sold-out when product AFS omitted', () => {
  const node = {
    id: 'gid://shopify/Product/1',
    handle: 'tee',
    title: 'Tee',
    // availableForSale intentionally omitted
    images: {
      edges: [
        { node: { url: 'https://cdn.example/1.jpg' } },
        { node: { url: 'https://cdn.example/2.jpg' } },
        { node: { url: 'https://cdn.example/3.jpg' } },
      ],
    },
    media: { edges: [] },
    variants: {
      edges: [
        {
          node: {
            id: 'v1',
            title: 'M',
            availableForSale: true,
            quantityAvailable: 4,
            selectedOptions: [{ name: 'Size', value: 'M' }],
            price: { amount: '20.00', currencyCode: 'USD' },
          },
        },
        {
          node: {
            id: 'v2',
            title: 'L',
            availableForSale: true,
            quantityAvailable: 2,
            selectedOptions: [{ name: 'Size', value: 'L' }],
            price: { amount: '20.00', currencyCode: 'USD' },
          },
        },
      ],
    },
  };

  const product = transformStorefrontProduct(node);
  assert.equal(product.availableForSale, true);
  assert.equal(product.variants.edges.length, 2);
  assert.equal(buildProductGalleryImages(product).length, 3);

  const compact = compactProductForCache({ ...product, status: 'ACTIVE' });
  assert.equal(compact.availableForSale, true);
  assert.equal(compact.variants.edges.length, 2);
  assert.ok(compact.images.edges.length >= 3);
});

test('compact refuses to mark sold out when variants are for sale', () => {
  const product = {
    id: 'gid://shopify/Product/2',
    handle: 'hoodie',
    title: 'Hoodie',
    status: 'ACTIVE',
    availableForSale: false, // poisoned product flag
    images: { edges: [{ node: { url: 'https://cdn.example/a.jpg' } }] },
    media: { edges: [] },
    variants: {
      edges: [
        {
          node: {
            id: 'v1',
            title: 'Default',
            availableForSale: true,
            quantityAvailable: 9,
            price: { amount: '40.00', currencyCode: 'USD' },
            selectedOptions: [],
          },
        },
      ],
    },
  };
  const compact = compactProductForCache(product);
  assert.equal(compact.availableForSale, true);
  assert.equal(compact.variants.edges.length, 1);
});
