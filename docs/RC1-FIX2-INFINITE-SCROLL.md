# RC1 Fix 2 — Homepage Infinite Scroll

**Status:** Implemented — **stop before Fix 3**  
**Date:** 2026-07-16  
**Scope:** Pagination continuation only (no UI redesign)

---

## Root cause confirmation

| # | Cause | Fix |
|---|--------|-----|
| 1 | Empty client-filtered page set `hasNextPage: false` | Preserve backend `pageInfo`; never terminate solely on empty mapped products |
| 2 | Duplicate-only page advanced cursor without auto-fetch | `fetchAndAppendNextHomePage` auto-skips with bound |
| 3 | Memory cap 400 felt like “end of catalog” | Cap remains (optimization); configurable via env |

---

## Files changed

| File | Change |
|------|--------|
| `app/(tabs)/index.tsx` | Empty-page + duplicate skip continuation; bounded auto-skip loop |
| `utils/catalog-cache.ts` | `MAX_IN_MEMORY_HOME_PRODUCTS` from `EXPO_PUBLIC_HOME_MAX_IN_MEMORY_PRODUCTS` |

---

## Behavior

### Pagination stop condition
Only when backend reports no more pages (`!hasNextPage` or missing `endCursor`), or hard failures/cancels.

### Empty / duplicate pages
1. Advance backend cursor.  
2. Immediately request next page (no extra user scroll).  
3. Max consecutive skips: **`HOME_FEED_MAX_CONSECUTIVE_SKIPS`** (default **8**, env `EXPO_PUBLIC_HOME_FEED_MAX_CONSECUTIVE_SKIPS` 1–30).  
4. After max skips, cursor is preserved so a later scroll can resume.

### Memory
- Default in-memory window still **400** products (oldest drop as newer append).  
- Override: `EXPO_PUBLIC_HOME_MAX_IN_MEMORY_PRODUCTS` (100–5000).  
- **Trade-off:** Higher values improve “long browse without dropping early items from the window” at higher RAM cost. Cap does **not** stop pagination; it only windows retained list items.

---

## Regression report

| Area | Expected after fix |
|------|---------------------|
| Large catalog | Continues until backend end or skip budget |
| Sold-out filter empty page | Cursor kept; auto next page |
| Duplicate-heavy mix | Auto-skip up to bound |
| Real end of catalog | hasMore cleared; no extra requests |
| Offline/cache recovery | Unchanged fetch/cache path |
| Catalog version | Unchanged (Fix 3 territory) |

**Automated suite:** Backend tests unchanged by this mobile fix. Validate on device/simulator with continuous scroll.

### Suggested manual matrix
1. Scroll home past 100+ products; confirm more load without stop.  
2. After long session, confirm still loading if catalog larger.  
3. Pull-to-refresh then scroll again.  
4. Airplane mode mid-scroll: fails gracefully without zeroing catalog end incorrectly.  
5. Log `[NOOD home] auto-skip` / `max consecutive` under `__DEV__`.

---

## Performance impact

| Metric | Impact |
|--------|--------|
| API calls | May increase **only** when empty/duplicate pages occur (bounded ≤ 1 + max skips per load-more gesture) |
| At true end | Still **one** last page then stop |
| Renders | Still one `setAllProducts` per successful append; skip-only pages do not grow list |
| Memory | Default 400 unchanged unless env raised |

---

## Remaining risks

| Risk | Level | Notes |
|------|-------|-------|
| Pathological all-duplicate feed | Low | Hits skip budget; user can scroll again |
| Cap still drops oldest items | Medium (by design) | Raise env if product requires longer window |
| Fix 3 jump/refresh not addressed | — | Separate |

---

## Fix 3 not started

Await approval before homepage stability work.
