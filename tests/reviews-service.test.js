const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createReviewsStore,
  createMediaService,
  createReviewsService,
  createAlwaysVerifiedPurchaseValidator,
  sanitizeText,
  productKeyFromInput,
  getReviewsConfig,
} = require('../reviews');

function createService(overrides = {}) {
  const store = createReviewsStore();
  const config = getReviewsConfig({
    REVIEWS_AUTO_PUBLISH: 'true',
    REVIEWS_REQUIRE_VERIFIED_PURCHASE: 'true',
    REVIEWS_MIN_COMMENT_LENGTH: '10',
    REVIEWS_REPORT_AUTO_HIDE: '3',
    REVIEWS_AGGREGATE_CACHE_TTL: '60',
    ...overrides.env,
  });
  // getReviewsConfig reads process.env; override via direct config merge
  const merged = {
    ...config,
    autoPublish: overrides.autoPublish ?? true,
    requireVerifiedPurchase: overrides.requireVerifiedPurchase ?? true,
    minCommentLength: overrides.minCommentLength ?? 10,
    reportAutoHideThreshold: overrides.reportAutoHideThreshold ?? 3,
    allowEditHours: overrides.allowEditHours ?? 48,
    allowDeleteHours: overrides.allowDeleteHours ?? 24,
    spamMaxSameComment: overrides.spamMaxSameComment ?? 2,
    ...overrides.config,
  };
  const mediaService = createMediaService({ config: merged, driverName: 'memory' });
  const purchaseValidator =
    overrides.purchaseValidator !== undefined
      ? overrides.purchaseValidator
      : createAlwaysVerifiedPurchaseValidator();
  const service = createReviewsService({
    store,
    mediaService,
    config: merged,
    purchaseValidator,
    nowFn: overrides.nowFn || (() => new Date('2026-07-16T12:00:00.000Z')),
  });
  return { service, store, mediaService, config: merged };
}

test('sanitizeText strips tags and scripts', () => {
  const clean = sanitizeText('<script>alert(1)</script>Great shoe onclick=x', 100);
  assert.equal(clean.includes('<script>'), false);
  assert.equal(clean.includes('alert'), true);
  assert.ok(clean.toLowerCase().includes('great shoe'));
});

test('productKeyFromInput prefers handle', () => {
  assert.equal(productKeyFromInput({ productHandle: 'Nike-Air', productId: '1' }), 'handle:nike-air');
  assert.equal(productKeyFromInput({ productId: 'gid://shopify/Product/9' }), 'id:gid://shopify/Product/9');
});

test('create review requires verified purchase and publishes when autoPublish', async () => {
  const { service } = createService();
  const customerId = 'gid://shopify/Customer/1001';

  await assert.rejects(
    () =>
      service.createReview(customerId, {
        productHandle: 'lace-front-wig',
        rating: 5,
        comment: 'Absolutely love this product quality.',
      }),
    /orderId required|verified purchase/i
  );

  const created = await service.createReview(
    customerId,
    {
      productHandle: 'lace-front-wig',
      orderId: 'ORDER-100',
      orderItemId: 'line-1',
      rating: 5,
      title: 'Amazing',
      comment: 'Absolutely love this product quality.',
      customerDisplayName: 'Alex',
    },
    {},
    'idem-1'
  );

  assert.equal(created.success, true);
  assert.equal(created.review.verifiedPurchase, true);
  assert.equal(created.review.status, 'approved');
  assert.equal(created.review.rating, 5);

  const replay = await service.createReview(
    customerId,
    {
      productHandle: 'lace-front-wig',
      orderId: 'ORDER-100',
      orderItemId: 'line-1',
      rating: 5,
      comment: 'Absolutely love this product quality.',
    },
    {},
    'idem-1'
  );
  assert.equal(replay.idempotentReplay, true);
});

