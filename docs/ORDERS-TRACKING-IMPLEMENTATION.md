# Orders & Shipment Tracking — implementation report

**Date:** 2026-07-16  
**Scope:** `nood-backend` orders tracking module + additive mobile API client  
**Policy:** Add-only. Does not redesign UI. Does not replace Shopify order creation, existing refund routes, or local app order storage.

---

## Files added

### Backend (`nood-backend/orders/`)

| File | Purpose |
|------|---------|
| `config.js` | Env-configurable TTLs, rates, push toggles, cancel window |
| `events.js` | Canonical lifecycle event catalog + order statuses |
| `carriers.js` | Carrier registry, tracking URLs, pluggable carrier client |
| `store.js` | Redis/memory: orders, shipments, events, returns, refunds, cache, audit |
| `notifications.js` | Event-driven Expo push (per-event class toggles) |
| `service.js` | Server-authoritative lifecycle logic |
| `routes.js` | `/api/orders` HTTP API |
| `index.js` | `mountOrders()` |
| `tests/orders-service.test.js` | Unit / concurrency / security tests (**11**) |
| `docs/ORDERS-TRACKING-IMPLEMENTATION.md` | This report |

### Mobile (additive only)

| File | Purpose |
|------|---------|
| `utils/orders-tracking-api.ts` | Optional client for tracking APIs (not wired into screens) |

---

## Files modified

| File | Change |
|------|--------|
| `server.js` | Mount `/api/orders`, readiness `orders_tracking_mounted` |
| `.env.example` | `ORDERS_*` knobs |

**Not modified:** order list UI, checkout, `/api/refunds/*`, rewards, reviews, inventory.

---

## Database / storage

Redis namespace `{REDIS_NAMESPACE}:orders:` (memory in tests):

| Map | Purpose |
|-----|---------|
| `order` | Order documents |
| `customer_orders` | Customer → order id set |
| `shopify_index` / `name_index` | Shopify id/name lookup |
| `shipment` / `order_shipments` | Multi-package shipments |
| `tracking_index` | Tracking number → shipment/order |
| `events` | Timeline list (newest-first) |
| `event_dedupe` | Dedup keys (90d TTL) |
| `cancellation` | Cancel requests |
| `return` / `order_returns` | Return/exchange-ready records |
| `refund_status` | Refund status overlay |
| `timeline_cache` | Cached timeline payloads |
| `push_prefs` | Per-customer notification prefs |
| `rate` / `audit` / `metrics` | Limits, audit, counters |

No SQL migration. No change to `pending-orders.json` or payment records.

---

## Shipment / order events

Supported types (each has timestamp, status, description, optional location / tracking / carrier metadata):

`order_placed`, `payment_authorized`, `payment_captured`, `preparing_order`, `packed`, `awaiting_carrier`, `picked_up`, `in_transit`, `customs`, `out_for_delivery`, `delivered`, `delivery_failed`, `returned`, `refund_requested`, `refund_approved`, `refunded`, `cancellation_requested`, `cancelled`, `exchange_requested` (future-ready), `note_added`, `status_updated`, `shipment_created`, `carrier_update`.

---

## API documentation

Base: **`/api/orders`**

### Customer (`Authorization: Bearer <token>`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/me` | List tracked orders (paginated) |
| POST | `/me/sync` | Import/sync from Shopify orders |
| POST | `/me/push-preferences` | Register event push prefs |
| GET | `/:orderId/timeline` | Full timeline + shipments + refund/cancel/returns |
| GET | `/:orderId/shipments` | Packages for order |
| GET | `/:orderId/estimated-delivery` | ETA + window |
| GET | `/:orderId/refund-status` | Refund overlay status |
| GET | `/tracking/:trackingNumber` | Tracking lookup (ownership enforced) |
| POST | `/:orderId/cancel` | Cancellation request |
| POST | `/:orderId/returns` | Return request (`exchangeRequested` future-ready) |
| POST | `/:orderId/notes` | Customer-visible note |

### Admin (`x-nood-admin-api-key`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/admin/register` | Register order into tracking store |
| POST | `/admin/:orderId/shipments` | Create package / tracking |
| POST | `/admin/:orderId/events` | Append lifecycle / carrier event |
| POST | `/admin/:orderId/cancel/resolve` | Approve/reject cancellation |
| POST | `/admin/:orderId/refund-status` | Update refund status |
| POST | `/admin/:orderId/notes` | Admin note |
| GET | `/admin/:orderId/timeline` | Admin timeline (includes customerId) |
| GET | `/metrics/summary` | Metrics |

