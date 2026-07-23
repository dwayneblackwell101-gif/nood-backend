# RC1 Investigation — Homepage Product Images Load Slowly

**Mode:** Investigation only — **no code changes, no PRs**  
**Date:** 2026-07-16  
**Out of scope:** Fix 1 missing images, Fix 2 infinite scroll, Fix 3 stability (already done)  
**Question:** Why do first-open homepage product images appear much slower than Temu / Amazon / Shein?

---

## Executive summary

**Primary bottleneck is mobile startup + image presentation strategy, not missing image URLs and not Redis/catalog transform latency for a warm backend.**

Cold first paint of product photos is delayed by a **pipeline of serial JS work** before `expo-image` even starts HTTP, then by **suboptimal expo-image settings vs categories**, **late/wrong-target prefetch**, **heavy header competing for bandwidth/CPU**, and **image URLs that are not aggressively optimized** (no format/webp, width-only).

Backend is a **secondary** factor (list JSON still carries unused fields; no list-specific tiny thumb URL). Shopify CDN itself is typically fast once requested.

**Overall confidence:** High (~85%) that the top 5 ranked causes explain most of the perceived gap vs premium apps.

---

## Lifecycle traced (evidence-based)

```
Shopify Admin (sync)
  → catalog/transform.js (featuredImage + images/media)
  → Redis / in-memory catalog cache
  → GET /api/catalog/products?sort=home&first=30&mixKey=…
  → toStorefrontListProduct → featuredImage.url
  → Mobile: getBackendJson / AsyncStorage home cache
  → mapAllStoreProducts → getHomeListImageUrl(url, width=360)
  → FlatList ProductCard mounts
  → expo-image source={uri} cachePolicy=memory-disk transition=80
  → Network + decode + 80ms transition
  → Visible
```

**There is no React Query** on the home product feed. Caching is AsyncStorage + in-memory maps + expo-image disk/memory.

---

# Ranked root causes (by impact on “images appear almost immediately”)

---

## RC-1 — Product image HTTP starts only after cells mount (no above-the-fold prefetch)

**Impact:** Critical  
**Layer:** **Mobile**  
**Confidence:** ~95%

### Evidence

Home product prefetch (`index.tsx` ~5356–5367):

```ts
InteractionManager.runAfterInteractions(() => {
  filteredProducts
    .slice(visibleProductCount, visibleProductCount + HOME_IMAGE_PREFETCH_AHEAD)
    .forEach((item) => {
      if (item.image) {
        ExpoImage.prefetch(item.image); // no cachePolicy; AFTER interactions
      }
    });
});
```

- Prefetch is delayed until **after interactions**.  
- Slice starts at `visibleProductCount` — i.e. products **below** the current window, **not** the first 8–12 on screen.  
- First-screen images rely solely on **lazy mount** of `ProductCard` → `ExpoImage`.

Hero slides **do** prefetch early with `memory-disk` (`prefetchHomeHeroSlides`, ~310–323). Product grid does **not** get the same treatment.

### Why Temu/Shein feel faster

They typically **kick CDN downloads for first N thumbs before or as soon as the list mounts**, often from a prewarmed image cache / native pipeline, not “wait for cell + afterInteractions for the wrong slice.”

### Estimated improvement

**High:** 200–800ms+ earlier first image on cold start if first-screen URLs prefetch in parallel with list mount (device/network dependent).

### Smallest safe fix (do not implement now)

- Prefetch first `initialNumToRender` (or first 12–16) product image URLs **immediately** when first products are known (cache or API), with `ExpoImage.prefetch(url, 'memory-disk')`.  
- Keep ahead-prefetch for below-the-fold separately.

### Risks / RC1-safe?

**RC1-safe** if limited to prefetch only (no UI change). Risk: bandwidth race with hero images — mitigate by prioritizing first-screen product thumbs.

---

## RC-2 — Home `expo-image` configured slower than categories / cart

**Impact:** High  
**Layer:** **Mobile**  
**Confidence:** ~90%

### Evidence

