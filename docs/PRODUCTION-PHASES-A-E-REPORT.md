# Production Phases A–E — Implementation Report

**Date:** 2026-07-16  
**Scope:** Auth integration, feature flags, migration support, infrastructure, smoke checklist  
**Rule:** No new commerce features; no UI redesign

---

## Phase A — Authentication Integration ✅

### Files added
| File | Purpose |
|------|---------|
| `nood-app/utils/authenticated-backend.ts` | **Single authenticated backend client** |
| `nood-backend/auth/customer-account-auth.js` | Verify Shopify Customer Account API OAuth tokens |
| `nood-backend/tests/customer-auth-token-shape.test.js` | Token shape + prod config unit tests |

### Files modified
| File | Change |
|------|--------|
| `nood-backend/auth/customer-auth.js` | Dual verify: Storefront token **or** Customer Account API token |
| `nood-app/utils/rewards-api.ts` | Uses authenticated client |
| `nood-app/utils/refund-processing.ts` | Uses authenticated client |
| `nood-app/utils/reviews-api.ts` | Uses authenticated client (mutations) |
| `nood-app/utils/orders-tracking-api.ts` | Uses authenticated client |
| `nood-app/utils/referral-attribution.ts` | Uses authenticated client |
| `nood-app/app/checkout.tsx` | Wallet + WiPay via authenticated payment client |
| `nood-app/app/account/wallet.tsx` | Wallet top-up via authenticated payment client |
| `nood-app/app/paypal-checkout.tsx` | Injects Bearer into WebView payment fetches (from `resolveAccessToken`) |

### Client capabilities
- Automatic `Authorization: Bearer` injection
- `getValidAccessToken` + forced refresh on 401
- Single retry after refresh
- Shared helpers: `get/post/patch/deleteAuthenticatedBackendJson`, `postAuthenticatedPaymentBackendJson`
- Screens must **not** attach Authorization manually for JSON APIs

### Backend capabilities
- Accepts mobile Customer Account OAuth access tokens (preferred for JWT/long tokens)
- Falls back to Storefront `customerAccessToken` for legacy
- Stable 401/403 JSON with `code`

### Verified module wiring (client → auth client)
| Module | Status |
|--------|--------|
| Rewards | ✅ authenticated helpers |
| Wallet | ✅ payment auth helpers |
| Refunds | ✅ |
| Reviews mutations | ✅ |
| Orders tracking | ✅ |
| Payments (PayPal WebView, wallet checkout, WiPay) | ✅ |
| Catalog search/products | Public (unchanged) |

---

## Phase B — Feature Flags ✅ (default OFF)

### File
`nood-app/utils/feature-flags.ts`

| Flag env | Default | Controls |
|----------|---------|----------|
| `EXPO_PUBLIC_FF_SERVER_REVIEWS` | **false** | Reviews API mutations/my reviews |
| `EXPO_PUBLIC_FF_SERVER_REWARDS` | **false** | All rewards-api server calls |
| `EXPO_PUBLIC_FF_SERVER_WALLET` | **false** | Ready for balance UI switch (display adoption) |
| `EXPO_PUBLIC_FF_ORDER_TIMELINE` | **false** | Orders tracking API |
| `EXPO_PUBLIC_FF_DATA_MIGRATION` | **false** | Migration runners |

Existing UX unchanged until flags enabled after validation.

---

## Phase C — Data Migration ✅

### File
`nood-app/utils/data-migration.ts`

| Domain | Behavior |
|--------|----------|
| **Wallet** | Checks server balance only; **never** imports local balance as spendable money |
| **Rewards** | Syncs server status (requires server rewards flag) |
| **Reviews** | Uploads local reviews with duplicate tolerance; **retains local copies** |
| **Orders** | `POST /api/orders/me/sync`; retains local list |

Also: migration log (AsyncStorage), state markers, `rollbackMigrationDomain()` (client dual-read rollback — does not delete server data).

---

## Phase D — Production Infrastructure ✅

| Item | Change |
|------|--------|
| Production config validator | `config/production-validate.js` + `/ready` check `production_config` |
| Inventory readiness | `inventory_reservation_ready` on `/ready` |
| Reviews media | Production forces `url` driver if `local` without CDN base (ephemeral disk safe) |
| `.env.example` | `SHOPIFY_SHOP_ID`, media CDN notes |
| `render.yaml` | `SHOPIFY_SHOP_ID`, `REVIEWS_MEDIA_DRIVER=url`, tracking/reviews/inventory flags |

