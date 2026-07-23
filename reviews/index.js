const { getReviewsConfig } = require('./config');
const { createReviewsStore } = require('./store');
const { createMediaService } = require('./media');
const {
  createReviewsService,
  sanitizeText,
  productKeyFromInput,
} = require('./service');
const { createReviewsRouter } = require('./routes');
const {
  createPurchaseValidatorFromOrderLoader,
  createAlwaysVerifiedPurchaseValidator,
} = require('./purchase');

function mountReviews({
  app,
  redis = null,
  lockService = null,
  requireCustomerAuth,
  requireAdminApiKey,
  namespace = 'nood',
  isProduction = false,
  purchaseValidator = null,
  loadCustomerOrders = null,
  mediaDriverName = null,
} = {}) {
  if (!app) {
    throw new Error('app is required to mount reviews routes');
  }
  if (!requireCustomerAuth) {
    throw new Error('requireCustomerAuth is required to mount reviews routes');
  }
  if (!requireAdminApiKey) {
    throw new Error('requireAdminApiKey is required to mount reviews routes');
  }

  const config = getReviewsConfig();
  const store = createReviewsStore({ redis, namespace });
  const resolvedMediaDriver =
    mediaDriverName ||
    process.env.REVIEWS_MEDIA_DRIVER ||
    (process.env.NODE_ENV === 'test' ? 'memory' : 'local');

  // Production-safe media: refuse ephemeral local disk without public CDN base.
  if (
    String(process.env.NODE_ENV || '').toLowerCase() === 'production' &&
    resolvedMediaDriver === 'local' &&
    !String(process.env.REVIEWS_MEDIA_PUBLIC_BASE_URL || '').trim()
  ) {
    console.warn(
      '[REVIEWS] Production local media without REVIEWS_MEDIA_PUBLIC_BASE_URL is unsafe. Forcing url driver (HTTPS media URLs only).'
    );
  }

  const mediaService = createMediaService({
    config,
    driverName:
      String(process.env.NODE_ENV || '').toLowerCase() === 'production' &&
      resolvedMediaDriver === 'local' &&
      !String(process.env.REVIEWS_MEDIA_PUBLIC_BASE_URL || '').trim()
        ? 'url'
        : resolvedMediaDriver,
  });

  let resolvedPurchaseValidator = purchaseValidator;
  if (!resolvedPurchaseValidator && typeof loadCustomerOrders === 'function') {
    resolvedPurchaseValidator = createPurchaseValidatorFromOrderLoader(loadCustomerOrders);
  }
  if (!resolvedPurchaseValidator && !config.requireVerifiedPurchase) {
    resolvedPurchaseValidator = async () => ({ verified: false, skipped: true });
  }
  if (!resolvedPurchaseValidator && process.env.REVIEWS_PURCHASE_VALIDATOR === 'stub') {
    resolvedPurchaseValidator = createAlwaysVerifiedPurchaseValidator();
  }

  const reviewsService = createReviewsService({
    store,
    mediaService,
    lockService,
    config,
    purchaseValidator: resolvedPurchaseValidator,
  });

  const router = createReviewsRouter({
    reviewsService,
    mediaService,
    requireCustomerAuth,
    requireAdminApiKey,
    isProduction,
  });

  app.use('/api/reviews', router);
  console.log('[REVIEWS] routes mounted at /api/reviews', {
    storeDriver: store.driver,
    mediaDriver: mediaService.driver,
    requireVerifiedPurchase: config.requireVerifiedPurchase,
    autoPublish: config.autoPublish,
    purchaseValidator: Boolean(resolvedPurchaseValidator),
  });

  return {
    reviewsService,
    store,
    mediaService,
    config,
  };
}

module.exports = {
  mountReviews,
  getReviewsConfig,
  createReviewsStore,
  createMediaService,
  createReviewsService,
  createReviewsRouter,
  createPurchaseValidatorFromOrderLoader,
  createAlwaysVerifiedPurchaseValidator,
  sanitizeText,
  productKeyFromInput,
};