| Surface | File | `transition` | `recyclingKey` | Prefetch policy |
|---------|------|--------------|----------------|-----------------|
| **Home ProductCard** | `index.tsx` ~1078–1085 | **`80`** | **missing** | Product prefetch often no 2nd arg |
| **Categories** | `CategoriesPerf.tsx` ~97–103 | **`0`** | **yes** | Uses optimized helpers |
| **Cart** | `cart.tsx` | **`0`** | **yes** | — |
| **Account recs** | `account.tsx` | **`0`** | **yes** | — |

Home also uses `placeholder={HERO_IMAGE_FALLBACK_SOURCE}` = **full brand splash PNG** (`nood-brand-splash.png`, ~line 292) for **every product card**.

### Why it feels slow

1. **80ms cross-fade** after decode delays “sharp product photo” perception.  
2. **Heavy local splash as placeholder** can cost decode/upload of a large asset × N visible cells before/during remote decode.  
3. **No `recyclingKey`** can cause more thrash when list recycles (secondary).

### Estimated improvement

**Medium–High:** ~80ms per image purely from `transition={0}`; additional tens–hundreds of ms if splash placeholder decode is removed/simplified.

### Smallest safe fix

- Align home with categories: `transition={0}`, light solid `#eee` or tiny blur (already have bg color on wrap), optional `recyclingKey={item.id}`.  
- Optional: `priority="high"` for first row only if expo-image version supports it.

### Risks / RC1-safe?

**RC1-safe** (presentation flags only). Tiny risk of flash without fade.

---

## RC-3 — Startup work is serial: cache/API → map → header → then cells → then images

**Impact:** High  
**Layer:** **Mobile**  
**Confidence:** ~90%

### Evidence — bootstrap order (`index.tsx` ~4889–4923)

Typical cold path:

1. `loadPreparedHomeFromCache()` (AsyncStorage JSON parse of full home product list) **or** wait network  
2. `setAllProducts` / `homeContentReady`  
3. `ListHeaderComponent={scrollableHeader}` mounts (slideshow, lace-front, videos, etc.)  
4. FlatList `initialNumToRender={8}` mounts product cells  
5. Only then product `ExpoImage` requests fire  

If cache miss:

1. `await loadInitialFeed(false)` → network `GET /api/catalog/products?...`  
2. Map edges → products  
3. Then 3–5  

Prefetch of **product** images is further delayed by `InteractionManager.runAfterInteractions` (RC-1).

Also on cache hit:

```ts
InteractionManager.runAfterInteractions(() => {
  void loadInitialFeed(false, { repairPagination: ... });
});
```

and `ensureCatalogFreshness('launch')` in background — more JS/network contention during first seconds.

### Estimated improvement

**High on cold start** if product image URLs from cache are prefetched **in parallel** with header mount, not after first paint + interactions.

### Smallest safe fix

- When cache yields products, immediately `Promise.all(firstN.map(p => ExpoImage.prefetch(p.image, 'memory-disk')))` before/alongside `setHomeContentReady`.  
- Do not block first paint on catalog freshness.

### Risks / RC1-safe?

**RC1-safe**. Risk: slightly more concurrent network vs hero — prioritise product thumbs.

---

## RC-4 — FlatList virtualization limits concurrent image work (by design, but aggressive)

**Impact:** Medium–High for “first screen full of photos”  
**Layer:** **Mobile**  
**Confidence:** ~85%

### Evidence (`index.tsx` ~5881–5885)

```ts
initialNumToRender={8}      // 2 columns → ~4 rows
maxToRenderPerBatch={8}
updateCellsBatchingPeriod={50}
windowSize={5}
```

Only **8** product cells mount initially → at most **8** image requests on first paint (often fewer if list is below a large header).

`HOME_INITIAL_VISIBLE_PRODUCTS = 30` is a **data window**, not render count.

### Estimated improvement

**Medium:** Raising `initialNumToRender` slightly (e.g. 12–16) fills first viewport sooner at modest JS cost. Prefetch (RC-1) is better than bloating render.

### Smallest safe fix

