# RC1 — Global Sold Out Regression (after gallery hydrate)

## Root cause

**First place stock changes to sold-out:** gallery hydrate path in `catalog/routes.js`.

### Exact mechanism

1. `isProductDetailCacheThin()` triggers Shopify Storefront hydrate for thin (1-image) cache rows.
2. `STOREFRONT_PRODUCT_DETAIL_QUERY` did **not** request product-level `availableForSale`.
3. `transformStorefrontProduct()` did:
   ```js
   availableForSale: Boolean(node.availableForSale) // Boolean(undefined) === false
   ```
4. `mergeRicherProductDetail()` did:
   ```js
   return { ...baseProduct, ...fillProduct, ... }
   ```
   so fill’s `availableForSale: false` **overwrote** cache `true`.
5. When storefront returned **more** variant edges than cache, fill variants replaced base variants (and could drop `quantityAvailable`).
6. Result was written back to Redis via `cache.setProduct`, poisoning stock for every hydrated product.
7. `formatCachedProductDetail()` used `Boolean(product.availableForSale)` again → false when missing.

Gallery images/HTML upgrades were correct; **stock was collateral damage**.

### Not the root cause

- Mobile sold-out UI (it correctly reads API `availableForSale` / variant flags)
- Multi-image `CACHE_MAX_IMAGES = 30` itself
- Description HTML length fix

## Files / lines

| File | What broke |
|------|------------|
| `catalog/shopify.js` | Storefront detail query missing product `availableForSale` + variant qty |
| `catalog/transform.js` `transformStorefrontProduct` | `Boolean(undefined)` → false |
| `catalog/routes.js` `mergeRicherProductDetail` | Naive `...fillProduct` stock overwrite |
| `catalog/routes.js` `formatCachedProductDetail` | `Boolean(product.availableForSale)` default false |
| `catalog/routes.js` `hydrateThinProductDetail` | Wrote poisoned stock back to Redis |

## Fix (commit `7314788`)

- Storefront query: `availableForSale`, `quantityAvailable`, `currentlyNotInStock`
- Storefront transform: derive product AFS from variants when field omitted
- Stock-aware merge: prefer in-stock base; never let fill force false over true; merge variants by id keeping qty
- format + list DTO: missing AFS does not become sold out if any variant is for sale
- compact: do not invent `quantityAvailable: 0` from null; preserve `currentlyNotInStock`

Gallery / description / hydrate image upgrades **kept**.

## Verification

Unit tests: `tests/catalog-stock-hydrate.test.js` (+ gallery tests) — **11/11 pass**

Reproduced failure then fix:

| Stage | Before fix | After fix |
|-------|------------|-----------|
| Base cache | AFS true, qty 5/3 | same |
| Storefront fill (no product AFS) | AFS **false** | AFS **true** (from variants) |
| After merge | AFS **false** | AFS **true**, qty 5/3 |
| After compact | AFS **false** | AFS **true** |
| Gallery | upgraded to 3 | still upgraded to 3 |

## Deploy notes

1. Deploy backend `7314788` (or later) to Render.
2. Live API was also observed with **empty catalog** (`productCount=0`, `catalogVersion=0`) after prior deploys — if still empty, run full catalog sync so Redis has products again.
3. Hydrated sold-out rows rewrite on next detail open (hydrate re-merge) or full re-sync.
