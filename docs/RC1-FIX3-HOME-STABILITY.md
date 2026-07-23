# RC1 Fix 3 — Homepage Scroll Stability

**Status:** Implemented — RC1 home fixes complete; no further feature work  
**Date:** 2026-07-16  
**Scope:** Failed-refresh safety, deferred catalog invalidation, scroll-preserving updates, layout stability

---

## Root cause confirmation

| # | Cause | Fix |
|---|--------|-----|
| 1 | Full `setAllProducts` on failed refresh / reshuffle | Failed refresh no longer re-applies or reshuffles feed |
| 2 | Failed pull-to-refresh called `buildBalancedHomeFeed` | Removed; keep live list + restore visible count/badge seed only |
| 3 | Catalog version wipe during home-feed peek | Version bump marks **stale**; invalidate deferred until safe moment |
| 4 | Android `removeClippedSubviews` jumps | Disabled on home list |
| 5 | Image layout shift | Image wrap reserves fixed 230px height before load |

---

## Files changed

| File | Change |
|------|--------|
| `utils/catalog.ts` | `setHomeFeedBrowsingActive`, stale flag, `applyDeferredCatalogCacheRefresh`; defer invalidate for `home-feed` / browsing |
| `app/(tabs)/index.tsx` | Failed refresh preserve; browsing active lifecycle; skip identical list replace; image wrap height; `removeClippedSubviews={false}` |

---

## Behavior

### Failed refresh
- Does **not** call `buildBalancedHomeFeed`
- Does **not** `setAllProducts` when list already populated
- Restores `visibleProductCount` / `hotBadgeSeed` if captured
- Clears refreshing spinner only

### Successful refresh
- Resets visible window + badge seed **only after** new payload arrives
- Applies new page-1 feed (intentional)

### Catalog version during browse
- `home-feed` / active browsing → **mark stale**, no cache wipe
- Apply wipe on: manual refresh, scroll-idle, home blur/leave

### Rendering
- `applyHomeProductFeed` skips `setAllProducts` when product id order unchanged
- Card image area fixed 230px with overflow hidden

---

## Regression report

| Scenario | Expected |
|----------|----------|
| Pull-to-refresh fails | Same products, same order, scroll stays |
| Pull-to-refresh succeeds | New feed (page 1) |
| Catalog sync mid-scroll | No mid-scroll wipe; stale applied later |
| Long scroll | Stable cards; no clipped-subview jump |
| Cache restore | Unchanged paths |

**Backend tests:** unchanged (mobile-only). Run app on Android/iOS for scroll validation.

---

## Performance impact

| Metric | Impact |
|--------|--------|
| Renders | Fewer on failed refresh; fewer identical re-applies |
| Network | No new APIs |
| Memory | Slightly better virtualization behavior with removeClippedSubviews off (may hold more offscreen views on Android — trade-off for stability) |
| FPS | Expected equal or better during scroll |

**Trade-off:** `removeClippedSubviews={false}` on Android can use slightly more GPU/memory for offscreen rows; chosen for scroll continuity per investigation.

---

## Remaining risks

| Risk | Level | Notes |
|------|-------|-------|
| Successful refresh still resets scroll to top | Low | Intentional for new mixKey feed |
| Enrich still appends via setAllProducts | Low | Append-only growth; needed for content |
| Deferred stale never flushed if user never leaves/scrolls idle | Low | Manual refresh and blur still flush |
| Fix 1/2 still need staging device sign-off | — | Separate |

---

## RC1 status

| Fix | Status |
|-----|--------|
| Fix 1 Images | Done (prior) |
| Fix 2 Infinite scroll | Done (prior) |
| Fix 3 Stability | **Done** |

**Do not start** Advanced Search, Recommendations, Analytics, Gestures, or Premium UX until full RC1 staging smoke is signed off.
