# Reviews platform — backend implementation report

**Date:** 2026-07-16  
**Scope:** `nood-backend` reviews module + additive mobile API client  
**Rule:** Server is the sole authority. Additive only. No product UI redesign.

---

## Files added

### Backend (`nood-backend`)

| File | Purpose |
|------|---------|
| `reviews/config.js` | Env-configurable limits, moderation, media, rate limits *(pre-existed; used)* |
| `reviews/store.js` | Redis / in-memory reviews, votes, reports, Q&A, aggregates, audit, metrics |
| `reviews/media.js` | Media storage abstraction (memory / local FS / CDN URL) |
| `reviews/purchase.js` | Verified-purchase validation from Shopify order loader |
| `reviews/service.js` | Server-authoritative business logic |
| `reviews/routes.js` | Public + authenticated + admin HTTP routes |
| `reviews/index.js` | `mountReviews()` wiring |
| `tests/reviews-service.test.js` | Unit / security / edge-case tests (13) |
| `docs/REVIEWS-BACKEND-IMPLEMENTATION.md` | This report |

### Mobile (`nood-app`) — additive only

| File | Purpose |
|------|---------|
| `utils/reviews-api.ts` | Optional client for `/api/reviews` (not wired into product page layout) |

---

## Files modified

| File | Change |
|------|--------|
| `server.js` | Mount `/api/reviews`, readiness checks `reviews_mounted` + `reviews_purchase_validation` |
| `.env.example` | `REVIEWS_*` configuration knobs |
| `nood-app/utils/backend.ts` | Optional `headers` on GET/POST backend helpers (auth Bearer support) |

**Not modified:** product page layout, existing Judge.me UI, rewards, inventory reservation.

---

## Database / storage model

No SQL migrations. Redis key namespaces under `{REDIS_NAMESPACE}:reviews:` (in-memory for tests):

| Map | Key pattern | Contents |
|-----|-------------|----------|
| `review` | `{reviewId}` | Full review document |
| `product_index` | `{productKey}` | Set of review IDs |
| `customer_index` | `{customerId}` | Set of review IDs |
| `uniq` | `{customerId}:{productKey}:{orderItemId}` | Duplicate prevention |
| `moderation_queue` | `pending` | Pending review IDs |
| `aggregate` | `{productKey}` | Cached average / histogram / counts |
| `vote` | `{reviewId}:{customerId}` | Helpful / not_helpful |
| `report` / `report_by_id` | … | Abuse reports |
| `reports_open` | `open` | Open report IDs |
| `media` / `media_index` | … | Media metadata |
| `question` / `question_index` | … | Product Q&A |
| `question_moderation` | `pending` | Pending questions |
| `qa_vote` | … | Q&A helpful votes |
| `idempotency` | `{customerId}:{key}` | Mutation replay |
| `rate` / `spam` | … | Rate limit + spam fingerprints |
| `audit` | `global` | Audit log list |
| `metrics` | `{name}` | Counters |

### Indexes (logical)

- Product → reviews (set)
- Customer → reviews (set)
- Uniqueness on customer + product + order line
- Aggregate cache per product (TTL `REVIEWS_AGGREGATE_CACHE_TTL`)

### Review document (conceptual)

`id, productKey, productId, productHandle, customerId, customerDisplayName, orderId, orderItemId, variantId, rating (1–5), title, comment, media[], verifiedPurchase, status (pending|approved|rejected|hidden|deleted), helpfulCount, notHelpfulCount, reportCount, reply, moderation fields, timestamps, risk hashes`

---

## API documentation

Base path: **`/api/reviews`**

### Public (no auth)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/reviews?productHandle=&productId=&page=&pageSize=&sort=&rating=&verified=&withMedia=&q=` | List + aggregate |
| GET | `/api/reviews/products/:productKey` | Same by handle or id in path |
| GET | `/api/reviews/products/:productKey/summary` | Aggregate only |
| GET | `/api/reviews/:reviewId` | Single public review |
| GET | `/api/reviews/questions?productHandle=&q=&page=&sort=` | List product Q&A |

