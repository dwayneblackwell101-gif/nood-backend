# RC1 — Global Product Detail Gallery & Description Failure (Backend)

## 1. Exact collapse point

| Item | Value |
|------|--------|
| **File** | `catalog/transform.js` |
| **Function** | `compactProductForCache` |
| **Callers** | `catalog/sync.js` → `saveProductPage`, `syncSingleProduct` |

This is the **first** place every product is reduced from N images to 1 image and full HTML to ~800 characters.

### Why

Production `origin/main` (pre-fix) had:

```js
const CACHE_MAX_IMAGES = 1;
const CACHE_MAX_DESCRIPTION_HTML_CHARS = 800;
const CACHE_MAX_VARIANTS = 20;

// inside compactProductForCache:
images: { edges: imageEdges.slice(0, CACHE_MAX_IMAGES) }  // → 1 image
descriptionHtml: html.slice(0, CACHE_MAX_DESCRIPTION_HTML_CHARS)  // → 800 chars
// media often empty / not fully retained on old compact
```

Introduced in commit `23878fe` (“Fix catalog sync to cache all Shopify products in Redis”) to shrink Redis memory. That made **every** cached product a list-style preview row.

### Downstream (not root cause)

| Stage | Behavior |
|-------|----------|
| Redis / JSON cache | Stores whatever compact wrote (1 image + 800 HTML) |
| `buildProductGalleryImages` | Correctly builds gallery from cache → length 1 |
| `formatCachedProductDetail` / GET `:handle` | Returns cache content (old format lacked `galleryImages`) |
| Mobile | Renders the 1 image the API returns |

**List** mapper `toStorefrontListProduct` is intentionally preview-only (featured image only). It is **not** used for Product Detail. Detail incorrectly used the same over-compacted cache row produced by `compactProductForCache`.

---

## 2. Why cache has 1 image + truncated HTML

1. Shopify Admin fetch returns full `images(first: 30)`, `media(first: 30)`, full `descriptionHtml`.
2. `transformAdminProduct` preserves those fields.
3. **`compactProductForCache` with `CACHE_MAX_IMAGES = 1` and HTML slice 800** discards the rest before `cache.setProduct` / `mergeProducts`.
4. Every subsequent detail read serves that slim row.

Local `catalog-cache.json` (built with higher limits) still has multi-image products — proving Shopify data is fine.

---

## 3. Fix (code)

### A. Stop collapsing on write — `compactProductForCache`

```js
const CACHE_MAX_IMAGES = 30;
const CACHE_MAX_VARIANTS = 250;
// NO descriptionHtml length cap
```

- Keeps up to 30 images + 30 media edges  
- Full `descriptionHtml` (no `slice(0, 800)`)  
- Logs input vs output counts (`[NOOD cache] compactProductForCache`)

### B. Detail API always returns full fields — `formatCachedProductDetail`

Every `GET /api/catalog/products/:handle` response includes:

- `galleryImages`
- `imageUrls`
- `images.edges`
- `media.edges`
- full `descriptionHtml`

### C. Repair existing slim Redis rows — `hydrateThinProductDetail`

If cache gallery ≤ 1 image (or HTML looks truncated ~800 / mid-tag):

1. Fetch Shopify Storefront product detail  
2. Merge richer gallery + longer HTML  
3. Write compact product back to Redis  
4. Return full formatted detail  

So production works **without** waiting for a full catalog re-sync (re-sync still recommended).

### D. Sync instrumentation — `saveProductPage`

Logs `before compactProductForCache` and `before cache write` image/media/html lengths.

### Commits

- `a4cd810` — restore limits + format fields + hydrate  
- (follow-up) — collapse logging + hydrate any `galleryCount <= 1`

---

## 4. Verification

### Unit

`tests/catalog-primary-image.test.js` — compact must keep 5+ images and HTML length > 800.

### Local cache → detail format (8/8 multi)

| Handle | gallery | media | descHtml |
|--------|---------|-------|----------|
| fog-…t-shirt-12 | 8 | 8 | 0 |
| women-s-…pants | 30 | 30 | 8062 |
| glo-gang-17 | 24 | 24 | 0 |
| louis-vuitton-65 | 18 | 18 | 0 |
| nike-air-max-5 | 17 | 17 | 0 |
| gallery-dept-115 | 30 | 30 | 0 |
| new-balance-104 | 12 | 12 | 0 |
| hellstar-80 | 30 | 30 | 0 |

### Production live API (until Render redeploys)

Still returns 1 image / no `galleryImages` / desc 800 — **old process still running**.

GitHub `main` already has `CACHE_MAX_IMAGES = 30`.

**Required:** Manual or automatic Render deploy of `nood-backend` from latest `main`.

Post-deploy checks:

```http
GET /api/catalog/products/fog-fear-of-god-fog-essentials-t-shirt-12
GET /api/catalog/products/women-s-high-waisted-straight-leg-wide-leg-pants
GET /api/catalog/products/glo-gang-17
```

Expect: `galleryImages.length > 1`, `images.edges.length > 1`, `descriptionHtml` can exceed 800, response may include `galleryImages` key. First hit may be `source=cache+shopify` while hydrate rewrites Redis.

Optional: trigger full catalog sync so all products rewrite offline.

---

## 5. Out of scope (unchanged)

Homepage, discovery mixer, infinite scroll, search, recommendations, cards, nav, layout, hero, deals.
