# RC1 Investigation — Homepage Infinite Scroll, Jump, Missing Images

**Mode:** Investigation only — **no code changes**  
**Date:** 2026-07-16  
**Scope:** Homepage product feed (`app/(tabs)/index.tsx`) + catalog API + cache

---

# Issue 1 — Homepage infinite scrolling stops early

## Severity
**High** — users cannot browse full catalog on home.

## Responsibility
**Primarily mobile (pagination / empty-page handling / memory cap)**  
Secondary: **backend list product shape** (sold-out mix) and **mixed-feed skip logic**

## Confidence
**High (~85%)** on primary root causes below.

---

## Execution path (traced)

```
FlatList.onEndReached
  → loadMoreVisibleProducts()
     → if visibleProductCount < filteredProducts.length: reveal more from buffer (no network)
     → else: fetchAndAppendNextHomePage()
        → appendStoreProductsPage(cursor)
           → fetchStoreProductsPage(after, mixKey, session)
              → GET /api/catalog/products?limit=30&first=30&sort=home&after={cursor}&mixKey={n}
                 → loadCatalogProductsForList (mixed path when mixKey present)
                    → loadMixedCatalogProductsPage (scan ordered handles, skip missing/sold-out)
              → mapAllStoreProducts(edges) + filter sold-out again
           → dedupe against allProductsRef
           → capHomeProductsForMemory (MAX 400)
           → setAllProducts / setHasMoreProducts / setNextProductsCursor
```

### Files involved

| Layer | File |
|-------|------|
| Home UI / pagination | `app/(tabs)/index.tsx` |
| Feed fetch / mixKey / cache | `utils/catalog.ts` (`fetchHomeProductFeedPath`) |
| Memory cap | `utils/list-product.ts`, `utils/catalog-cache.ts` |
| Category mix (client) | `utils/homeFeed.ts` |
| Catalog list API | `catalog/routes.js` (`GET /products`, `loadMixedCatalogProductsPage`) |
| Pagination helpers | `catalog/transform.js` (`paginateListProducts`) |
| Sold-out helpers | `utils/list-product.ts` / product availability utils |

---

## Root causes

### RC1-A (Primary) — Empty page after client filters stops pagination permanently

In `fetchStoreProductsPage` (`index.tsx` ~3970–3978):

```ts
if (!products.length) {
  return {
    products: [],
    endCursor: null,
    hasNextPage: false,  // ← forces end-of-list
    failed: true,
  };
}
```

`products` is `mapAllStoreProducts(edges).filter(!soldOut)`.

If a backend page returns edges that all fail mapping or all filter as sold-out, the client **zeros the cursor and sets hasNextPage false**, even when the backend still has further pages.

**Why intermittent:** Depends on which slice of the mixed feed is returned (sold-out density, missing handles, stock changes between syncs).

### RC1-B (Primary) — All-duplicate page advances cursor but does not auto-continue

In `appendStoreProductsPage` (~4093–4101):

- If every product on the page is already in `allProductsRef`, and `hasNextPage` is true, the client **only advances the cursor**.
- It does **not** immediately request the next page.
- `fetchAndAppendNextHomePage` then reports `addedCount: 0` without growing the list.

**Effect:** FlatList `onEndReached` often does **not re-fire** until the user scrolls away and back (list length unchanged → end distance unchanged). Feels like “infinite scroll died.”

**Why intermittent:** More likely after long sessions, refresh reshuffles, or overlapping mixKey/session caches that re-serve overlapping product sets.

### RC1-C (Primary) — Hard in-memory cap of 400 products

`MAX_IN_MEMORY_HOME_PRODUCTS = 400` in `utils/catalog-cache.ts`.  
Every append goes through `capHomeProductsForMemory` → `trimProductsForMemory` → keeps **last 400** only.

- Catalog can be >> 400.
- User can keep paging, but early products drop off; total “seen” set is windowed.
- Combined with RC1-A/B, users often report “stopped before the end” around a few hundred items.

