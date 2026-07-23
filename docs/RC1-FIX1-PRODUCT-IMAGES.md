# RC1 Fix 1 — Missing Product Images (validated unit)

**Status:** Implemented — **stop before Fix 2**  
**Date:** 2026-07-16  
**Scope:** Shared primary image selection for catalog list responses

---

## Root cause confirmed

List DTO `toStorefrontListProduct` exported only `featuredImage` when already set, with **no** fallback to `images` or `media`.  
Home / categories / search / recommendations consume list `featuredImage` only.

Product detail already had a fuller gallery chain; logic was not shared.

---

## Files changed

| File | Change |
|------|--------|
| `catalog/transform.js` | Added `getImageNodeUrl`, `getImageNodeAlt`, `buildProductGalleryImages`, `resolvePrimaryListImage`; list DTO uses resolver; admin transform + cache compact resolve featuredImage |
| `catalog/routes.js` | Detail gallery uses shared `buildProductGalleryImages`; no duplicated gallery helpers |
| `catalog/recommendations.js` | Recommendation items use `resolvePrimaryListImage` |
| `tests/catalog-primary-image.test.js` | **7** unit tests for fallback order |

---

## Behavior

**List primary image preference:**

1. `featuredImage` when URL present  
2. First valid `images.edges` URL  
3. First valid `media` image / previewImage  
4. `thumbnail`  

**Product detail:** Gallery build order unchanged (images → media → thumbnail/featured). Detail still uses shared `buildProductGalleryImages` (same logic, single SSoT).

**API compatibility:** Response shape unchanged (`featuredImage: { url, width, height, altText } | null`). No new fields required by clients. No extra network requests.

**Caching:** `compactProductForCache` stores resolved `featuredImage` so subsequent list reads do not re-lose the image.

---

## Regression report

| Suite | Result |
|-------|--------|
| `tests/catalog-primary-image.test.js` | **7/7 pass** |
| Full `node --test` | **114/114 pass** |

### Manual / staging verification (recommended before Fix 2)

| Surface | Check |
|---------|--------|
| Homepage | Products that previously blank now show list image after deploy/sync |
| Categories | Collection product cards |
| Search | Search result cards |
| Recommendations | Related / account recs |
| Product detail | Gallery/thumbnails unchanged |

**Note:** Existing in-memory/Redis catalog may still hold products without resolved featuredImage until a catalog re-sync or product rewrite through `compactProductForCache` / transform. List path `toStorefrontListProduct` resolves **at read time** from stored images/media, so a deploy alone fixes list feeds for products that already have images/media in cache.

---

## Performance impact

- O(k) URL scan per product on list serialize (k = small image/media edges already on product)  
- No additional Shopify/API calls  
- Negligible CPU vs network cost of existing list responses  

---

## Remaining risks

| Risk | Level | Mitigation |
|------|-------|------------|
| Products with **no** images/media in Shopify | Low | Still null; expected |
| Client maps only `featuredImage` | Low | Now populated by backend for list |
| Stale client AsyncStorage page cache | Low | Next network fetch picks up resolved featuredImage |
| Video-only media without preview | Low | No image URL available |

---

## Fix 2 not started

Per instructions: **stop after Fix 1 validation**.  
Infinite-scroll and homepage stability fixes wait for approval / next step.
