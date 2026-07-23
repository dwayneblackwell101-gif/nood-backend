# P0 — Empty catalog + product detail (1 image / 0 variants / sold out)

## Live evidence (pre-fix)

| Endpoint | Result |
|----------|--------|
| `GET /api/catalog/version` | `catalogVersion: 0` |
| `GET /api/catalog/products?limit=3` | `edges: []`, `total: 0` |
| `GET /api/catalog/products/:handle` | **404** Product not found |
| `GET /api/catalog/collections/:handle/products` | **404** Collection not found in catalog cache |
| Sync status | `productCount: 2785` reported historically, status `failed` (incomplete sync) |

## How that maps to mobile logs

| Mobile log | Cause |
|------------|--------|
| `Frontend received product images: 1` | API 404 → route preview only (1 featured image) |
| `variants count 0` | Preview has no variants |
| `availableForSale false` / `soldOut true` | Preview lacks stock flags → sold out |
| `Collection not found in catalog cache` | Collections hash empty under unreadable catalog version |

**Not a mobile bug.** Backend returns empty/missing catalog.

## First collapse stage

### Catalog reads (global)

```
getActiveVersionId() → empty or empty product hash
getReadVersionId() → '__missing_active__' (when legacy fallback false)
getReadKeys() → nood:catalog:version:__missing_active__:products  (always empty)
```

**File:** `catalog/cache/redis-cache.js`  
**Function:** `getReadVersionId` (pre-fix)

Products/collections may still exist under:

- a previous version id
- a staging version never activated
- legacy `nood:catalog:products:h`

But the API did not read them.

### Product detail shape (secondary, when hydrate runs)

| Stage | Risk |
|-------|------|
| `transformStorefrontProduct` | `Boolean(undefined)` → `availableForSale: false` if product AFS not queried |
| `mergeRicherProductDetail` | Fill spread / empty variants can wipe stock |
| `formatCachedProductDetail` | `Boolean(product.availableForSale)` → false when missing |

## Fix (commit `59000dc`)

1. **Auto-recover active catalog version** from previous / richest version / legacy hash  
2. **Default legacy read fallback on** (do not invent empty `__missing_active__` unless explicitly denied)  
3. **Storefront detail query** includes `availableForSale` + variant qty  
4. **Hydrate merge** preserves variants/stock while upgrading gallery  
5. **formatCachedProductDetail** derives AFS from variants  
6. **Pipeline logs** `[NOOD pipeline]` per stage  

## After Render deploy

1. Hit `GET /api/catalog/version` → expect `productCount > 0`  
2. Hit collections + product detail → expect full gallery, variants, AFS  
3. If still empty: no Redis catalog data at all → run  
   `POST /api/catalog/sync/shopify/products?restart=true` (admin key)  
   until activation completes  

## Unchanged

Mobile app, ProductDetail UI, sold-out client logic.