### RC1-D (Secondary) — Mixed feed + dual sold-out filtering

Backend `sort=home` uses `inStockOnly` and skips sold-out while scanning handles (`loadMixedCatalogProductsPage`).  
Client filters sold-out again. If stock flags disagree (stale cache vs live), empty client pages become more likely (feeds RC1-A).

### RC1-E (Secondary) — Session cancellation marks pages as terminal failure

Cancelled feed sessions return `hasNextPage: false` / `failed: true`. Session restarts on refresh/focus paths can abort in-flight load-more and leave cursor state inconsistent until repair runs.

### Not React Query
Homepage does **not** use React Query. State is React `useState` + refs + AsyncStorage caches.

---

## Why not pure backend “no more pages”?

Backend mixed path correctly returns `hasNextPage` / `endCursor` based on handle scan index (`scanIndex < orderedHandles.length`).  
Pagination math is sound. Failures cluster at **client interpretation and continuation**, not missing `pageInfo` fields.

---

## Recommended smallest safe fix (DO NOT IMPLEMENT YET)

1. **Never** set `hasNextPage: false` solely because `products.length === 0` after filter when backend `pageInfo.hasNextPage` is true; instead keep backend cursor and auto-request next page (with a max skip guard).  
2. When append gets only duplicates but `hasNextPage`, **chain** another fetch automatically (bounded, e.g. max 5 consecutive skips).  
3. Optionally raise `MAX_IN_MEMORY_HOME_PRODUCTS` or use windowed virtualization that doesn’t kill hasMore.  
4. Prefer backend as single stock authority for home list (avoid double sold-out filter if list is already inStockOnly).

**Regression risk of fix:** Medium (must avoid infinite skip loops).  
**Effort:** S–M (1–2 days including staging scroll tests).

---

# Issue 2 — Homepage jumping / refreshing

## Severity
**High** — browsing feels unstable; perceived as “refresh.”

## Responsibility
**Primarily mobile** (full list replacement, reshuffle, cache invalidation, FlatList config)  
Secondary: **catalog version bumps** on backend/sync

## Confidence
**High (~80%)** that jumps are multi-factor; top drivers listed.

---

## Root causes

### RC2-A (Primary) — Full `allProducts` array replacement while scrolled

Any of these call `setAllProducts` with a **new array**:

| Trigger | Location | Effect |
|---------|----------|--------|
| `applyHomeProductFeed` | load initial / repair / refresh | Replaces entire list |
| `appendStoreProductsPage` | load more | New array reference (expected, usually append-only) |
| `enrichTrendingFromCatalog` | background enrich | Appends → full state update |
| Failed refresh **reshuffle** | `buildBalancedHomeFeed(snapshot.products, mixKey)` | **Reorders** existing products |

`FlatList` `data={homeListProducts}` is derived from `allProducts` via filter/slice. A reorder or wholesale replace while `contentOffset` is mid-list **jumps the viewport** (same IDs, different indices).

**Intermittent:** Depends on refresh failure path, pull-to-refresh, catalog enrich, and mixKey.

### RC2-B (Primary) — Refresh path reshuffles on failure

On pull-to-refresh failure (~4504–4512):

```ts
const mixedProducts = buildBalancedHomeFeed(snapshot.products, feedMixKeyRef.current);
applyHomeProductFeed(mixedProducts, snapshot.nextCursor, snapshot.hasMore);
```

This **reorders** the previous feed with a new mix seed while the user may still be scrolled down → large visual jump.

### RC2-C (Primary) — Catalog version change wipes home caches mid-session

`fetchHomeProductFeedPath` calls `peekCatalogFreshness('home-feed')` (background) and also updates stored version after fetch.

`peekCatalogFreshness` → `runCatalogVersionCheck(..., refreshOnChange: true)` → on version bump:

`invalidateStaleCatalogCaches()` **deletes** including:

