# RC1 Home Validation Report

**Phase:** Staging Validation (no feature work)  
**Date:** 2026-07-16  
**Scope:** Homepage Fixes 1–3 (images, infinite scroll, scroll stability)  
**Code modified during this phase:** **None** (investigation/validation only)

---

## Executive recommendation

### **RC1 Homepage Conditionally Approved for Staging Deploy**

| Verdict | Detail |
|---------|--------|
| **Static / automated** | **PASS** — Fixes 1–3 present, consistent with root-cause design; backend **114/114** tests pass |
| **Device / staging matrix** | **PENDING** — must be executed on physical/simulator Android + iOS before production |
| **P0/P1 blockers found in code review** | **None critical** requiring immediate hotfix |

**Do not ship to production** until the device matrix below is signed off.  
**Do not start** Advanced Search, Recommendations, Analytics, or Gestures until that sign-off.

---

## Fixes under validation

| Fix | Purpose | Primary files |
|-----|---------|----------------|
| **Fix 1** | Primary list images (featured → images → media) | `catalog/transform.js`, routes, recommendations |
| **Fix 2** | Infinite scroll (cursor + auto-skip) | `app/(tabs)/index.tsx`, `catalog-cache.ts` |
| **Fix 3** | Scroll stability (no failed reshuffle, deferred catalog wipe) | `index.tsx`, `utils/catalog.ts` |

---

## Homepage validation matrix

### Automated / static analysis

| Check | Method | Result |
|-------|--------|--------|
| Infinite scroll does not stop on empty client filter | Code path review: `fetchStoreProductsPage` preserves backend `hasNextPage`/`endCursor` | **PASS** |
| Auto-continue on duplicates (bounded) | `fetchAndAppendNextHomePage` while-loop + `HOME_FEED_MAX_CONSECUTIVE_SKIPS` (default 8) | **PASS** |
| No premature end solely due to empty products | Empty filter no longer sets `hasNextPage: false` unless backend ends | **PASS** |
| Dedupe on append | `uniqueProducts` filter by `product.id` before merge | **PASS** |
| Blank primary image root cause fixed | `toStorefrontListProduct` uses `resolvePrimaryListImage` | **PASS** (unit 7/7) |
| Failed refresh does not reshuffle | No `buildBalancedHomeFeed` on fail; `restoreRefreshFeedSnapshot` skips list replace | **PASS** |
| Failed refresh preserves visible count / badges | Snapshot restores `visibleProductCount`, `hotBadgeSeed` | **PASS** |
| Background catalog version mid-browse | `home-feed` / browsing → mark stale, no wipe | **PASS** |
| Image area reserved before load | `productImageWrap` / `productImage` height **230** | **PASS** |
| No new commerce features | Diff limited to Fix 1–3 paths | **PASS** |

### Device / staging (operator must complete)

| Check | Android | iOS | Slow net | Fast net | Large catalog | Small catalog |
|-------|---------|-----|----------|----------|---------------|---------------|
| Scroll to catalog end | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| No blank primary images (spot 50+ products) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| No unexpected duplicates in UI | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| No premature feed end | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Pull-to-refresh success | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Failed PTR: order + scroll + visible preserved | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Catalog sync during browse (no interrupt) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Cards stable while images load | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |

**Legend:** ☐ = pending manual staging

---

## Regression validation matrix

| Area | Image path | Pagination / list | Static risk | Staging |
|------|------------|-------------------|-------------|---------|
| **Home** | List `featuredImage` via Fix 1 | Fix 2 + 3 | Low | ☐ |
| **Categories** | Collection product images use `resolvePrimaryListImage` | Unchanged collection pagination | Low | ☐ |
| **Search** | Catalog search uses list product mapping | Unchanged search pagination | Low | ☐ |
| **Product detail** | Gallery still `buildProductGalleryImages` (same order) | N/A | Low | ☐ |
| **Related / recommendations** | Rec items use `resolvePrimaryListImage` | N/A | Low | ☐ |
| **Wishlist** | Uses stored product payloads / detail | N/A | Low | ☐ |
| **Cart** | Line item images from cart state | N/A | Low | ☐ |
| **Checkout** | Not home-feed dependent | N/A | Low | ☐ |

**Static regression assessment:** **PASS** (no intentional behavior change outside home feed stability + list primary images).

---

## Performance validation

### Automated

| Metric | Result |
|--------|--------|
| Backend unit/integration suite | **114/114 pass** |
| Primary image unit tests | **7/7 pass** |
| Extra API after true end of catalog | Design: **no** (stops when `!hasNextPage`) |
| Max extra calls per load-more on empty/dup pages | ≤ **1 + HOME_FEED_MAX_CONSECUTIVE_SKIPS** (default 9) |

### Before vs after (expected; measure on device)

