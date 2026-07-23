# NOOD Production Integration & Validation Report

**Date:** 2026-07-16  
**Phase:** Production Integration (no new user-facing features)  
**Scope:** Backend modules, mobile API contracts, local data inventory, security, deployment, migration  
**Backend test suite:** `node --test` → **102/102 pass**

---

## Executive summary

| Area | Status | Score (0–10) |
|------|--------|--------------|
| Backend module completeness | Strong modular services | 8.5 |
| Cross-module wiring (server) | Mostly wired; gaps below | 7.0 |
| Mobile ↔ backend auth contract | **Critical gap** | 3.0 |
| Mobile adoption of new services | Helpers exist; UI not adopted | 4.0 |
| Deployment / Render config | Partial; secrets incomplete | 5.5 |
| Security (server) | Solid patterns | 8.0 |
| Security (end-to-end) | Blocked by missing Bearer attach | 4.5 |
| Monitoring / readiness | Good checks; limited alerting | 6.5 |
| Data migration readiness | Plans only; no jobs | 5.0 |
| **Overall production readiness** | **Not ship-ready for new services** | **5.5 / 10** |

**Verdict:** Backend architecture is mature enough to freeze feature work. **Do not ship Rewards / Reviews / Orders-tracking as live customer capabilities until the auth header contract is fixed and staged end-to-end validation passes.** Catalog, payments scaffolding, and inventory reservation on the payment path are farther along.

---

# 1. Integration report

## 1.1 Module map (single sources of truth)

| Module | Canonical path | Mount / entry | Redis? | Feature flags |
|--------|----------------|---------------|--------|---------------|
| Catalog / Search / Recs | `catalog/*` | `/api/catalog/*` | Yes (preferred) | Catalog env knobs |
| Rewards | `rewards/*` | `/api/rewards` | Yes | `REWARDS_*` |
| Inventory reservation | `inventory/reservation.js` | Used inside `POST /api/orders` (payment) | Yes | `INVENTORY_RESERVATION_*` |
| Reviews + Q&A | `reviews/*` | `/api/reviews` | Yes | `REVIEWS_*` |
| Orders tracking | `orders/*` | `/api/orders/*` (tracking) | Yes | `ORDERS_*` |
| Refunds / returns | `refunds/*` | `/api/refunds/*` | Via storage | `REFUNDS_*` (if set) |
| Notifications | `notifications/push-notifications.js` | `/api/notifications` | pushTokens store | `NOTIFICATION_SEND_RATE_LIMIT` |
| Auth | `auth/customer-auth.js` | Middleware | N/A | Storefront token |
| Wallet | `wallet/redis-wallet.js` | `/api/wallet/*` | Required for money | Wallet env |
| Payments | `payments/*`, `server.js` | `/api/orders`, capture, PayPal, WiPay | Payment state | `PAYPAL_*`, `WIPAY_*` |
| Shopify sync | catalog webhooks + sync routes | `/api/sync/*`, webhooks | Queue | Webhook env |

## 1.2 Cross-module integration matrix

| From → To | Integration status | Notes |
|-----------|-------------------|--------|
| **Payments → Inventory** | ✅ Wired | `reserveLines` on order create; release/commit on failure/success |
| **Payments → Wallet** | ✅ Wired | Wallet checkout + top-up + ledger |
| **Rewards → Wallet** | ✅ Wired (server) | Credits via `redisWallet`; fails closed without ledger |
| **Rewards → Auth** | ✅ Server / ❌ Client | Routes require Bearer; mobile rarely sends it |
| **Reviews → Auth** | ✅ Server / ⚠️ Client helper only | `reviews-api.ts` supports token; **screens not wired** |
| **Reviews → Shopify orders** | ✅ | `loadCustomerOrders` → verified purchase |
| **Orders tracking → Auth** | ✅ Server / ⚠️ Client helper only | Same pattern as reviews |
| **Orders tracking → Shopify** | ✅ | `POST /me/sync` via `fetchShopifyCustomerOrders` |
| **Orders tracking → Push** | ⚠️ Partial | Uses `pushTokens` + `userId` match; tokens often lack customer id |
| **Orders tracking → Refunds** | ⚠️ Loose | Overlay status + optional bridge; **does not replace** `/api/refunds` |
| **Orders tracking → Payment orders** | ⚠️ Namespace share | Both live under `/api/orders`; paths designed not to collide |
| **Refunds → Auth** | ✅ Server / ❌ Client | Refund client posts without Authorization |
| **Catalog → Search** | ✅ | `GET /api/catalog/search` + `searchProducts` |
| **Catalog → Recommendations** | ✅ | `GET /api/catalog/products/recommendations` |
| **Catalog → Inventory** | ⚠️ Indirect | Reservation uses catalog availability resolver at checkout |
| **Notifications → Expo** | ✅ | Register + admin send |
| **Shopify webhooks → Catalog** | ✅ | HMAC + Redis job queue |
| **Redis → all money/state** | ✅ Required in prod | Readiness fails without Redis write |

