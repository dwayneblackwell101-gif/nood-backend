# Release Candidate 1 — Feature Freeze

**Status:** RC1 — feature development frozen  
**Date:** 2026-07-16  
**Allowed work:** deployment, integration bugs, staging failures, security, performance regressions, production-readiness findings only  
**Forbidden:** new commerce features, UI redesigns, Advanced Search / Recommendations / Analytics / Premium UX until RC1 smoke matrix passes with enabled flags

---

## RC1 baseline

| Gate | Status |
|------|--------|
| Backend unit/integration tests | **106+ pass** (`node --test`) |
| Feature flags default | **OFF** (reviews, rewards, wallet display, order timeline, migration) |
| Authenticated client | Present (`utils/authenticated-backend.ts`) |
| Dual token auth (Storefront + Customer Account API) | Present |

---

## RC1 hotfixes applied under freeze

| Fix | Why |
|-----|-----|
| `shopify-orders-sync` uses authenticated client | `/api/customer/orders` requires Bearer; unauth calls silently returned empty orders |
| Auth client retries/clears session only on **401**, not **403** | 403 ownership must not wipe user session |
| `validateProductionConfig` accepts `NOOD_ADMIN_API_KEY` alone | False `/ready` failure when only NOOD admin key set |
| PayPal env check when disabled | Explicit `PAYPAL_ENABLED=false` no longer forces PayPal secrets |
| Migration order sync bypasses timeline UI flag | Migration must call `/api/orders/me/sync` even if timeline UI flag is off |

---

## Staging smoke matrix (must pass before any flag ON in production)

### Backend E1
1. `GET /health` → 200  
2. `GET /ready` → 200 with `ready: true` (Redis, wallet, catalog, production_config)  
3. Catalog search → 200  
4. Unauth rewards → 401  
5. Auth rewards (Bearer CAA token) → 200  
6. Auth customer orders → 200  
7. Auth wallet balance → 200  
8. Payment create with Bearer (sandbox) → provider order  
9. Inventory reservation oversell → blocked  
10. Refund list with Bearer → 200  

### Mobile E2 (flags OFF)
1. Sign-in / session refresh works  
2. Catalog, cart, checkout shell unchanged  
3. Account orders still load (local + authenticated Shopify sync)  
4. Rewards/reviews/timeline gated APIs do not change default UX  

### Mobile E2 (enable one flag at a time on staging)
1. `EXPO_PUBLIC_FF_SERVER_REWARDS=true` → status/claim with Bearer  
2. `EXPO_PUBLIC_FF_SERVER_WALLET=true` → after display wiring validated  
3. `EXPO_PUBLIC_FF_SERVER_REVIEWS=true` → create/list  
4. `EXPO_PUBLIC_FF_ORDER_TIMELINE=true` → timeline  
5. `EXPO_PUBLIC_FF_DATA_MIGRATION=true` → migration log, no data loss  

---

## Production deploy checklist (RC1)

- [ ] `REDIS_URL`, `STORAGE_DRIVER=redis`  
- [ ] Shopify domain + storefront + admin + **order admin** tokens  
- [ ] `SHOPIFY_SHOP_ID` (Customer Account auth)  
- [ ] `ADMIN_API_KEY` or `NOOD_ADMIN_API_KEY`  
- [ ] PayPal secrets if PayPal enabled  
- [ ] `REVIEWS_MEDIA_DRIVER=url` (+ CDN URLs)  
- [ ] Webhook secret  
- [ ] `/ready` green for 10+ minutes after deploy  
- [ ] All Expo feature flags **false** in first production app build  

---

## Exit criteria to unfreeze features

1. Full E1 + E2 smoke green on staging  
2. At least one enabled flag path validated end-to-end without regression  
3. No open P0/P1 security or money-path bugs  
4. Documented re-score ≥ 8.5  

Until then: **no Advanced Search, Recommendations, Analytics, Premium UX, or Beyond-Temu work.**

---

## How to work under freeze

```
Allowed PR titles:  fix(rc1): … | deploy: … | security: … | perf: …
Disallowed:         feat: … (new commerce) | redesign …
```

Search first, extend existing modules, single source of truth, additive only, backward compatible.
