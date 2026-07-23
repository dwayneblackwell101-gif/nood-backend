/**
 * Catalog v2 - Root Cause Analysis (Reference Documentation)
 * 
 * This document preserves the root cause analysis of the legacy catalog
 * for reference during v2 development.
 * 
 * Date: 2026-07-23
 * Status: Reference Only - Do Not Implement in Legacy Catalog
 */

# Legacy Catalog Root Cause Analysis

## Executive Summary

The legacy catalog (catalog/) suffered from systematic data loss at every stage of the pipeline:
- **Shopify Admin API**: Queries limited to 30 images, 30 media, 100 variants
- **Sync Engine**: Pagination capped at 250 products (10 pages × 25)
- **Transform Layer**: Silent truncation to 30 images, 250 variants, 800-char HTML
- **Cache**: No validation of completeness
- **API Layer**: Hydration used Storefront API (100 variants) instead of Admin API
- **Product Detail**: Gallery builder dropped media, variant images unmapped

---

## Complete Data Flow Analysis

### 1. Shopify Admin API Queries (catalog/shopify.js)

**Files**: `catalog/shopify.js` lines 188-318

**Limits Found**:
```javascript
// Line 212: images(first: 30)          // Should be 250
// Line 222: media(first: 30)           // Should be 250  
// Line 287: variants(first: 250)       // OK but Storefront uses 100
// Line 338: images(first: 30)          // Should be 250
// Line 348: media(first: 30)           // Should be 250
// Line 413: variants(first: 100)       // Storefront - should be 250
// Line 631: variants(first: 100)       // Recommendations - should be 250
```

**Impact**: Products with >30 images or >30 media files lose data at fetch time.

---

### 2. Sync Engine Pagination (catalog/sync.js)

**Files**: `catalog/sync.js` lines 1304-1306, 1437-1438

**Limits Found**:
```javascript
// Line 1305: const maxPages = Math.max(1, Number(options.maxPages) || 10);
// Line 1306: const pageSize = Math.max(1, Number(options.pageSize) || 25);
// Line 1437: const maxPages = Math.max(1, Number(options.maxPages) || 10);
// Line 1438: const pageSize = Math.max(1, Number(options.pageSize) || 25);
```

**MAX_CHUNK_PAGES** = 50 (line 80), but default only processes 10 pages × 25 = 250 products.

**Impact**: Catalogs with >250 products never fully sync. Our catalog has 5,863 products.

---

### 3. Transform Layer Truncation (catalog/transform.js)

**Files**: `catalog/transform.js` lines 155-157, 166-167, 191

**Constants**:
```javascript
// Line 155: const CACHE_MAX_IMAGES = 30;
// Line 156: const CACHE_MAX_VARIANTS = 250;
// Line 157: const CACHE_MAX_DESCRIPTION_HTML_CHARS = 800;  // Removed but was present
```

**Truncation Logic**:
```javascript
// Line 166: const imageEdges = (product?.images?.edges || []).slice(0, CACHE_MAX_IMAGES);
// Line 167: const mediaEdges = (product?.media?.edges || []).slice(0, CACHE_MAX_IMAGES);
// Line 191: variants: { edges: (product?.variants?.edges || []).slice(0, CACHE_MAX_VARIANTS) }
```

**Impact**: 
- Products with >30 images lose images silently
- Products with >250 variants lose variants silently
- Description HTML was truncated to 800 chars (removed in recent patch)

---

### 4. Product Detail API (catalog/routes.js)

**Files**: `catalog/routes.js` lines 47-89, 270-335

**Issues**:
1. **`isProductDetailCacheThin`** (line 47): Detects truncation but only triggers hydration for single-image products
2. **`hydrateThinProductDetail`** (line 270): Uses Storefront API (`STOREFRONT_PRODUCT_DETAIL_QUERY`) which only returns 100 variants and 30 images
3. **`formatCachedProductDetail`** (line 184): `buildProductGalleryImages` only reads `images.edges` and `media.edges`, missing variant-specific images
4. **`transformStorefrontProduct`** (line 291): Transforms Storefront response which is already truncated

**Impact**: Product detail shows 1 image, missing variants, no variant images.

---

### 5. Hydration Uses Wrong API (catalog/routes.js)

**Lines 270-335**: `hydrateThinProductDetail`

```javascript
const shopifyPayload = await fetchProductDetailFromShopify(handle);
// Uses STOREFRONT_PRODUCT_DETAIL_QUERY (100 variants, 30 images)
const fromShopify = transformStorefrontProduct(storefrontNode);  // Transforms already-truncated data
```