## 1.3 Route namespace caution: `/api/orders`

Two concerns share the prefix:

| Owner | Paths | Purpose |
|-------|-------|---------|
| Payment (`server.js`) | `POST /api/orders`, `POST /api/orders/:id/capture` | PayPal/checkout create & capture |
| Tracking (`orders/`) | `GET /me`, `/:id/timeline`, `/tracking/...`, `/admin/...`, etc. | Lifecycle overlay |

**Status:** Compatible if registration order leaves unmatched methods to fall through (current design).  
**Risk:** Future `POST /api/orders/:id/*` on tracking router could shadow payment capture.  
**Rule:** Never add tracking routes that conflict with `POST /:orderID/capture`. Document in PR reviews.

## 1.4 Inventory reservation

- **Implemented and used** in payment order creation path in `server.js`.
- Enabled via `INVENTORY_RESERVATION_ENABLED` / TTL.
- **Not** exposed as a public mobile API (correct — server-side only).
- **Gap:** No readiness check named `inventory_reservation_mounted` (service exists but not listed like rewards/reviews).

## 1.5 Catalog image search mismatch

- **Mobile** (`categories.tsx`, `index.tsx`): `POST /api/catalog/image-search`
- **Backend:** **No route found** for image-search
- Camera search falls back to local ranking after failed/empty response
- **Document as API mismatch** (see §2)

---

# 2. API compatibility report

## 2.1 How mobile calls the backend

| Helper | Auth headers | Used by |
|--------|--------------|---------|
| `getBackendJson` / `fetchBackendJson` / `postBackendJson` | Optional `options.headers` only; **no automatic Bearer** | Catalog, rewards, refunds, wallet, notifications |
| `reviews-api.ts` | Optional `accessToken` → Bearer | **Not imported by screens** |
| `orders-tracking-api.ts` | Optional `accessToken` → Bearer | **Not imported by screens** |
| Direct `fetch` in `paypal-checkout.tsx` | Must be verified per payload | Payments |

**Critical finding:** Customer-auth routes on the backend will return **401** for almost all live mobile money/rewards/refund calls until Bearer is attached from Shopify customer session.

## 2.2 Contract matrix (mobile → backend)

### Catalog (generally compatible — public)

| Client call | Backend | Auth | Match |
|-------------|---------|------|-------|
| `GET /api/catalog/products` | ✅ | Public | OK |
| `GET /api/catalog/products/:handle` | ✅ | Public | OK |
| `GET /api/catalog/products/recommendations` | ✅ | Public | OK |
| `GET /api/catalog/collections` | ✅ | Public | OK |
| `GET /api/catalog/collections/:h/products` | ✅ | Public | OK |
| `GET /api/catalog/search` | ✅ | Public | OK |
| `GET /api/catalog/menus/:handle` | ✅ | Public | OK |
| `GET /api/catalog/version` | ✅ | Public | OK |
| `POST /api/catalog/image-search` | ❌ **missing** | — | **MISMATCH** |

### Rewards (route exists; auth contract broken)

| Client call | Backend | Client sends Bearer? | Match |
|-------------|---------|----------------------|-------|
| `GET /api/rewards/status` | ✅ + `requireCustomerAuth` | **No** | **MISMATCH** |
| `GET /api/rewards/challenges` | ✅ | **No** | **MISMATCH** |
| `POST /api/rewards/claim` | ✅ | **No** | **MISMATCH** |
| `POST /api/rewards/referral/share` | ✅ | **No** | **MISMATCH** |
| `POST /api/rewards/referral/attributed` | ✅ | **No** | **MISMATCH** |
| `GET/POST lucky-spin/*` | ✅ | **No** | **MISMATCH** |
| `GET/POST scratch/*` | ✅ | **No** | **MISMATCH** |
| daily/missions (if used) | ✅ on BE | Client may not call | Partial |

