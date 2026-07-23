# RC1 Hotfix — Homepage Image Load Speed

**Date:** 2026-07-16  
**Scope:** Investigation-approved RC1-safe image optimizations only  
**UI redesign:** None  
**Backend API contracts:** Unchanged

---

## Files changed

| File | Why |
|------|-----|
| `utils/shopify-image-url.ts` | Added `getShopifyListImageUrl` — width + `format=webp` on Shopify CDN |
| `utils/list-product.ts` | `getHomeListImageUrl` uses list optimizer; exports first-screen prefetch count |
| `app/(tabs)/index.tsx` | First-screen product prefetch, expo-image props, hero yields to product prefetches |

---

## What each change does

### Fix 1 — First-screen prefetch
- Prefetch now includes **visible** products (`slice(0, visibleEnd)`), not only below-the-fold.
- Runs **immediately** (no `InteractionManager` for first screen).
- Dedupe via `homeProductImagePrefetchSeen`.
- Also fires on cache hydrate and `applyHomeProductFeed`.
- Below-fold ahead prefetch still after interactions.

### Fix 2 — expo-image (home product + home collection cards only)
- `transition={0}` (was 80).
- `recyclingKey={id|handle|image}`.
- Removed heavy brand splash `placeholder` (wrap still `#eee` background).
- Layout/styles unchanged (same 230px image area).

### Fix 3 — Shopify URL
- List images request `width` + `format=webp` on `cdn.shopify.com`.
- Non-Shopify URLs still get width only.

### Fix 4 — Priority
- Hero `prefetchHomeHeroSlides` **awaits** first-screen product prefetch promise when both race.
- Hero still loads; product thumbs get priority.

### Fix 5 — Render priority
- Product first-screen prefetch not deferred behind InteractionManager.
- Hero uses `requestAnimationFrame` only (still yields to product promise).

---

## Before vs after sequence

**Before**
```
Products known → FlatList mounts 8 cells → image HTTP starts
Prefetch (after interactions) only targets products AFTER visible window
Hero prefetches aggressively in parallel/earlier
transition 80ms + splash placeholder
```

**After**
```
Products known → prefetch first ~16 product thumbs immediately (memory-disk)
FlatList mounts → images often already in flight/cache
Hero waits for product first-screen prefetch, then prefetches
Below-fold prefetch after interactions
transition 0, light placeholder background, recyclingKey
URLs: width=360&format=webp on Shopify CDN
```

---

## Confirmation

| Requirement | Status |
|-------------|--------|
| No UI redesign / layout / colors / navigation | **Yes** |
| No product card redesign | **Yes** (props only) |
| No backend API redesign | **Yes** |
| No new commerce features | **Yes** |
| Existing caching preserved | **Yes** (expo-image memory-disk + URL dedupe) |

---

## Expected improvement

| Change | Expected |
|--------|----------|
| First-screen prefetch | Hundreds of ms earlier first product photo on warm/cold CDN |
| transition=0 | ~80ms less perceived delay per image |
| Remove splash placeholder | Less decode contention |
| WebP | Smaller payload → faster download/decode |
| Hero after products | More bandwidth for grid thumbs at open |

---

## Performance impact

- Slightly more concurrent image requests at open (first 16 products) — intentional, capped and deduped.
- No extra catalog API calls.
- WebP typically reduces image bytes.

---

## Regression analysis

| Area | Risk |
|------|------|
| Home grid images | Lower (faster path) |
| Hero slideshow | Starts slightly later after product prefetches; still loads |
| Categories / other screens | Unchanged (only list URL helper shared if they use `getHomeListImageUrl`) |
| Placeholder missing images | Solid gray wrap; via.placeholder still if no URL |
| Old Android WebP | expo-image handles; fallback if decode fails rarely |

---

## Risks

| Risk | Mitigation |
|------|------------|
| Hero appears a bit later | By design (product priority); still prefetched |
| Prefetch vs cell race | Dedupe set; expo-image cache shared |
| WebP on odd CDNs | Only set format on Shopify CDN host |

---

## Remaining (not in this hotfix)

- Slim list DTO (backend)
- Blurhash / progressive ladder
- FlashList migration