### Carrier webhook

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/webhooks/carrier` | Ingest carrier event (`x-carrier-webhook-secret` if configured) |

**Unchanged existing APIs:** `POST/GET /api/refunds/requests*`, Shopify order create routes.

### Error codes

`unauthenticated`, `forbidden`, `not_found`, `validation_error`, `rate_limited`, `already_cancelled`, `already_shipped`, `cancel_window_expired`, `cancel_disabled`, `sync_unavailable`, `sync_failed`, `unauthorized`, `internal_error`

---

## Security

| Control | Status |
|---------|--------|
| Customer auth on customer routes | Yes |
| Ownership checks on all order reads/mutations | Yes |
| Admin key on admin routes | Yes |
| Input sanitization on notes/reasons | Yes |
| Rate limits (express + per-customer counters) | Yes |
| Event dedupe under lock (concurrency) | Yes |
| Carrier webhook secret (optional) | Yes |
| Audit log (no tokens) | Yes |
| Push data allow-list / length caps | Yes |

---

## Performance

| Feature | Behavior |
|---------|----------|
| Timeline cache | TTL `ORDERS_TIMELINE_CACHE_TTL` (default 30s) |
| Event pagination | `page` / `pageSize` on timeline |
| Indexes | customer set, shopify id/name, tracking number |
| Background | heartbeat metric; customer sync is on-demand `POST /me/sync` |
| Dedup | Prevents duplicate carrier/admin events |

---

## Push notifications

Configurable via `ORDERS_PUSH_*`. Event classes:

- order confirmation, payment, shipment, out for delivery, delivered, refund, return, cancel  

Uses Expo tokens from `storage.pushTokens` matched by `userId` ≈ customer id. Delivery latency logged; success/failure metrics recorded.

---

## Testing / regression

| Suite | Result |
|-------|--------|
| `tests/orders-service.test.js` | **11/11 pass** |
| reviews | **13/13 pass** |
| rewards | **9/9 pass** |
| inventory | **4/4 pass** |

Covered: seed timeline, multi-package, concurrent dedupe, ownership, cancel policy, refund status, return/exchange flag, push, carrier webhook secret, Shopify sync, cache hits.

---

## Environment variables

```
ORDERS_TRACKING_ENABLED=true
ORDERS_TIMELINE_CACHE_TTL=30
ORDERS_SYNC_INTERVAL_SECONDS=300
ORDERS_BACKGROUND_SYNC_ENABLED=true
ORDERS_PAGE_SIZE_DEFAULT=20
ORDERS_PAGE_SIZE_MAX=50
ORDERS_EVENTS_PAGE_SIZE=30
ORDERS_EVENTS_PAGE_SIZE_MAX=100
ORDERS_RATE_READ_PER_MIN=90
ORDERS_RATE_MUTATE_PER_HOUR=30
ORDERS_RATE_CANCEL_PER_DAY=5
ORDERS_RATE_RETURN_PER_DAY=10
ORDERS_DEFAULT_DELIVERY_DAYS_MIN=5
ORDERS_DEFAULT_DELIVERY_DAYS_MAX=14
ORDERS_ALLOW_CUSTOMER_CANCEL=true
ORDERS_CANCEL_WINDOW_HOURS=2
ORDERS_PUSH_ENABLED=true
ORDERS_PUSH_ORDER_CONFIRMATION=true
ORDERS_PUSH_PAYMENT=true
ORDERS_PUSH_SHIPMENT=true
ORDERS_PUSH_OUT_FOR_DELIVERY=true
ORDERS_PUSH_DELIVERED=true
ORDERS_PUSH_REFUND=true
ORDERS_PUSH_RETURN=true
ORDERS_PUSH_CANCEL=true
ORDERS_CARRIERS_ENABLED=true
ORDERS_CARRIER_WEBHOOK_SECRET=
```

---

## Deployment checklist

1. Deploy backend with `orders/` module.  
2. `REDIS_URL` for multi-instance production.  
3. Shopify order admin token for `POST /api/orders/me/sync`.  
4. Customer storefront token for auth.  
5. Admin API key for admin/shipment events.  
6. Optional: `ORDERS_CARRIER_WEBHOOK_SECRET`, push token registration with `userId`.  
7. Verify `GET /ready` → `orders_tracking_mounted`.  
8. Smoke: unauth timeline → 401; admin register → customer timeline 200.  

### Migration steps

- None required for existing data.  
- After deploy, customers can `POST /api/orders/me/sync` or admin can `POST /api/orders/admin/register` after paid order creation (hook optional, additive).  

### Rollback

1. Redeploy previous backend (`/api/orders` 404).  
2. Existing order UI and refund APIs unchanged.  
3. Redis `*:orders:*` keys harmless or purge by pattern.

---

## Client adoption notes

- **Do not** remove local `customer-orders` or change orders screens yet.  
- `utils/orders-tracking-api.ts` is ready for gradual timeline adoption.  
- Always send Bearer customer token; never trust client-only status.

---

## Remaining roadmap (after Orders)

1. **Advanced Search**  
2. **Recommendation Engine**  
3. **Analytics & Monitoring**  
4. **Native Gestures & Interaction Polish**  
5. **Premium Shopping Enhancements**  

Optional beyond-Temu ideas (modular/configurable only): multi-package split UI, live carrier map deep-links, delivery window preferences, proactive delay alerts.