Response shape: backend returns structured challenges/wallet; client normalizers exist. After auth is fixed, re-validate fields against screens.

### Refunds

| Client call | Backend | Client Bearer? | Match |
|-------------|---------|----------------|-------|
| `POST /api/refunds/requests` | ✅ + auth | **No** | **MISMATCH** |
| `GET /api/refunds/requests` | ✅ + auth | **No** | **MISMATCH** |
| `GET /api/refunds/requests/:id/status` | ✅ + auth | **No** | **MISMATCH** |

### Wallet / payments

| Client call | Backend | Client Bearer? | Match |
|-------------|---------|----------------|-------|
| `POST /api/wallet/checkout` | ✅ + auth | **Likely no** | **MISMATCH risk** |
| `GET /api/wallet/balance` | ✅ + auth | **Likely no** | **MISMATCH risk** |
| `POST /api/wallet/paypal/orders` (+ capture) | ✅ + auth | Verify | **Risk** |
| `POST /api/orders` + capture | ✅ + auth | PayPal screen uses raw fetch — **verify headers** | **Risk** |
| `POST /api/customer/orders` | ✅ + auth | Verify | **Risk** |

### Reviews (backend ready; app not adopted)

| Client helper | Backend | Screen wired? | Status |
|---------------|---------|---------------|--------|
| `reviews-api.ts` | ✅ full CRUD/Q&A | **No** | Deferred adoption |
| Product page Judge.me + AsyncStorage | External / local | Yes | Legacy path |

### Orders tracking (backend ready; app not adopted)

| Client helper | Backend | Screen wired? | Status |
|---------------|---------|---------------|--------|
| `orders-tracking-api.ts` | ✅ timeline/ship/cancel/return | **No** | Deferred |
| `customer-orders.ts` local + Shopify merge | Mixed | Yes | Legacy path |
| Payment `POST /api/orders` | Payment, not tracking | Yes | Different purpose |

### Notifications

| Client call | Backend | Match |
|-------------|---------|-------|
| `POST /api/notifications/register-token` | ✅ | OK (public register) |
| Admin send | Admin key | Ops only |

## 2.3 Documented mismatches (priority)

| ID | Severity | Issue | Impact |
|----|----------|-------|--------|
| **M1** | **P0** | No automatic `Authorization: Bearer` on backend JSON helpers | Rewards, refunds, wallet, authenticated payments fail or never reach auth subject |
| **M2** | **P0** | Rewards UI calls API without token | Live rewards blocked (fail-closed 401) |
| **M3** | **P0** | Refunds UI calls API without token | Return requests fail against live backend |
| **M4** | **P1** | `POST /api/catalog/image-search` missing | Camera search degraded / local-only |
| **M5** | **P1** | Reviews API not used by product/account UI | Dual truth: Judge.me + local storage |
| **M6** | **P1** | Orders tracking API not used by orders UI | Dual truth: local orders + Shopify list |
| **M7** | **P2** | Push tokens may omit `userId` | Order event pushes won’t target customers |
| **M8** | **P2** | `/api/orders` dual ownership | Future route collision risk |
| **M9** | **P2** | Client still sends `customerId` in rewards body | Harmless if auth works (server ignores for authz); confusing if not |
| **M10** | **P3** | Local wallet balance vs server wallet | Display can disagree until balance always from `/api/wallet/balance` |

## 2.4 Version compatibility

- No explicit API version header (e.g. `Accept: application/vnd.nood.v1+json`).
- Catalog has `schemaVersion` / `/api/catalog/version` for cache invalidation — **good pattern** to extend to rewards/reviews/orders later.
- Shopify Admin/Storefront API versions pinned in env (`2025-10` in render.yaml).

---

# 3. Frontend local / legacy inventory (document only)

**Policy this phase:** Identify only. Do not replace. Do not redesign.

## 3.1 Device-local state (AsyncStorage / contexts)