- Keep virtualization; **prefetch** first viewport URLs (RC-1) rather than large `initialNumToRender`.

### Risks / RC1-safe?

**RC1-safe** if only prefetch; changing windowSize needs profiling (Fix 3 already set `removeClippedSubviews={false}`).

---

## RC-5 — Image URL strategy is good for bytes but not “instant commerce” grade

**Impact:** Medium  
**Layer:** **Mobile** (primary) / **Backend** (optional enrichment)  
**Confidence:** ~80%

### Evidence

`getHomeListImageUrl` (`list-product.ts` ~29–46):

- Appends `?width=360` (or replaces width).  
- **No** `format=webp` / `format=pjpg`.  
- **No** device pixel ratio (`width=360` on 3× screens still OK for list, but not optimal).  
- **No** low-res progressive ladder (e.g. 80px blur → 360px).  
- Missing URL falls back to **`via.placeholder.com`** (third-party DNS + TLS on failure path).

Shopify CDN (`cdn.shopify.com`) supports query transforms; code does not use progressive/format helpers in `shopify-image-url.ts` for home list (that util is oriented to gallery/swatch).

Backend list sends full original CDN URL; client resizes via query only after mapping.

### Estimated improvement

**Medium:** WebP/AVIF + correct width can cut transfer 30–60% → faster decode start. Tiny thumb (e.g. 80–120) for placeholder is how many apps feel “instant.”

### Smallest safe fix

- Extend URL helper: `width` + `format=webp` when host is Shopify CDN.  
- Optional second field later: `imageThumb` (not required for RC1 if only query params).

### Risks / RC1-safe?

**RC1-safe** if URL-only. Test older Android WebP via expo-image.

---

## RC-6 — Heavy ListHeader competes with first product images

**Impact:** Medium  
**Layer:** **Mobile**  
**Confidence:** ~80%

### Evidence

- `ListHeaderComponent={scrollableHeader}` includes slideshow, videos (`expo-video`), lace-front sections.  
- Hero images **are** prefetched aggressively (`prefetchHomeHeroSlides`).  
- Product images are **not**.

On first open, bandwidth and decode budget go to **hero + video**, then product cells below the fold on the scrollable content.

### Estimated improvement

**Medium** on first open if product thumbs share priority with (or slightly ahead of) below-the-fold hero assets.

### Smallest safe fix

- Cap concurrent hero prefetches; start product thumb prefetch as soon as product list is known.  
- Defer non-critical video init until after first product images (already partially true for lace videos via scroll offset).

### Risks / RC1-safe?

**RC1-safe** if only scheduling/priority of prefetch, no UI redesign.

---

## RC-7 — Backend list payload still heavier than needed for thumbs-only first paint

**Impact:** Medium (cold API path)  
**Layer:** **Backend**  
**Confidence:** ~75%

### Evidence

`toStorefrontListProduct` (`transform.js` ~520–555) still includes per product:

- `description` (string)  
- `tags` (up to 12)  
- `collections.edges` (up to 10)  
- `variants` (first variant)  
- full `priceRange` / `compareAtPriceRange`  
- `featuredImage` object  

Home only needs: id, handle, title, image URL, price, availability, light category signals.

Larger JSON → slower TLS download + `JSON.parse` + `mapAllStoreProducts` **before** any image URI is known to the UI.

Redis is not the image CDN; it serves product JSON. Latency is “time to first URL,” not image bytes.

### Estimated improvement

**Medium on cold/uncached API:** 50–300ms less to first image request start if list endpoint is slimmer (depends on catalog field sizes).

### Smallest safe fix

- Optional query `?fields=list` or dedicated slim mapper for `sort=home` only (additive, backward compatible default).

### Risks / RC1-safe?

**Mostly RC1-safe** if additive; needs client still accepting current shape. Larger change than mobile prefetch.

---

## RC-8 — Backend image resolution cost is not the bottleneck

**Impact:** Low  
**Layer:** Backend  
**Confidence:** ~90%

### Evidence