test('duplicate review for same purchase is rejected', async () => {
  const { service } = createService();
  const customerId = 'gid://shopify/Customer/1002';
  const body = {
    productHandle: 'sneaker-x',
    orderId: 'ORDER-200',
    orderItemId: 'line-2',
    rating: 4,
    comment: 'Solid everyday sneakers for walking.',
  };
  await service.createReview(customerId, body);
  await assert.rejects(() => service.createReview(customerId, body), /already reviewed/i);
});

test('list product reviews returns aggregate histogram and pagination', async () => {
  const { service } = createService();
  for (let i = 0; i < 3; i += 1) {
    await service.createReview(`gid://shopify/Customer/2${i}`, {
      productHandle: 'hoodie',
      orderId: `O-${i}`,
      orderItemId: `L-${i}`,
      rating: i === 0 ? 5 : 4,
      comment: `Great hoodie number ${i} and quality fabric.`,
    });
  }

  const page = await service.listProductReviews({
    productHandle: 'hoodie',
    page: 1,
    pageSize: 2,
    sort: 'highest',
  });
  assert.equal(page.success, true);
  assert.equal(page.total, 3);
  assert.equal(page.reviews.length, 2);
  assert.equal(page.aggregate.reviewCount, 3);
  assert.ok(page.aggregate.averageRating >= 4);
  assert.equal(page.aggregate.ratingHistogram[5], 1);
  assert.equal(page.aggregate.ratingHistogram[4], 2);
  assert.equal(page.aggregate.verifiedCount, 3);
});

test('helpful votes and self-vote forbidden', async () => {
  const { service } = createService();
  const author = 'gid://shopify/Customer/3001';
  const voter = 'gid://shopify/Customer/3002';
  const created = await service.createReview(author, {
    productHandle: 'cap',
    orderId: 'O-CAP',
    orderItemId: '1',
    rating: 5,
    comment: 'Perfect fit and great colorway choice.',
  });
  const reviewId = created.review.id;

  await assert.rejects(() => service.voteHelpful(author, reviewId, 'helpful'), /own review/i);

  const vote = await service.voteHelpful(voter, reviewId, 'helpful');
  assert.equal(vote.helpfulCount, 1);

  const flip = await service.voteHelpful(voter, reviewId, 'not_helpful');
  assert.equal(flip.helpfulCount, 0);
  assert.equal(flip.notHelpfulCount, 1);
});

test('report auto-hides after threshold', async () => {
  const { service } = createService({ reportAutoHideThreshold: 2 });
  const author = 'gid://shopify/Customer/4001';
  const created = await service.createReview(author, {
    productHandle: 'bag',
    orderId: 'O-BAG',
    orderItemId: '1',
    rating: 1,
    comment: 'Not what I expected from the photos.',
  });
  const reviewId = created.review.id;

  await service.reportReview('gid://shopify/Customer/4002', reviewId, { reason: 'spam' });
  const second = await service.reportReview('gid://shopify/Customer/4003', reviewId, {
    reason: 'abuse',
  });
  assert.equal(second.reviewStatus, 'hidden');

  const listed = await service.listProductReviews({ productHandle: 'bag' });
  assert.equal(listed.total, 0);
});

test('moderation approve publishes pending review', async () => {
  const { service } = createService({ autoPublish: false });
  const created = await service.createReview('gid://shopify/Customer/5001', {
    productHandle: 'watch',
    orderId: 'O-W',
    orderItemId: '1',
    rating: 5,
    comment: 'Looks premium and keeps accurate time.',
  });
  assert.equal(created.review.status, 'pending');

  let listed = await service.listProductReviews({ productHandle: 'watch' });
  assert.equal(listed.total, 0);

  const mod = await service.moderateReview('admin-1', created.review.id, { action: 'approve' });
  assert.equal(mod.review.status, 'approved');

  listed = await service.listProductReviews({ productHandle: 'watch' });
  assert.equal(listed.total, 1);
});