| Domain | Location | Nature | Target backend SSoT | Adoption phase |
|--------|----------|--------|---------------------|----------------|
| Cart | `CartContext` | Device cart | Shopify cart / checkout session (future) | Keep local OK for guest cart |
| **Wallet balance / locked rewards** | `CartContext` `NOOD_BALANCE`, `NOOD_LOCKED_REWARDS` | **Legacy money on device** | `redisWallet` + `/api/wallet/balance` + rewards status | **High priority migration** |
| Addresses | `AddressContext` | Local address book | Customer Account API / backend profile | Medium |
| History events | `HistoryContext` | Local analytics-ish | Optional future analytics | Low |
| **Customer reviews** | `customer-reviews.ts`, product page storage | **Local reviews** | `/api/reviews` | High after M1 + deploy |
| **Orders** | `customer-orders.ts`, account orders | Local + Shopify merge | `/api/orders` tracking + `/api/customer/orders` | High after M1 |
| Wishlist | wishlist storage/sync | Local + optional sync | Keep until dedicated service | Medium |
| Catalog cache | `catalog.ts`, `catalog-cache.ts` | Offline cache of backend catalog | Backend remains SSoT | OK (cache) |
| Categories cache | `categories.tsx` | UI cache | Catalog API | OK (cache) |
| Recommendations cache | `account-recommendations.ts` | Cache of API results | Catalog recommendations | OK (cache) |
| Trending cache | `category-trending.ts` | Cache | Catalog | OK (cache) |
| Guest session orders | `customer-orders.ts` | Device-only | Discard on sign-in / merge plan | Medium |
| Auth tokens | Secure store / auth utils | Device secrets | Shopify session | OK |
| Push registration | `push-notifications.ts` | Device token | Backend token store | Wire `userId` = customer id |

## 3.2 External / non-backend product data

| Source | Screen | Notes |
|--------|--------|-------|
| **Judge.me** widgets | `product/[handle].tsx` | Live reviews embed; keep until reviews backend adopted |
| Shopify Customer Account API | Auth/profile | Parallel to backend; correct for identity |
| Shopify Storefront (indirect) | Via backend catalog | Preferred |

## 3.3 Temporary / demo paths

| Item | Location | Risk |
|------|----------|------|
| Rewards demo screens | `rewards-demo`, promo components | Demo UI — ensure not credited without server |
| Scratch / lucky spin | Uses `rewards-api` | Blocked by M1; may show fail-closed |
| `demoOnly` fields in API types | rewards types | Server sets `demoOnly: false` when real |

## 3.4 Screens still on local/legacy for “new” domains

| Screen / flow | Current data source | Backend ready? | UI change needed for adoption? |
|---------------|---------------------|----------------|--------------------------------|
| Account reviews | Local `customer-reviews` | Yes `/api/reviews` | Data layer only |
| Product reviews tab | Judge.me + empty local array | Yes | Data layer only (keep layout) |
| Account orders | Local + Shopify sync utils | Partial tracking | Data layer only |
| Order detail / tracking | Local fields (trackingNumber) | Yes timeline API | Data layer only |
| Special reward / scratch / spin | `rewards-api` without Bearer | Yes | **Auth wiring only** |
| Wallet display | Local balance key | Yes wallet API | Auth + source switch |
| Returns | `refund-processing` without Bearer | Yes refunds | Auth wiring |
| Camera search | Local rank + missing API | No image-search | Backend route or disable flag |

---

# 4. Deployment checklist

## 4.1 Render (`render.yaml`) present

| Item | In render.yaml | Required for prod |
|------|----------------|-------------------|
| `NODE_ENV=production` | ✅ | Yes |
| `STORAGE_DRIVER=redis` | ✅ | Yes |
| `REDIS_URL` | ✅ sync:false | Yes |
| `ADMIN_API_KEY` | ✅ | Yes |
| Shopify domain/tokens | ✅ partial | Yes |
| `SHOPIFY_STOREFRONT_ACCESS_TOKEN` | ✅ | Yes (auth + catalog) |
| `SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN` | ✅ | Yes (orders sync, reviews purchase, refunds) |
| `SHOPIFY_WEBHOOK_SECRET` | ✅ | Yes |
| PayPal credentials | ✅ | If PayPal on |
| WiPay credentials | ✅ | If WiPay on |
| `BACKEND_BASE_URL` | ✅ | Yes |
| `NOOD_ALLOWED_ORIGINS` | ✅ | Yes |
| Health check `/health` | ✅ | Yes |
| **Rewards env knobs** | ❌ not listed | Optional defaults OK |
| **Reviews env / media** | ❌ | Set for media CDN |
| **Orders tracking env** | ❌ | Optional defaults OK |
| **Inventory env** | ❌ | Defaults OK |
| `NOOD_ADMIN_API_KEY` | ❌ (only ADMIN) | Align dual keys |
| Wallet / payment lock TTLs | ❌ | Defaults in code |
| Push / Expo | ❌ | No server secret needed for Expo push |