| Metric | Before (investigated) | After (expected) | Measure on staging |
|--------|----------------------|------------------|--------------------|
| Infinite scroll completion | Often stopped early (empty/dup pages) | Continues to backend end or skip budget | Scroll depth vs catalog size |
| Failed PTR | Reshuffle → jump | No list change | Record scrollY before/after fail |
| Catalog version mid-browse | Cache wipe mid-session | Deferred | Force sync while scrolling |
| Primary images | Missing when no featuredImage | Fallback chain | Count blank cards / 100 |
| Memory window | Hard 400 | Default 400, env-configurable | RSS after long scroll |
| Android virtualization | `removeClippedSubviews` on | Off on home (stability trade-off) | FPS + memory |
| Renders on failed refresh | Full list re-apply | Spinner only | React DevTools / logs |
| Network continuous scroll | 1 page / end-reach (often stuck) | 1+ bounded skips when needed | Charles / Flipper |

### Device metrics template (fill during staging)

| Metric | Android fast | Android slow | iOS fast | iOS slow |
|--------|--------------|--------------|----------|----------|
| Initial home load (ms) | | | | |
| Time to first products (ms) | | | | |
| Time to first image (ms) | | | | |
| Scroll FPS (avg) | | | | |
| Memory after 500 scroll items (MB) | | | | |
| Network calls per 300 products loaded | | | | |

**Profiling hooks already in app:** `__DEV__` logs `[HOME_FEED_LOAD_MORE]`, `[HOME_FEED_APPEND_DONE]`, `[NOOD home] auto-skip`, `[NOOD app catalog] cache marked stale`. Enable `EXPO_PUBLIC_HOME_PERF_LOGS=1` for extra home perf summaries.

---

## Remaining issues

### P0
**None identified** in static review.

### P1 (non-blocking for staging; watch on device)

| ID | Issue | Severity | Notes |
|----|--------|----------|-------|
| P1-1 | In-memory cap still drops oldest products after window | Medium (by design) | Raise `EXPO_PUBLIC_HOME_MAX_IN_MEMORY_PRODUCTS` if needed |
| P1-2 | Skip budget exhaust → temporary pause until next scroll | Low | Cursor preserved |
| P1-3 | Successful PTR still resets feed to page 1 + scroll intent | Low | Intentional new mix |
| P1-4 | Deferred catalog invalidate on scroll-idle may clear disk cache while list is live | Low | In-memory list remains; next cold start refetches |
| P1-5 | `removeClippedSubviews={false}` may raise Android memory | Low | Trade-off for jump fix |

### P2
- Full FPS/rerender before/after numbers require instrumented device runs (not available in this validation environment).

---

## Critical regression check (code)

| Risk | Status |
|------|--------|
| Failed refresh still reshuffles | **Mitigated** — no `buildBalancedHomeFeed` on fail paths |
| Empty page kills feed | **Mitigated** |
| Product detail gallery order changed | **No** — still images → media → featured |
| List API shape break | **No** — still `featuredImage` object |
| Infinite fetch loop | **Mitigated** — max consecutive skips |
| Auth / payments / rewards | **Unrelated** to home fixes; not re-tested here |

---

## Pass / Fail summary

| Gate | Result |
|------|--------|
| Automated backend tests | **PASS** (114/114) |
| Image unit tests | **PASS** (7/7) |
| Static home Fix 1–3 correctness | **PASS** |
| Cross-surface static regression | **PASS** |
| Device home matrix | **PENDING** |
| Performance device comparison | **PENDING** |
| Production go-live | **HOLD** until device matrix complete |

---

## Final recommendation

### **RC1 Homepage Conditionally Approved**

**Meaning:**
1. Code quality and design of Fixes 1–3 are **approved for staging deployment**.  
2. **Complete the device/staging checklist** (tables above) before production.  
3. If any device cell fails with a **P0** (feed cannot scroll, mass blank images, crash), open a targeted bugfix under freeze — do **not** start new features.  
4. If all device cells pass, mark **RC1 Homepage Fully Approved** and proceed with broader RC1 smoke (auth, wallet, checkout), still under feature freeze for Search/Recs/etc.

---

## Suggested staging runbook (operator)

1. Deploy backend with Fix 1 image resolver.  
2. Build app with Fix 2 + 3.  
3. Android + iOS: home scroll 5+ minutes; note if feed stops early.  
4. Airplane mode mid-refresh → fail PTR → confirm list/order/scroll.  
5. Trigger catalog sync (admin) while scrolling home → no visible wipe.  
6. Spot-check 100 products for blank images.  
7. Categories + search + one product detail + recs cards.  
8. Fill performance table if possible.  
9. Sign report → Fully Approved or file P0/P1.

---

## Document control

| Doc | Path |
|-----|------|
| This report | `nood-app/docs/RC1-HOME-VALIDATION-REPORT.md` |
| Fix 1 | `docs/RC1-FIX1-PRODUCT-IMAGES.md` |
| Fix 2 | `docs/RC1-FIX2-INFINITE-SCROLL.md` |
| Fix 3 | `docs/RC1-FIX3-HOME-STABILITY.md` |
| Investigation | `docs/RC1-HOME-ISSUES-INVESTIGATION.md` |