test('edit and delete respect ownership and policy windows', async () => {
  const { service } = createService();
  const customerId = 'gid://shopify/Customer/6001';
  const created = await service.createReview(customerId, {
    productHandle: 'tee',
    orderId: 'O-T',
    orderItemId: '1',
    rating: 3,
    comment: 'Average quality for the price point.',
  });

  await assert.rejects(
    () =>
      service.updateReview('gid://shopify/Customer/9999', created.review.id, {
        rating: 5,
        comment: 'Trying to hijack someone else review text.',
      }),
    /own reviews/i
  );

  const updated = await service.updateReview(customerId, created.review.id, {
    rating: 4,
    comment: 'Updated thoughts after a week of wear.',
  });
  assert.equal(updated.review.rating, 4);
  assert.ok(updated.review.editedAt);

  const deleted = await service.deleteReview(customerId, created.review.id);
  assert.equal(deleted.deleted, true);

  const listed = await service.listProductReviews({ productHandle: 'tee' });
  assert.equal(listed.total, 0);
});

test('seller reply and product Q&A flow', async () => {
  const { service } = createService({ autoPublish: true });
  const customerId = 'gid://shopify/Customer/7001';
  const created = await service.createReview(customerId, {
    productHandle: 'boots',
    orderId: 'O-B',
    orderItemId: '1',
    rating: 4,
    comment: 'Comfortable boots after break-in period.',
  });

  const replied = await service.replyToReview('seller-1', created.review.id, {
    body: 'Thanks for the feedback! Glad they broke in well.',
  });
  assert.equal(replied.review.reply.authorType, 'seller');
  assert.ok(replied.review.reply.body.includes('Thanks'));

  const q = await service.createQuestion(customerId, {
    productHandle: 'boots',
    question: 'Do these run true to size?',
  });
  assert.equal(q.success, true);

  await service.answerQuestion('admin', q.question.id, { body: 'Yes, order your normal size.' }, 'admin');
  const listed = await service.listQuestions({ productHandle: 'boots' });
  assert.equal(listed.total, 1);
  assert.equal(listed.questions[0].answers.length, 1);

  const vote = await service.voteQuestionHelpful('gid://shopify/Customer/7002', q.question.id);
  assert.equal(vote.helpfulCount, 1);
});

test('XSS payload is sanitized on create', async () => {
  const { service } = createService();
  const created = await service.createReview('gid://shopify/Customer/8001', {
    productHandle: 'xss-prod',
    orderId: 'O-X',
    orderItemId: '1',
    rating: 5,
    comment: '<img src=x onerror=alert(1)> Really nice product overall.',
  });
  assert.equal(created.review.comment.includes('<img'), false);
  assert.equal(created.review.comment.toLowerCase().includes('onerror'), false);
});

test('media url validation rejects non-https', async () => {
  const { service } = createService();
  await assert.rejects(
    () =>
      service.createReview('gid://shopify/Customer/9001', {
        productHandle: 'media-prod',
        orderId: 'O-M',
        orderItemId: '1',
        rating: 5,
        comment: 'Photo review with attached product image.',
        media: [{ url: 'http://insecure.example/a.jpg', mime: 'image/jpeg' }],
      }),
    /https/i
  );

  const ok = await service.createReview('gid://shopify/Customer/9001', {
    productHandle: 'media-prod',
    orderId: 'O-M',
    orderItemId: '1',
    rating: 5,
    comment: 'Photo review with attached product image.',
    media: [{ url: 'https://cdn.example.com/a.jpg', mime: 'image/jpeg', sizeBytes: 1200 }],
  });
  assert.equal(ok.review.media.length, 1);
  assert.equal(ok.review.media[0].type, 'image');
});

test('fail closed when verified purchase required without validator', async () => {
  const { service } = createService({
    purchaseValidator: null,
    requireVerifiedPurchase: true,
  });
  await assert.rejects(
    () =>
      service.createReview('gid://shopify/Customer/9101', {
        productHandle: 'closed',
        orderId: 'O-1',
        rating: 5,
        comment: 'Should not create without validator wired.',
      }),
    /unavailable|verified/i
  );
});