## 4.2 Missing / incomplete production configuration

1. **Render free plan** — cold starts; Redis may be external (Upstash) — confirm latency and eviction.
2. **`STORAGE_DRIVER=json` in `.env.example` default** — dangerous if copied to prod; render.yaml sets redis (good).
3. **Reviews media:** `REVIEWS_MEDIA_DIR` on ephemeral disk will lose files on redeploy — need object storage / CDN (`REVIEWS_MEDIA_PUBLIC_BASE_URL` + `url` driver or S3 later).
4. **No automated deploy validation script** for `/ready` in CI.
5. **Feature flags not mirrored in Render dashboard** documentation.
6. **Mobile:** `EXPO_PUBLIC_BACKEND_URL` / production backend URL must point to Render; auth token attach not env-solvable alone.

## 4.3 Health & readiness

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness (Render healthCheckPath) |
| `GET /ready` | Deep readiness (currency, redis, wallet, rewards, reviews, orders tracking, PayPal, webhooks, Shopify order access) |

**Recommended gate:** Deploy is green only if `/ready` → `ready: true` in production.

## 4.4 Pre-production smoke list (manual / scripted later)

1. `/health` 200  
2. `/ready` 200 all critical checks ok  
3. Unauth `GET /api/rewards/status` → 401  
4. Auth `GET /api/rewards/status` → 200 (after M1 fix)  
5. `GET /api/catalog/search?q=test` → 200  
6. `GET /api/reviews?productHandle=x` → 200  
7. Unauth `POST /api/reviews` → 401  
8. `POST /api/orders` payment path with auth (staging)  
9. Inventory: second concurrent oversell attempt fails  
10. Refund create with auth  
11. Webhook HMAC reject without signature  

---

# 5. Security report

## 5.1 Server controls (strong)

| Control | Modules |
|---------|---------|
| Customer Bearer → Shopify Storefront verify | auth middleware |
| Body customerId must match auth subject | assertBodyIdentityMatches |
| Admin API key timing-safe compare | server |
| Helmet + CORS allowlist | server |
| Rate limits (express-rate-limit + per-customer counters) | rewards, reviews, orders, notifications send |
| Idempotency keys | rewards mutations; inventory reservation id; payments state |
| Wallet atomic ledger (Redis Lua) | wallet |
| Inventory oversell protection | reservation Lua / memory |
| Review XSS sanitize | reviews service |
| Verified purchase fail-closed | reviews |
| Webhook HMAC | catalog webhooks |
| Audit logs without tokens | rewards, reviews, orders |
| Ownership checks | reviews, orders, refunds |

## 5.2 Gaps / risks

| ID | Severity | Risk | Mitigation (next engineering phase — not implemented now) |
|----|----------|------|-----------------------------------------------------------|
| S1 | **Critical** | Mobile omits Bearer → either total 401 or (if any legacy unauth path remains) wrong identity | Centralize auth header injection in `backend.ts` |
| S2 | High | Local wallet balance editable on device conceptually | UI must display server balance only |
| S3 | Medium | Reviews media on local disk | CDN/object storage |
| S4 | Medium | Carrier webhook secret optional | Require secret in production |
| S5 | Medium | Push register open (anyone can POST tokens) | Rate limit + bind token to auth when available |
| S6 | Low | No API versioning | Add when breaking changes needed |
| S7 | Low | Image-search endpoint missing (not a security hole) | Don’t accept large base64 without limits when added |
| S8 | Medium | Order tracking + payment same prefix | Route review checklist |

## 5.3 Replay / fraud

| Mechanism | Status |
|-----------|--------|
| Payment state + locks | Present |
| Rewards idempotency + daily caps | Present |
| Review spam fingerprints | Present |
| Inventory reservation TTL | Present |
| PayPal reconciliation | Present when enabled |

---

# 6. Performance notes

