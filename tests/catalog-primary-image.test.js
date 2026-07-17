const assert = require('node:assert/strict');
const test = require('node:test');
const {
  resolvePrimaryListImage,
  toStorefrontListProduct,
  buildProductGalleryImages,
  transformAdminProduct,
  compactProductForCache,
} = require('../catalog/transform');

test('resolvePrimaryListImage prefers featuredImage when present', () => {
  const product = {
    featuredImage: { url: 'https://cdn.example/featured.jpg', width: 100, height: 120 },
    images: { edges: [{ node: { url: 'https://cdn.example/other.jpg' } }] },
    media: {
      edges: [{ node: { __typename: 'MediaImage', image: { url: 'https://cdn.example/media.jpg' } } }],
    },
  };
  const primary = resolvePrimaryListImage(product);
  assert.equal(primary.url, 'https://cdn.example/featured.jpg');
});

test('resolvePrimaryListImage falls back to first images edge', () => {
  const product = {
    featuredImage: null,
    images: {
      edges: [
        { node: { url: '', altText: 'empty' } },
        { node: { url: 'https://cdn.example/gallery.jpg', width: 200, height: 200, altText: 'g' } },
      ],
    },
    media: {
      edges: [{ node: { __typename: 'MediaImage', image: { url: 'https://cdn.example/media.jpg' } } }],
    },
  };
  const primary = resolvePrimaryListImage(product);
  assert.equal(primary.url, 'https://cdn.example/gallery.jpg');
  assert.equal(primary.altText, 'g');
});

test('resolvePrimaryListImage falls back to media image', () => {
  const product = {
    featuredImage: null,
    images: { edges: [] },
    media: {
      edges: [
        {
          node: {
            __typename: 'MediaImage',
            image: { url: 'https://cdn.example/from-media.jpg', width: 50, height: 60 },
          },
        },
      ],
    },
  };
  const primary = resolvePrimaryListImage(product);
  assert.equal(primary.url, 'https://cdn.example/from-media.jpg');
  assert.equal(primary.width, 50);
});

test('resolvePrimaryListImage falls back to media previewImage', () => {
  const product = {
    featuredImage: null,
    images: { edges: [] },
    media: {
      edges: [
        {
          node: {
            __typename: 'Video',
            previewImage: { url: 'https://cdn.example/video-preview.jpg' },
          },
        },
      ],
    },
  };
  const primary = resolvePrimaryListImage(product);
  assert.equal(primary.url, 'https://cdn.example/video-preview.jpg');
});

test('toStorefrontListProduct exports resolved featuredImage for list clients', () => {
  const product = {
    id: 'gid://shopify/Product/1',
    title: 'Test',
    handle: 'test',
    availableForSale: true,
    featuredImage: null,
    images: { edges: [{ node: { url: 'https://cdn.example/list.jpg' } }] },
    media: { edges: [] },
    variants: { edges: [] },
    priceRange: { minVariantPrice: { amount: '10.00', currencyCode: 'USD' } },
  };
  const list = toStorefrontListProduct(product);
  assert.equal(list.featuredImage.url, 'https://cdn.example/list.jpg');
});

test('buildProductGalleryImages merges images then unique media (detail order)', () => {
  const product = {
    featuredImage: { url: 'https://cdn.example/featured.jpg' },
    images: { edges: [{ node: { url: 'https://cdn.example/img1.jpg' } }] },
    media: {
      edges: [{ node: { image: { url: 'https://cdn.example/media.jpg' } } }],
    },
  };
  const gallery = buildProductGalleryImages(product);
  // RC1: images first, then media URLs not already present (never drop media when images exist).
  assert.equal(gallery[0].url, 'https://cdn.example/img1.jpg');
  assert.equal(gallery[1].url, 'https://cdn.example/media.jpg');
  assert.equal(gallery.length, 2);
});

test('RC1 compactProductForCache keeps multi-image gallery and full descriptionHtml', () => {
  const longHtml =
    '<h4>Attribute</h4><p>' +
    'x'.repeat(900) +
    '</p><img src="https://cdn.example/desc.jpg" alt="d" /><p>tail</p>';
  const product = {
    id: 'gid://shopify/Product/100',
    title: 'Multi',
    handle: 'multi-gallery',
    status: 'ACTIVE',
    availableForSale: true,
    descriptionHtml: longHtml,
    featuredImage: { url: 'https://cdn.example/1.jpg' },
    images: {
      edges: [
        { node: { url: 'https://cdn.example/1.jpg' } },
        { node: { url: 'https://cdn.example/2.jpg' } },
        { node: { url: 'https://cdn.example/3.jpg' } },
        { node: { url: 'https://cdn.example/4.jpg' } },
        { node: { url: 'https://cdn.example/5.jpg' } },
      ],
    },
    media: {
      edges: [
        { node: { __typename: 'MediaImage', id: 'm1', image: { url: 'https://cdn.example/1.jpg' } } },
        { node: { __typename: 'MediaImage', id: 'm2', image: { url: 'https://cdn.example/2.jpg' } } },
        { node: { __typename: 'MediaImage', id: 'm3', image: { url: 'https://cdn.example/6.jpg' } } },
      ],
    },
    variants: {
      edges: [
        {
          node: {
            id: 'v1',
            title: 'Default',
            availableForSale: true,
            price: { amount: '10.00', currencyCode: 'USD' },
            selectedOptions: [],
          },
        },
      ],
    },
    collections: { edges: [] },
  };

  const compact = compactProductForCache(product);
  assert.ok(compact);
  assert.equal(compact.images.edges.length, 5, 'must not collapse to CACHE_MAX_IMAGES=1');
  assert.equal(compact.media.edges.length, 3);
  assert.ok(
    compact.descriptionHtml.length > 800,
    'must not truncate descriptionHtml to 800 chars'
  );
  assert.ok(compact.descriptionHtml.includes('<img'), 'must keep description <img> tags');
  assert.equal(buildProductGalleryImages(compact).length, 6);
});

test('transformAdminProduct resolves featuredImage from media when images empty', () => {
  const adminProduct = {
    id: 'gid://shopify/Product/9',
    title: 'Media only',
    handle: 'media-only',
    status: 'ACTIVE',
    featuredImage: null,
    images: { edges: [] },
    media: {
      edges: [
        {
          node: {
            __typename: 'MediaImage',
            id: 'm1',
            image: { url: 'https://cdn.example/admin-media.jpg', width: 10, height: 12 },
          },
        },
      ],
    },
    variants: {
      edges: [
        {
          node: {
            id: 'v1',
            title: 'Default',
            price: '5.00',
            inventoryQuantity: 3,
            inventoryPolicy: 'DENY',
          },
        },
      ],
    },
    collections: { edges: [] },
  };
  const transformed = transformAdminProduct(adminProduct, 'USD');
  assert.equal(transformed.featuredImage.url, 'https://cdn.example/admin-media.jpg');
});