- `HOME_PRODUCTS_CACHE_KEY`
- product feed memory map
- collection product caches

When a Shopify catalog sync increments version, next feed operations can miss cache and re-fetch; combined with loadInitialFeed / repair, list can reset or reshuffle.

**Intermittent:** Only when catalog version changes (sync/webhook).

### RC2-D — Two-tier visibility (buffer reveal)

Home does not render full `allProducts`. It renders:

```ts
visibleProducts = filteredProducts.slice(0, visibleProductCount)
```

`onEndReached` first increases `visibleProductCount` by 30, then fetches.  
When network append lands, `setVisibleProductCount` can jump to `afterCount` (~4707–4709), changing list length in one frame → scroll offset can shift with `numColumns={2}`.

### RC2-E — Android `removeClippedSubviews` + aggressive virtualization

```ts
removeClippedSubviews={HOME_LIST_REMOVE_CLIPPED_SUBVIEWS} // true on Android
initialNumToRender={8}
windowSize={5}
maxToRenderPerBatch={8}
```

Known RN FlatList issue: recycling + clipped subviews causes **item flash / position jump** during rapid append or when item heights change (images loading).

### RC2-F — Header / image height layout shifts

Product cards use ExpoImage without fixed aspect lock from width/height always applied to layout. Late image layout can change row height → list reflow → jump.

### RC2-G — Not React Query invalidation

No React Query. “Refresh” feel comes from local state replacement + RefreshControl + DeviceEventEmitter `refreshHome`.

---

## Files involved

| File | Role |
|------|------|
| `app/(tabs)/index.tsx` | FlatList, load more, refresh, enrich, visible window |
| `utils/homeFeed.ts` | `buildBalancedHomeFeed` reorder |
| `utils/catalog.ts` | version check, cache invalidation, feed fetch |
| `utils/catalog-cache.ts` | home cache keys / trim |
| Backend catalog sync | increments catalog version (trigger for RC2-C) |

---

## Recommended smallest safe fix (DO NOT IMPLEMENT YET)

1. On failed refresh: **restore snapshot order**, never reshuffle in place.  
2. On successful refresh: keep scroll position (`maintainVisibleContentPosition` / scrollToOffset after apply) or only replace when at top.  
3. Do not run `refreshOnChange` cache wipe during active home scroll; defer invalidation to next cold start or pull-to-refresh.  
4. Append-only updates: avoid full-array rebuild when possible (`FlashList` maintainVisibleContentPosition).  
5. Android: test with `removeClippedSubviews={false}` for home only.  
6. Lock card image aspect ratio (fixed height) to stop layout thrash.

**Regression risk:** Medium.  
**Effort:** M (2–3 days with device testing).

---

# Issue 3 — Missing main product images

## Severity
**High** — product discovery / conversion impact.

## Responsibility
**Primarily backend list serialization** (`toStorefrontListProduct`)  
Secondary: **mobile mapping only uses `featuredImage`**  
Tertiary: Shopify source data / sync (products truly without media)

## Confidence
**High (~90%)** for list API missing image fallback chain.

---

## Execution path

```
Shopify Admin product
  → transformAdminProduct (featuredImage OR images[0])
  → cache compact
  → GET /api/catalog/products list
  → toStorefrontListProduct(product)  // featuredImage only
  → home mapAllStoreProducts: edge.node.featuredImage?.url
  → getHomeListImageUrl / ExpoImage
```

### Files involved

| File | Role |
|------|------|
| `catalog/transform.js` | `transformAdminProduct`, `toStorefrontListProduct`, `compactProductForCache` |
| `catalog/routes.js` | list products, `buildProductGalleryImages` (detail only) |
| `catalog/shopify.js` | GraphQL fields: featuredImage, images, media |
| `app/(tabs)/index.tsx` | `mapAllStoreProducts` uses only `featuredImage` |
| `utils/list-product.ts` | `getHomeListImageUrl` (placeholder if empty) |
| Product detail path | `formatCachedProductDetail` has full gallery fallback (not used on home) |