| Area | Observation | Recommendation (only if measured) |
|------|-------------|-----------------------------------|
| Backend tests | 102 tests ~1.2s | Keep as regression gate |
| Catalog search | In-process score over cached products | OK at current catalog size; monitor p95 |
| Recommendations | Catalog endpoint | Cache already on client |
| Reviews list | Load set + filter in memory | Fine until high volume; then sorted sets |
| Orders timeline | 30s cache TTL | Good; watch hit metrics |
| Redis | Single namespace multi-module | Use key prefixes; monitor memory |
| App startup | Large screens (home/categories) | Existing cache/snapshot patterns; measure TTI on device |
| Images | expo-image + Shopify URLs | Keep CDN transforms (`shopify-image-url`) |
| Camera search | Client-side rank after missing API | Don’t add heavy on-device ML without budget |

**No optimization work in this phase.** Instrument first: log p95 for `/api/catalog/search`, `/api/rewards/status`, `/api/orders/:id/timeline`.

---

# 7. Monitoring

## 7.1 Existing

| Signal | Where |
|--------|-------|
| Console audit lines | `[REWARDS AUDIT]`, `[REVIEWS AUDIT]`, `[ORDERS AUDIT]` |
| Metric counters in Redis/memory | rewards/reviews/orders stores |
| Admin metrics endpoints | `/api/reviews/metrics/summary`, `/api/orders/metrics/summary` |
| Readiness checks | `/ready` |
| Health | `/health` |
| Webhook worker heartbeat | readiness when required |
| Notification send logs | `[NOTIFICATIONS]` |

## 7.2 Gaps

- No centralized APM (Datadog/Sentry/OpenTelemetry) wired in repo.
- No alert rules on `/ready` failure or payment reconciliation backlog.
- Push success/failure metrics exist for orders; not unified dashboard.
- Client has `screen-perf` / memory debug utils — not production telemetry pipeline.

**Recommendation:** Before next feature phase, attach error reporting (e.g. Sentry) to backend process + mobile, and alert on `/ready` 503 for 2+ minutes.

---

# 8. Feature flags inventory

| Flag / env family | Default | Independent kill-switch? |
|-------------------|---------|----------------------------|
| `REWARDS_*` | various | No single `REWARDS_ENABLED` — mutations fail without wallet |
| `REVIEWS_ENABLED` | true | ✅ |
| `ORDERS_TRACKING_ENABLED` | true | ✅ (config; ensure routes honor it on all paths) |
| `ORDERS_PUSH_*` | true | ✅ per event class |
| `INVENTORY_RESERVATION_ENABLED` | true | ✅ |
| `PAYPAL_ENABLED` | true | ✅ |
| `WIPAY_ENABLED` | false | ✅ |
| `REFUNDS_ENABLED` | true-ish | Check server readiness branch |
| `SHOPIFY_WEBHOOKS_REQUIRED` | true prod | ✅ |
| `CATALOG_LEGACY_FALLBACK_ENABLED` | false | ✅ |
| `LOCAL_STATE_FALLBACK_ENABLED` | true | Dev risk if left on prod storage |

**Gap:** Mobile has no feature flags for “use server reviews / use order timeline / use server wallet.” Adoption should introduce **client flags** (e.g. `EXPO_PUBLIC_USE_SERVER_REVIEWS=false`) without UI redesign.

---

# 9. Data migration plan (no execution this phase)

## 9.1 Principles

1. Server is SSoT after cutover for each domain.  
2. Device data is **imported once** with user consent / silent merge on first authenticated open.  
3. Never delete local data until server ACK + dual-read period.  
4. Additive dual-write optional during transition.

## 9.2 Domain plans

### A. Local reviews → `/api/reviews`

| Step | Action |
|------|--------|
| 1 | Deploy reviews backend; validate with staging tokens |
| 2 | Fix M1 auth |
| 3 | On signed-in “My Reviews” focus: read AsyncStorage pending/published |
| 4 | For each review with `orderId` + `handle`: `POST /api/reviews` with Idempotency-Key = local id |
| 5 | Map 409 duplicate → mark local migrated |
| 6 | Dual-read: prefer server list, fall back local for unmigrated |
| 7 | After N days + zero pending: stop writing local; keep read fallback |
| 8 | Judge.me: keep until marketing signs off; then hide widget behind flag |

### B. Local orders → tracking + customer orders API

| Step | Action |
|------|--------|
| 1 | Deploy orders tracking |
| 2 | On account orders open: `POST /api/orders/me/sync` (Shopify truth for paid orders) |
| 3 | Local-only guest/checkout drafts: keep local until paid; then admin register or sync |
| 4 | Tracking fields: prefer timeline API when flag on |
| 5 | Do not drop local cache of list for offline |