**Correct Approach**: Should use Admin API (`fetchAdminProductById`) for full data, then `transformAdminProduct`.

---

### 6. Variant Images Not Mapped

**Missing**: No code maps variant `selectedOptions` to variant-specific images from `media` edges.

**Shopify Data Model**: Variant images are in `media` edges where `mediaContentType: IMAGE` and can be linked via `selectedOptions` matching.

**Impact**: Even when images exist, variants show generic product images.

---

### 7. Cache Has No Validation

**Files**: `catalog/sync.js` lines 1724-1773

**Missing**:
- No validation that product count matches Shopify
- No validation that variant counts match
- No validation that image counts match
- No validation that descriptionHtml is complete
- No schema version enforcement

**Impact**: Corrupted/incomplete cache served indefinitely.

---

### 8. Missing Health/Validation Endpoints

**Missing**:
- No `/api/catalog/health` comparing cache vs Shopify counts
- No `/api/catalog/validate` for manual validation
- No drift alerts
- No sync completion metrics

---

## Catalog-v2 Migration Plan (Reference)

### Phase 1: Foundation (Week 1-2)
- [ ] ICache abstraction with Redis + Memory implementations
- [ ] Versioned cache with staging/active swap
- [ ] Shopify Admin client with full pagination (250/page, no max pages)
- [ ] Shopify Admin client with 250 images, 250 media, 250 variants

### Phase 2: Transform Layer (Week 2-3)
- [ ] Product transform: Admin API → Domain model (NO truncation)
- [ ] Collection transform: Admin API → Domain model
- [ ] Variant-image mapping via selectedOptions
- [ ] DescriptionHtml preservation (no stripHtml in cache)

### Phase 3: Sync Engine (Week 3-4)
- [ ] ProductSyncService: full pagination, resume, pruning
- [ ] CollectionSyncService: full pagination
- [ ] VersionedCatalogService: staging → validation → activation
- [ ] CatalogValidator: product count, variant count, image count, HTML length

### Phase 4: API Layer (Week 4-5)
- [ ] GET /api/v2/catalog/products (cursor pagination)
- [ ] GET /api/v2/catalog/products/:handle (full variants, images, media)
- [ ] GET /api/v2/catalog/collections
- [ ] GET /api/v2/catalog/collections/:handle/products
- [ ] GET /api/v2/catalog/search
- [ ] GET /api/v2/catalog/health (cache vs Shopify drift)
- [ ] GET /api/v2/catalog/validate (on-demand validation)
- [ ] GET /api/v2/catalog/sync (admin trigger)

### Phase 5: Validation & Monitoring (Week 5)
- [ ] Nightly validation job
- [ ] Drift alerts (cache vs Shopify > 1%)
- [ ] Sync completion metrics
- [ ] Health endpoint for load balancer

### Phase 6: Migration (Week 6)
- [ ] Run both catalogs in parallel
- [ ] Shadow traffic to v2
- [ ] Compare responses
- [ ] Cutover
- [ ] Deprecate legacy catalog

---

## Files to NOT Modify in Legacy Catalog

Per the migration strategy, these files should remain untouched except for critical bug fixes:

| File | Reason |
|------|--------|
| `catalog/sync.js` | Will be replaced by ProductSyncService |
| `catalog/transform.js` | Will be replaced by transform/ module |
| `catalog/routes.js` | Will be replaced by api/ module |
| `catalog/shopify.js` | Will be replaced by shopify/ module |
| `catalog/transform.js` | Will be replaced by transform/ module |
| `catalog/cache/redis-cache.js` | Will be replaced by cache/ module |
| `catalog/collection-aliases.js` | Will be integrated into CollectionSyncService |
| `catalog/feed-mix.js` | Will be replaced by feed service |
| `catalog/recommendations.js` | Will be replaced by recommendations service |

---

## Validation Criteria for v2

Before declaring v2 ready:
- [ ] `v2 cache product count` === `Shopify productsCount`
- [ ] Every product: `v2 variant count` === `Shopify variant count`
- [ ] Every product: `v2 image count` === `Shopify image count`
- [ ] Every product: `v2 descriptionHtml.length` >= `Shopify descriptionHtml.length`
- [ ] Product detail API returns all variants with images
- [ ] Collection products API returns all products
- [ ] Search returns full results
- [ ] Health endpoint shows 0 drift
- [ ] Nightly validation passes for 7 consecutive days

---

*This document is preserved as reference for v2 implementation. Do not implement fixes in legacy catalog.*