### Customer auth (`Authorization: Bearer <Shopify customer access token>`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/reviews/me/reviews` | My reviews |
| POST | `/api/reviews` | Create review (idempotency key supported) |
| PATCH | `/api/reviews/:reviewId` | Edit (within edit window) |
| DELETE | `/api/reviews/:reviewId` | Soft-delete (within delete window) |
| POST | `/api/reviews/:reviewId/vote` | `{ "vote": "helpful" \| "not_helpful" \| "none" }` |
| POST | `/api/reviews/:reviewId/report` | `{ "reason", "details?" }` |
| POST | `/api/reviews/media` | Stage media (base64 `data`+`mime` or HTTPS `url`) |
| POST | `/api/reviews/questions` | Ask a product question |
| POST | `/api/reviews/questions/:id/vote` | Mark question helpful |

### Admin (`x-nood-admin-api-key` / `x-admin-key`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/reviews/moderation/queue` | Pending reviews |
| POST | `/api/reviews/:reviewId/moderate` | `{ "action": "approve\|reject\|hide\|unhide\|delete", "note?" }` |
| POST | `/api/reviews/:reviewId/reply` | Seller/admin reply `{ "body", "authorType?" }` |
| POST | `/api/reviews/questions/:id/answers` | Answer Q&A |
| POST | `/api/reviews/questions/:id/moderate` | Moderate question |
| GET | `/api/reviews/metrics/summary` | Counters + drivers |

### Create review body (example)

```json
{
  "productHandle": "lace-front-wig",
  "orderId": "#1234",
  "orderItemId": "line-1",
  "rating": 5,
  "title": "Great quality",
  "comment": "Exactly as shown. Shipping was fast.",
  "media": [
    { "url": "https://cdn.example.com/r1.jpg", "mime": "image/jpeg", "sizeBytes": 120000 }
  ],
  "customerDisplayName": "Alex"
}
```

Headers: `Authorization: Bearer …`, optional `Idempotency-Key`.

### Stable error codes

`unauthenticated`, `forbidden`, `not_found`, `validation_error`, `duplicate_review`, `duplicate_report`, `duplicate_vote`, `not_verified_purchase`, `purchase_validation_unavailable`, `spam_detected`, `rate_limited`, `edit_window_expired`, `delete_window_expired`, `media_too_large`, `invalid_media_type`, `invalid_media_url`, `reviews_disabled`, `media_unavailable`, `conflict`, `internal_error`

### Sort / filter

- **sort:** `newest` (default), `oldest`, `highest`, `lowest`, `helpful`
- **filters:** `rating`, `verified=1`, `withMedia=1`, `q` (text search)

---

## Security impact

| Control | Status |
|---------|--------|
| Auth required on mutations | Yes |
| Auth subject sole customer identity | Yes (`customerId` body never trusted for authz) |
| Ownership checks on edit/delete/vote | Yes |
| Verified purchase enforcement | Yes (Shopify order loader; fail-closed if required & unavailable) |
| XSS protection (strip tags / handlers) | Yes |
| Rate limiting (IP express + per-customer counters) | Yes |
| Spam / duplicate content fingerprint | Yes |
| Duplicate review prevention | Yes |
| Report auto-hide threshold | Yes |
| Admin moderation gated by admin API key | Yes |
| Audit log (no tokens; IP hashed) | Yes |
| Media type + size validation | Yes |
| HTTPS-only remote media URLs | Yes |

---

## Performance impact

| Area | Behavior |
|------|----------|
| List reviews | Load product index set → filter/sort in process → page slice |
| Aggregates | Cached with TTL; recomputed on publish/hide/delete/moderate |
| Pagination | `page` / `pageSize` (capped by `REVIEWS_PAGE_SIZE_MAX`) |
| Lazy loading | Client can page; summary endpoint avoids full list |
| Background | Aggregate recompute is inline on write (fast for Redis sets); metrics counters O(1) |

**Scale note:** For very large review volumes, migrate product indexes to Redis sorted sets and move filter/sort server-side; current design matches rewards store patterns and is production-ready for typical catalog sizes.

---

## Monitoring

- Console audit: `[REVIEWS AUDIT] { event, customerId, reviewId, … }`
- Redis/memory audit list + metric counters
- Admin: `GET /api/reviews/metrics/summary`
- Readiness: `GET /ready` → `reviews_mounted`, `reviews_purchase_validation`