`resolvePrimaryListImage` is O(small) over already-loaded product edges. Runs during JSON serialization of cached products. Negligible vs network image download.

Fix 1 made more products **have** a URL; it did **not** make first paint slower in any structural way beyond slightly more valid image requests (which is correct).

### Estimated improvement if “optimized”

**Low** for speed; already fixed correctness.

---

## RC-9 — Cache invalidation / version checks can contend on startup

**Impact:** Low–Medium  
**Layer:** **Mobile**  
**Confidence:** ~70%

### Evidence

On bootstrap, `ensureCatalogFreshness('launch')` runs while home loads. Fix 3 defers **wipe during home-feed**, but launch-scope still can invalidate and compete for AsyncStorage/network.

Image disk cache (`expo-image` memory-disk) is **separate** from catalog AsyncStorage; wiping product list cache does not wipe image disk cache, but forces **new product JSON path** and remount can re-request images if URLs change.

### Estimated improvement

**Low–Medium** if launch freshness is fully deferred until after first images.

### Smallest safe fix

- Defer `ensureCatalogFreshness('launch')` until after first product image prefetch completes.

### Risks / RC1-safe?

**RC1-safe** with care not to serve forever-stale catalog.

---

## RC-10 — Not React Query; not “images blocked by backend Redis”

**Impact:** Clarification  
**Layer:** Architecture  

Home does **not** use React Query. Images are not “waiting on Redis image blobs” — backend returns **URLs** to Shopify CDN. Once the client has URLs, speed is mostly **CDN + decode + when the client starts the request**.

---

# Startup sequence (annotated delays)

| Step | What | Image-related delay |
|------|------|---------------------|
| 1 | App JS boot, tab mount | No product images yet |
| 2 | AsyncStorage home products / showcase read + parse | **Blocks** knowing URLs |
| 3 | Map / setState products | CPU |
| 4 | FlatList + **large header** layout | Cells not mounted yet |
| 5 | `initialNumToRender=8` cells mount | **First image HTTP starts here** |
| 6 | expo-image fetch CDN + decode | Network + CPU |
| 7 | `transition={80}` | Extra **80ms** perceived |
| 8 | `runAfterInteractions` prefetch | Prefetches **wrong slice** (below fold) |

Cold cache miss inserts full API round-trip **before** step 3.

---

# Cache map (what actually caches images)

| Cache | What | Product thumbs? |
|-------|------|-----------------|
| expo-image `memory-disk` | Decoded/HTTP image bytes | **Yes** (after first fetch) |
| AsyncStorage `NOOD_HOME_PRODUCTS_CACHE_V2` | Product JSON + image **URLs** | URLs only |
| In-memory product feed pages | JSON pages | URLs only |
| Redis catalog | Product records | URLs only |
| React Query | **Not used** on home feed | — |

**First open after install:** expo-image disk empty → all thumbs miss → full CDN download.  
Premium apps often ship **disk warm** paths, aggressive prefetch, or tiny inline thumbnails.

---

# Network notes (architecture, not live RUM)

| Factor | Assessment |
|--------|------------|
| Image host | Typically `cdn.shopify.com` (fast CDN) |
| API host | Render backend (catalog JSON) |
| Redirects | Unlikely on Shopify CDN with width query |
| Cache-Control on images | CDN-controlled; client doesn't set |
| Keep-alive | Standard HTTPS |
| Concurrent downloads | Limited by how many `ExpoImage` mounted + OS limits |

**No evidence** of backend proxying image bytes (good). Delay is “when client asks CDN,” not “backend streams pixels.”

---

# Comparison: Temu / Amazon / Shein (loading architecture only)

| Technique | Premium apps (typical) | NOOD home (current) |
|-----------|------------------------|---------------------|
| First-screen thumb prefetch | Aggressive, parallel, before/with paint | **No** (wrong-slice, afterInteractions) |
| Tiny progressive thumb | Common (LQIP / 50–100px) | Single 360px full list image |
| Image format | WebP/AVIF ladder | Width only |
| Placeholder | Solid color / blurhash | **Full brand splash PNG** per card |
| Transition | Often none for grid | **80ms** fade |
| List image field | Minimal payload | List JSON includes tags/collections/description |
| Native list | Optimized FlashList / native | FlatList, conservative batching |
| Header vs grid priority | Product grid often first | Hero **prefetched first** |