### CDN strategy (reviews media)
1. Prefer **HTTPS CDN URLs** in review create payload (`media: [{ url, mime }]`) with `REVIEWS_MEDIA_DRIVER=url`.
2. Or set `REVIEWS_MEDIA_PUBLIC_BASE_URL` + durable object storage mount (not Render ephemeral disk).
3. Base64 upload to local disk is **not** production-safe on free Render disks.

---

## Phase E — Smoke Test Checklist

Run against staging with **flags still OFF** for UX safety; enable one flag at a time.

### E1 Backend (no mobile)
| # | Check | Expected |
|---|--------|----------|
| 1 | `GET /health` | 200 |
| 2 | `GET /ready` | 200, `production_config` ok in prod |
| 3 | `GET /api/catalog/search?q=test` | 200 |
| 4 | Unauth `GET /api/rewards/status` | 401 |
| 5 | Auth Bearer (CAA token) `GET /api/rewards/status` | 200 |
| 6 | Unauth `POST /api/reviews` | 401 |
| 7 | Auth create review (verified purchase) | 201/pending |
| 8 | `POST /api/orders` (payment) with Bearer | Creates provider order |
| 9 | Inventory oversell second concurrent reserve | insufficient |
| 10 | Auth refund list | 200 |
| 11 | Auth `POST /api/orders/me/sync` | imported ≥ 0 |
| 12 | `POST /api/notifications/register-token` | 200 |

### E2 Mobile (integration)
| # | Check | Expected |
|---|--------|----------|
| 1 | Signed-out rewards with FF_SERVER_REWARDS=true | Auth error / sign-in |
| 2 | Signed-in rewards FF=true | Status loads with Bearer |
| 3 | Wallet checkout signed-in | Request includes Bearer |
| 4 | PayPal WebView create order | Headers include Authorization |
| 5 | Refund submit signed-in | Bearer present |
| 6 | Flags default OFF | No server rewards/reviews/timeline calls from gated modules |
| 7 | Migration FF off | `runEnabledMigrations` no-ops domains |

### Known residual risks
| Risk | Severity | Notes |
|------|----------|-------|
| Customer Account API discovery/network failure | Medium | Auth falls back to storefront token verify |
| PayPal HTML token snapshot at render | Medium | Refresh page if token expires mid-checkout |
| `EXPO_PUBLIC_FF_SERVER_WALLET` not yet bound to balance UI | Low | Auth path fixed; display switch is adoption step |
| Image-search route still missing | Low | Pre-existing; not this phase |

---

## Regression

| Suite | Result |
|-------|--------|
| customer-auth-token-shape + rewards + reviews + orders | **37/37 pass** (partial run) |
| Full suite recommended | `node --test` before deploy |

---

## Production readiness re-score

| Category | Before | After |
|----------|--------|-------|
| Client–server auth contract | 3.0 | **8.0** |
| Deployment config | 5.5 | **7.0** |
| Migration readiness | 5.0 | **7.5** |
| Feature-flag safety | 4.0 | **8.5** |
| **Overall** | **5.5** | **~7.2 / 10** |

**Still not full green** until: staging smoke E1–E2 green, Render secrets filled (`SHOPIFY_SHOP_ID`, Redis, order admin token), and flags enabled module-by-module after validation.

---

## Enablement order (ops)

1. Deploy backend (auth dual-verify + ready checks)  
2. Set `SHOPIFY_SHOP_ID` on Render  
3. Staging smoke E1  
4. Ship app with **all FF OFF**  
5. Staging: enable `EXPO_PUBLIC_FF_SERVER_REWARDS=true` → validate  
6. Enable wallet display flag when balance UI wired  
7. Enable reviews → migration → timeline  
8. Only then resume Advanced Search / Recommendations / etc.

---

## Do not start yet

- Advanced Search  
- Recommendation Engine  
- Analytics  
- Premium Shopping UX  
- Beyond-Temu enhancements  

until smoke E1/E2 signed off and readiness ≥ ~8.5 with flags validated.