---

## Root causes

### RC3-A (Primary) — List DTO drops image fallbacks

`toStorefrontListProduct` (`transform.js` ~383–404):

```js
const featuredImage = product?.featuredImage?.url
  ? { url: product.featuredImage.url, ... }
  : null;
// No fallback to images.edges[0]
// No fallback to media MediaImage
```

Compare **product detail** path `buildProductGalleryImages` in `routes.js`, which falls back:

1. `images.edges`  
2. `media.edges`  
3. `thumbnail` / `featuredImage`

Home never gets that chain.

### RC3-B (Primary) — Home mapper only reads featuredImage

```ts
image: getOptimizedImageUrl(edge.node.featuredImage?.url),
```

Even if backend later sent `images`, home would ignore them without a mapper change.

### RC3-C — Admin transform may leave featuredImage null when only media exists

`transformAdminProduct` sets:

- `featuredImage` from Admin `featuredImage` **or** `images.edges[0]`
- Does **not** set featuredImage from first `media` MediaImage if `images` is empty

Products that only have MediaImage nodes (or featured image unset in Admin) can be stored with `featuredImage: null` and empty/partial `images` after compact.

### RC3-D — Placeholder vs true blank

`getHomeListImageUrl('')` returns `via.placeholder.com` URL.  
If that host is blocked, slow, or fails offline → **blank** card.  
Real missing Shopify CDN URL after `?width=360` can also 404.

### RC3-E — Not mainly Expo Image lazy load

ExpoImage is used with memory-disk cache and placeholder. Systematic “some products” missing points to **missing URL in data**, not virtualization alone (though recycling can briefly flash blank while loading).

---

## Why intermittent / partial

- Only products without `featuredImage.url` in cached catalog show blank.  
- After catalog re-sync, image presence can change.  
- Different products from different Shopify import paths (media-only vs images).

---

## Recommended smallest safe fix (DO NOT IMPLEMENT YET)

**Backend (preferred single source of truth):**  
In `toStorefrontListProduct` (and optionally `transformAdminProduct`), set featured image using the same chain as `buildProductGalleryImages`:

1. `featuredImage.url`  
2. first `images.edges[].node.url`  
3. first MediaImage / previewImage from `media`  
4. else null  

**Mobile (defense in depth):**  
In `mapAllStoreProducts`, resolve image from `featuredImage` → `images.edges[0]` → media if present.

**Do not** rely on via.placeholder.com for production.

**Regression risk:** Low.  
**Effort:** S (half day + sample product audit).

---

# Summary table

| Issue | Root cause (short) | Layer | Severity | Effort |
|-------|--------------------|-------|----------|--------|
| **1 Infinite scroll** | Empty/filter page forces `hasNextPage=false`; duplicate pages don’t auto-continue; 400 in-memory cap | Mobile (+ stock dual-filter) | High | S–M |
| **2 Jump / refresh** | Full list replace + failure reshuffle + catalog version cache wipe + FlatList recycle/layout | Mobile (+ catalog version) | High | M |
| **3 Missing images** | List API `toStorefrontListProduct` only exports `featuredImage`; home maps only that field | Backend list (+ mobile map) | High | S |

---

# Cross-cutting notes

- **No React Query** on home feed.  
- **No FlashList** on main product grid (plain `FlatList`, 2 columns).  
- Backend mixed feed pagination is fundamentally sound; client continuation logic is the weak link for Issue 1.  
- Image detail API already has correct fallbacks; list API does not — classic SSoT gap.

---

# Approval gate

Per RC1 freeze and investigation instructions:

**No fixes implemented.**  
Await approval before any patch PR.

Suggested fix order if approved:

1. Issue 3 (image fallback) — low risk, high user impact  
2. Issue 1 (pagination continuation + empty-page) — medium risk  
3. Issue 2 (no reshuffle on failed refresh; defer cache wipe while scrolled) — medium risk  