They do **not** wait for a perfect catalog story before painting thumbnails.

---

# Ranked impact table

| Rank | Root cause | Layer | Est. impact | RC1-safe? |
|------|------------|-------|-------------|-----------|
| **1** | No first-screen product image prefetch | Mobile | Critical | Yes |
| **2** | `transition={80}` + heavy splash placeholder | Mobile | High | Yes |
| **3** | Serial startup: parse → header → cells → images | Mobile | High | Yes |
| **4** | Only 8 cells initially request images | Mobile | Medium–High | Yes (prefer prefetch) |
| **5** | No WebP/format ladder on Shopify URLs | Mobile (+ optional BE) | Medium | Yes |
| **6** | Hero/header competes for bandwidth | Mobile | Medium | Yes |
| **7** | Fat list JSON delays URL availability | Backend | Medium (cold) | Additive slim optional |
| **8** | Launch freshness contention | Mobile | Low–Medium | Yes |
| **9** | resolvePrimaryListImage cost | Backend | Low | N/A |

---

# Exact files & functions

### Mobile

| File | Functions / sites |
|------|-------------------|
| `app/(tabs)/index.tsx` | `ProductCard` ExpoImage; `getOptimizedImageUrl`; `mapAllStoreProducts`; bootstrap `loadPreparedHomeFromCache` / `loadInitialFeed`; image prefetch effect; FlatList props; `HERO_IMAGE_FALLBACK_SOURCE`; `prefetchHomeHeroSlides` |
| `utils/list-product.ts` | `getHomeListImageUrl`, `HOME_LIST_IMAGE_WIDTH=360`, `slimHomeListProduct` |
| `utils/catalog.ts` | `fetchHomeProductFeedPath`, `getBackendJson` path, cache read/write |
| `utils/catalog-cache.ts` | Home product cache keys, memory trim |
| `utils/shopify-image-url.ts` | CDN helpers **not** used by home list path |
| `components/categories/CategoriesPerf.tsx` | Faster ExpoImage pattern (reference) |

### Backend

| File | Functions |
|------|-----------|
| `catalog/transform.js` | `toStorefrontListProduct`, `resolvePrimaryListImage`, `compactProductForCache` |
| `catalog/routes.js` | `GET /products`, `loadMixedCatalogProductsPage` / list loaders |
| `catalog/shopify.js` | Admin GraphQL image fields (sync-time only) |

---

# Recommended implementation order (when approved)

1. **First-screen product `ExpoImage.prefetch(..., 'memory-disk')`** as soon as product list is known (cache or network).  
2. **Home ProductCard:** `transition={0}`, drop heavy splash placeholder (use solid `#eee`).  
3. **Shopify list URL:** `width` + `format=webp` (and optional DPR).  
4. **Defer non-critical hero/video work** until first N product thumbs prefetched.  
5. **Optional:** slim home list DTO / `fields=list` for cold API.  
6. **Optional:** slightly higher `initialNumToRender` only if profiling still shows empty slots.

---

# What this investigation is **not**

- Not “images missing” (Fix 1).  
- Not infinite scroll stopping (Fix 2).  
- Not jump/reshuffle (Fix 3).  
- Not a recommendation to redesign UI or copy Temu layout.

---

# Final answer

**Why NOOD feels slower:**  
Product image network requests start **late** (after cache/API + header + cell mount), are **not prefetched for the first screen**, and are **presented with a fade + heavy placeholder**, while **hero content is prioritized**. Backend is mostly “URL provider”; the gap vs Temu/Amazon/Shein is **client-side image scheduling and optimization**, not Redis.

**Primary layer:** **Frontend (mobile)**  
**Secondary layer:** Backend list payload size / optional CDN format hints  

**No code was modified in this investigation.**