### C. Local rewards / locked rewards / balance

| Step | Action |
|------|--------|
| 1 | **Do not import local balance as spendable money** without ledger audit |
| 2 | Display: always `/api/wallet/balance` + `/api/rewards/status` when auth works |
| 3 | Local `NOOD_BALANCE` / locked rewards: treat as **display cache only**, then remove write path |
| 4 | Any promotional local credit never claimed server-side is **forfeited or manually reconciled** via admin — document to ops |

### D. Preferences (push, addresses)

| Step | Action |
|------|--------|
| Push | On login, re-register token with `userId=customerId`; optional `POST /api/orders/me/push-preferences` |
| Addresses | Prefer Shopify customer addresses when available; keep local guest book |

## 9.3 Rollback during migration

- Client flag off → previous local behavior.  
- Server module disable flags where present.  
- Local storage retained until explicit purge job (do not auto-wipe).

---

# 10. Technical debt (remaining)

1. **Central auth header injection** (P0)  
2. **Wire reviews/orders APIs behind flags without UI redesign** (P1)  
3. **Implement or remove client image-search call** (P1)  
4. **Server wallet as only balance UI source** (P1)  
5. **Orders tracking register hook after successful paid order** (P1) — additive call to `adminRegisterOrder` or customer sync  
6. **Reviews media object storage** (P1)  
7. **Inventory readiness check** (P2)  
8. **Render.yaml feature-flag documentation** (P2)  
9. **Unified metrics export / alerts** (P2)  
10. **API versioning strategy** (P3)  
11. **Route ownership doc for `/api/orders`** (P2)  
12. **E2E staging suite** (auth + rewards + checkout + inventory) (P1)

---

# 11. Risk assessment

| Risk | Likelihood | Impact | Residual |
|------|------------|--------|----------|
| Ship rewards without Bearer → customers see broken rewards | High | High | **Critical** |
| Double money sources (local vs Redis) | Medium | Critical | High |
| Order route collision later | Low | High | Medium |
| Media loss on Render disk | High if using local media | Medium | Medium |
| Unmigrated local reviews lost on reinstall | High | Medium | Medium (expected until migration) |
| Camera search silent fail | High | Low | Low |
| Redis outage | Low | Critical | High (fail closed correctly for money) |

---

# 12. Production readiness score

| Category | Weight | Score | Weighted |
|----------|--------|-------|----------|
| Backend correctness & tests | 20% | 8.5 | 1.70 |
| Integration completeness | 15% | 7.0 | 1.05 |
| Client–server contract | 20% | 3.0 | 0.60 |
| Security E2E | 15% | 4.5 | 0.68 |
| Deployment config | 10% | 5.5 | 0.55 |
| Observability | 10% | 6.5 | 0.65 |
| Migration readiness | 10% | 5.0 | 0.50 |
| **Total** | 100% | | **5.73 / 10** |

**Rounded overall: 5.5 / 10 — architecture ready; integration not production-complete.**

---

# 13. Recommended sequence (still no new commerce features)

1. **Auth contract fix** — attach Bearer in `backend.ts` / payment fetch from Shopify session (implementation phase after this report).  
2. **Staging matrix** — rewards, refunds, wallet, checkout, inventory, reviews create, orders sync.  
3. **Render env audit** — fill secrets; media strategy; confirm `/ready`.  
4. **Client feature flags** — server reviews / timeline / wallet display off by default.  
5. **Migration jobs** — reviews then orders then kill local wallet writes.  
6. **Only then** resume Advanced Search / Recommendations / Analytics / Gestures / Premium Shopping.

---

# 14. Regression baseline (this phase)

| Suite | Result |
|-------|--------|
| Full `node --test` | **102/102 pass** |
| Includes | rewards, inventory, reviews, orders, refunds, security, webhooks, payments unit tests |

No production code was changed in this validation phase.

---

## Document control

- **Authoring mode:** Read-only audit; documentation only  
- **Companion client copy:** `nood-app/docs/PRODUCTION-INTEGRATION-VALIDATION.md`  
- **Related:** `REWARDS-BACKEND-IMPLEMENTATION.md`, `REVIEWS-BACKEND-IMPLEMENTATION.md`, `ORDERS-TRACKING-IMPLEMENTATION.md`
