import { z } from 'zod';

export const CatalogV2ConfigSchema = z.object({
  // Shopify Admin API
  SHOPIFY_STORE_DOMAIN: z.string().min(1),
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().min(1),
  SHOPIFY_ADMIN_API_VERSION: z.string().default('2025-10'),

  // Shopify Storefront API (for hydrate fallback)
  SHOPIFY_STOREFRONT_ACCESS_TOKEN: z.string().min(1),
  SHOPIFY_STOREFRONT_API_VERSION: z.string().default('2025-10'),

  // Cache
  REDIS_URL: z.string().optional(),
  REDIS_NAMESPACE: z.string().default('nood'),
  CATALOG_LEGACY_FALLBACK_ENABLED: z.string().transform(v => v === 'true').default('true'),

  // Sync configuration
  SYNC_MAX_PRODUCTS: z.string().transform(v => parseInt(v, 10)).optional(),
  SYNC_PAGE_SIZE: z.string().transform(v => parseInt(v, 10)).default('100'),
  SYNC_INTER_PAGE_DELAY_MS: z.string().transform(v => parseInt(v, 10)).default('400'),
  SYNC_MAX_GRAPHQL_ATTEMPTS: z.string().transform(v => parseInt(v, 10)).default('15'),

  // Validation
  VALIDATION_ENABLED: z.string().transform(v => v === 'true').default('true'),
  VALIDATION_MIN_PRODUCT_COUNT: z.string().transform(v => parseInt(v, 10)).optional(),
  VALIDATION_MAX_COUNT_DROP_PERCENT: z.string().transform(v => parseInt(v, 10)).default('50'),

  // Environment
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type CatalogV2Config = z.infer<typeof CatalogV2ConfigSchema>;

let configCache: CatalogV2Config | null = null;

export function loadConfig(): CatalogV2Config {
  if (configCache) return configCache;

  const result = CatalogV2ConfigSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues.map(issue =>
      `${issue.path.join('.')}: ${issue.message}`
    ).join('\n');
    throw new Error(`Catalog v2 config validation failed:\n${errors}`);
  }

  configCache = result.data;
  return configCache;
}

export function resetConfig() {
  configCache = null;
}