---

## Testing / regression report

| Suite | Result |
|-------|--------|
| `node --test tests/reviews-service.test.js` | **13/13 pass** |
| `node --test tests/rewards-service.test.js` | **9/9 pass** |
| `node --test tests/inventory-reservation.test.js` | **4/4 pass** |
| `node --test tests/security.test.js` | **4/4 pass** |

Covered: verified purchase, idempotency, duplicates, aggregates/histogram, votes, reports/auto-hide, moderation, edit/delete ownership, seller reply, Q&A, XSS sanitize, media HTTPS validation, fail-closed validator.

---

## Deployment requirements

1. Deploy backend with `reviews/` module mounted (this change set).
2. Ensure `REDIS_URL` + `STORAGE_DRIVER=redis` for multi-instance production.
3. `SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN` (or order admin token used by `fetchShopifyCustomerOrders`) for verified purchases.
4. `SHOPIFY_STOREFRONT_ACCESS_TOKEN` for customer auth middleware.
5. `ADMIN_API_KEY` / `NOOD_ADMIN_API_KEY` for moderation.
6. Optional media CDN: set `REVIEWS_MEDIA_PUBLIC_BASE_URL` and/or `REVIEWS_MEDIA_DRIVER=local|url|memory`.
7. Apply `REVIEWS_*` knobs from `.env.example` as needed.
8. Verify:
   - `GET /ready` includes `reviews_mounted: ok`
   - `GET /api/reviews?productHandle=test` → 200
   - Unauthenticated `POST /api/reviews` → 401
   - Admin moderation without key → 401

### Staging matrix

- Create review with valid order vs invalid order  
- Duplicate create / idempotent replay  
- Edit outside window  
- Vote self vs other  
- Report threshold auto-hide  
- Approve pending review → appears in public list  
- Q&A create + answer + helpful vote  
- Media oversized / wrong mime  

---

## Rollback procedure

1. Redeploy previous backend release ( `/api/reviews` unmounted → 404 ).  
2. Mobile product page unchanged (still uses existing local/Judge.me paths).  
3. Redis keys under `{namespace}:reviews:*` can remain (harmless) or be deleted if a full reset is required.  
4. Soft-deleted and moderated content is retained until hard purge; no automatic data destruction on rollback.

---

## Client adoption (out of scope for UI redesign)

- Product page layout **not** changed.  
- `utils/reviews-api.ts` is available for gradual adoption.  
- Existing `customer-reviews.ts` local storage and Judge.me widget remain intact.  
- When wiring live reviews, always send `Authorization: Bearer <customer access token>` on mutations; never invent verified badges client-side.

---

## Configuration reference

| Env | Default | Meaning |
|-----|---------|---------|
| `REVIEWS_ENABLED` | true | Feature flag |
| `REVIEWS_REQUIRE_VERIFIED_PURCHASE` | true | Enforce purchase check |
| `REVIEWS_AUTO_PUBLISH` | false | Skip moderation queue |
| `REVIEWS_ALLOW_EDIT_HOURS` | 48 | Customer edit window |
| `REVIEWS_ALLOW_DELETE_HOURS` | 24 | Customer delete window |
| `REVIEWS_SOFT_DELETE_ONLY` | true | Soft delete default |
| `REVIEWS_MIN_COMMENT_LENGTH` | 10 | Min body length |
| `REVIEWS_MAX_MEDIA_PER_REVIEW` | 8 | Media cap |
| `REVIEWS_MAX_IMAGE_BYTES` | 5MB | Image size |
| `REVIEWS_MAX_VIDEO_BYTES` | 40MB | Video size |
| `REVIEWS_MEDIA_DIR` | `./uploads/reviews` | Local storage root |
| `REVIEWS_MEDIA_PUBLIC_BASE_URL` | empty | CDN base URL |
| `REVIEWS_MEDIA_DRIVER` | local | `local` \| `memory` \| `url` |
| `REVIEWS_REPORT_AUTO_HIDE` | 5 | Reports before auto-hide |
| `REVIEWS_AGGREGATE_CACHE_TTL` | 60 | Aggregate cache seconds |
| `REVIEWS_PURCHASE_VALIDATOR` | — | Set `stub` only for demos without Shopify orders |
