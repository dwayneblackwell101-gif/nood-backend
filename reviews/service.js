/**
 * Server-authoritative reviews + product Q&A business logic.
 * Auth subject is the only customer identity. Purchase verification is server-side.
 */

const crypto = require('crypto');
const { getReviewsConfig } = require('./config');
const { normalizeShopifyCustomerId } = require('../auth/customer-auth');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function errorWithCode(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

/** Strip tags / scripts for stored review text (XSS protection). */
function sanitizeText(input, maxLen) {
  let text = String(input || '');
  text = text.replace(/<[^>]*>/g, ' ');
  text = text.replace(/javascript:/gi, '');
  text = text.replace(/on\w+\s*=/gi, '');
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (maxLen && text.length > maxLen) {
    text = text.slice(0, maxLen);
  }
  return text;
}

function productKeyFromInput({ productId, productHandle }) {
  const handle = safeString(productHandle).toLowerCase();
  const id = safeString(productId);
  if (handle) return `handle:${handle}`;
  if (id) return `id:${id}`;
  return '';
}

function hashComment(comment) {
  return crypto.createHash('sha256').update(safeString(comment).toLowerCase()).digest('hex').slice(0, 24);
}

function hoursBetween(fromIso, toDate) {
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from)) return Infinity;
  return (toDate.getTime() - from) / (60 * 60 * 1000);
}

function createReviewsService({
  store,
  mediaService,
  config = getReviewsConfig(),
  lockService = null,
  purchaseValidator = null,
  nowFn = () => new Date(),
} = {}) {
  if (!store) {
    throw new Error('Reviews store is required.');
  }
  if (!mediaService) {
    throw new Error('Reviews media service is required.');
  }

  async function audit(event, detail = {}) {
    const entry = {
      event,
      at: nowFn().toISOString(),
      ...detail,
      token: undefined,
    };
    await store.pushAudit(entry);
    await store.incrMetric(`event:${event}`);
    console.log('[REVIEWS AUDIT]', {
      event,
      customerId: detail.customerId || null,
      reviewId: detail.reviewId || null,
      productKey: detail.productKey || null,
      code: detail.code || null,
      success: detail.success,
    });
  }

  async function withLock(key, fn) {
    if (!lockService?.withLock) {
      return fn();
    }
    return lockService.withLock(`reviews:${safeString(key)}`, 15, fn);
  }

  async function checkRate(bucket, limit, windowSeconds = 3600) {
    const count = await store.incrRate(bucket, windowSeconds);
    if (count > limit) {
      throw errorWithCode('Too many requests. Please try again later.', 429, 'rate_limited');
    }
  }

  function publicReview(review, { includeModeration = false } = {}) {
    if (!review) return null;
    const media = Array.isArray(review.media) ? review.media : [];
    const base = {
      id: review.id,
      productId: review.productId || null,
      productHandle: review.productHandle || null,
      rating: review.rating,
      title: review.title || '',
      comment: review.comment || '',
      media: media.map((m) => ({
        id: m.id,
        type: m.type,
        url: m.url,
        mime: m.mime,
        sizeBytes: m.sizeBytes,
        sortOrder: m.sortOrder,
      })),
      verifiedPurchase: Boolean(review.verifiedPurchase),
      status: review.status,
      helpfulCount: Number(review.helpfulCount || 0),
      notHelpfulCount: Number(review.notHelpfulCount || 0),
      reply: review.reply
        ? {
            body: review.reply.body,
            authorType: review.reply.authorType,
            createdAt: review.reply.createdAt,
            updatedAt: review.reply.updatedAt,
          }
        : null,
      customerDisplayName: review.customerDisplayName || 'Customer',
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      editedAt: review.editedAt || null,
    };
    if (includeModeration) {
      base.customerId = review.customerId;
      base.orderId = review.orderId;
      base.orderItemId = review.orderItemId;
      base.reportCount = Number(review.reportCount || 0);
      base.moderationNote = review.moderationNote || null;
      base.moderatedAt = review.moderatedAt || null;
      base.deletedAt = review.deletedAt || null;
    }
    return base;
  }

  function isPubliclyVisible(review) {
    return review && review.status === 'approved' && !review.deletedAt;
  }

  async function loadReviewsByIds(ids) {
    const out = [];
    for (const id of ids) {
      const review = await store.getReview(id);
      if (review) out.push(review);
    }
    return out;
  }

  async function recomputeAggregate(productKey) {
    const ids = await store.getReviewIdsForProduct(productKey);
    const reviews = await loadReviewsByIds(ids);
    const visible = reviews.filter(isPubliclyVisible);
    const histogram = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    let mediaReviewCount = 0;
    let verifiedCount = 0;

    for (const review of visible) {
      const rating = Math.min(5, Math.max(1, Number(review.rating) || 1));
      histogram[rating] = (histogram[rating] || 0) + 1;
      sum += rating;
      if (Array.isArray(review.media) && review.media.length) mediaReviewCount += 1;
      if (review.verifiedPurchase) verifiedCount += 1;
    }

    const reviewCount = visible.length;
    const averageRating = reviewCount ? Math.round((sum / reviewCount) * 10) / 10 : 0;
    const aggregate = {
      productKey,
      averageRating,
      reviewCount,
      ratingHistogram: histogram,
      mediaReviewCount,
      verifiedCount,
      updatedAt: nowFn().toISOString(),
    };
    await store.saveAggregate(aggregate, config.aggregateCacheTtlSeconds);
    await store.incrMetric('aggregate_recompute');
    return aggregate;
  }

  async function getProductAggregate(productKey) {
    const cached = await store.getAggregate(productKey);
    if (cached && cached.reviewCount != null && cached.updatedAt) {
      const ageMs = nowFn().getTime() - new Date(cached.updatedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs < config.aggregateCacheTtlSeconds * 1000) {
        await store.incrMetric('aggregate_cache_hit');
        return cached;
      }
    }
    await store.incrMetric('aggregate_cache_miss');
    return recomputeAggregate(productKey);
  }

  async function resolvePurchase({
    customerId,
    productId,
    productHandle,
    orderId,
    orderItemId,
    variantId,
  }) {
    if (!config.requireVerifiedPurchase) {
      return { verified: false, skipped: true };
    }
    if (typeof purchaseValidator !== 'function') {
      // Fail closed when verification is required but no validator is wired.
      throw errorWithCode(
        'Verified purchase validation is unavailable.',
        503,
        'purchase_validation_unavailable'
      );
    }
    const result = await purchaseValidator({
      customerId,
      productId,
      productHandle,
      orderId,
      orderItemId,
      variantId,
    });
    if (!result?.verified) {
      throw errorWithCode(
        result?.reason || 'A verified purchase is required to review this product.',
        403,
        'not_verified_purchase'
      );
    }
    return {
      verified: true,
      orderId: safeString(result.orderId || orderId),
      orderItemId: safeString(result.orderItemId || orderItemId),
    };
  }

  function validateReviewBody({ rating, title, comment }) {
    const r = Number(rating);
    if (!Number.isFinite(r) || r < config.minRating || r > config.maxRating) {
      throw errorWithCode('Rating must be between 1 and 5.', 400, 'validation_error');
    }
    const cleanTitle = sanitizeText(title, config.maxTitleLength);
    const cleanComment = sanitizeText(comment, config.maxCommentLength);
    if (cleanComment.length < config.minCommentLength) {
      throw errorWithCode(
        `Review text must be at least ${config.minCommentLength} characters.`,
        400,
        'validation_error'
      );
    }
    return {
      rating: Math.round(r),
      title: cleanTitle,
      comment: cleanComment,
    };
  }

  async function detectSpam({ customerId, comment }) {
    const fingerprint = `${safeString(customerId)}:${hashComment(comment)}`;
    const count = await store.incrSpamFingerprint(fingerprint, config.spamRepeatWindowSeconds);
    if (count > config.spamMaxSameComment) {
      throw errorWithCode('Duplicate or spam-like review content detected.', 429, 'spam_detected');
    }
    const urlCount = (comment.match(/https?:\/\//gi) || []).length;
    if (urlCount >= 3) {
      throw errorWithCode('Too many links in review content.', 400, 'spam_detected');
    }
  }

  async function processMediaInputs({ mediaInputs, customerId, reviewId }) {
    const list = Array.isArray(mediaInputs) ? mediaInputs : [];
    if (list.length > config.maxMediaPerReview) {
      throw errorWithCode(
        `Maximum ${config.maxMediaPerReview} media items per review.`,
        400,
        'validation_error'
      );
    }
    const media = [];
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i] || {};
      let record;
      if (item.url && !item.data) {
        record = await mediaService.storeRemoteUrlMedia({
          url: item.url,
          mime: item.mime || item.contentType,
          sizeBytes: item.sizeBytes || item.size || 0,
          customerId,
          reviewId,
          sortOrder: i,
        });
      } else if (item.data) {
        record = await mediaService.storeBase64Media({
          data: item.data,
          mime: item.mime || item.contentType,
          customerId,
          reviewId,
          sortOrder: i,
        });
      } else {
        throw errorWithCode('Each media item needs data or url.', 400, 'validation_error');
      }
      await store.saveMedia(record);
      media.push(record);
    }
    return media;
  }

  async function createReview(customerId, body = {}, risk = {}, idempotencyKey = '') {
    if (!config.enabled) {
      throw errorWithCode('Reviews are disabled.', 503, 'reviews_disabled');
    }

    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    await checkRate(`create:${id}`, config.rateCreatePerHour, 3600);
    if (risk.ip) {
      await checkRate(`create_ip:${risk.ip}`, config.rateCreatePerHour * 3, 3600);
    }

    if (idempotencyKey) {
      const existing = await store.getIdempotency(id, idempotencyKey);
      if (existing) {
        return { ...existing, idempotentReplay: true };
      }
    }

    const productId = safeString(body.productId);
    const productHandle = safeString(body.productHandle || body.handle);
    const productKey = productKeyFromInput({ productId, productHandle });
    if (!productKey) {
      throw errorWithCode('productId or productHandle is required.', 400, 'validation_error');
    }

    const orderId = safeString(body.orderId);
    const orderItemId = safeString(body.orderItemId);
    const variantId = safeString(body.variantId);

    const fields = validateReviewBody({
      rating: body.rating,
      title: body.title || body.reviewTitle,
      comment: body.comment || body.body || body.text,
    });

    await detectSpam({ customerId: id, comment: fields.comment });

    const purchase = await resolvePurchase({
      customerId: id,
      productId,
      productHandle,
      orderId,
      orderItemId,
      variantId,
    });

    return withLock(`${id}:${productKey}`, async () => {
      const existingId = await store.findExistingReviewId({
        customerId: id,
        productKey,
        orderItemId: purchase.orderItemId || orderItemId,
      });
      if (existingId) {
        const existing = await store.getReview(existingId);
        if (existing && existing.status !== 'deleted') {
          throw errorWithCode(
            'You already reviewed this product purchase.',
            409,
            'duplicate_review'
          );
        }
      }

      const reviewId = `rev_${crypto.randomBytes(12).toString('hex')}`;
      const media = await processMediaInputs({
        mediaInputs: body.media,
        customerId: id,
        reviewId,
      });

      const now = nowFn().toISOString();
      const status = config.autoPublish ? 'approved' : 'pending';
      const displayName = sanitizeText(
        body.customerDisplayName || body.displayName || 'Customer',
        40
      );

      const review = {
        id: reviewId,
        productKey,
        productId: productId || null,
        productHandle: productHandle || null,
        customerId: id,
        customerDisplayName: displayName || 'Customer',
        orderId: purchase.orderId || orderId || null,
        orderItemId: purchase.orderItemId || orderItemId || null,
        variantId: variantId || null,
        rating: fields.rating,
        title: fields.title,
        comment: fields.comment,
        media,
        verifiedPurchase: Boolean(purchase.verified),
        status,
        helpfulCount: 0,
        notHelpfulCount: 0,
        reportCount: 0,
        reply: null,
        moderationNote: null,
        moderatedAt: null,
        editedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        risk: {
          ipHash: risk.ip
            ? crypto.createHash('sha256').update(risk.ip).digest('hex').slice(0, 16)
            : null,
          deviceIdHash: risk.deviceId
            ? crypto.createHash('sha256').update(risk.deviceId).digest('hex').slice(0, 16)
            : null,
        },
      };

      await store.saveReview(review);
      await store.indexReview(review);
      if (status === 'approved') {
        await recomputeAggregate(productKey);
      } else {
        await store.invalidateAggregate(productKey);
      }

      const response = {
        success: true,
        review: publicReview(review, { includeModeration: true }),
        message:
          status === 'pending'
            ? 'Review submitted and pending moderation.'
            : 'Review published.',
      };

      if (idempotencyKey) {
        await store.saveIdempotency(id, idempotencyKey, response);
      }

      await audit('review_create', {
        customerId: id,
        reviewId,
        productKey,
        status,
        success: true,
      });

      return response;
    });
  }

  async function updateReview(customerId, reviewId, body = {}, risk = {}) {
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    await checkRate(`update:${id}`, config.rateCreatePerHour, 3600);

    return withLock(reviewId, async () => {
      const review = await store.getReview(reviewId);
      if (!review || review.status === 'deleted') {
        throw errorWithCode('Review not found.', 404, 'not_found');
      }
      if (review.customerId !== id) {
        throw errorWithCode('You can only edit your own reviews.', 403, 'forbidden');
      }
      const ageHours = hoursBetween(review.createdAt, nowFn());
      if (ageHours > config.allowEditHours) {
        throw errorWithCode(
          `Reviews can only be edited within ${config.allowEditHours} hours.`,
          403,
          'edit_window_expired'
        );
      }

      const fields = validateReviewBody({
        rating: body.rating ?? review.rating,
        title: body.title ?? body.reviewTitle ?? review.title,
        comment: body.comment ?? body.body ?? review.comment,
      });
      await detectSpam({ customerId: id, comment: fields.comment });

      if (Array.isArray(body.media)) {
        for (const old of review.media || []) {
          await mediaService.removeMedia(old);
        }
        review.media = await processMediaInputs({
          mediaInputs: body.media,
          customerId: id,
          reviewId: review.id,
        });
      }

      review.rating = fields.rating;
      review.title = fields.title;
      review.comment = fields.comment;
      review.editedAt = nowFn().toISOString();
      // Edits re-enter moderation unless auto-publish
      if (!config.autoPublish) {
        review.status = 'pending';
      }
      await store.saveReview(review);
      await store.indexReview(review);
      await recomputeAggregate(review.productKey);

      await audit('review_update', {
        customerId: id,
        reviewId,
        productKey: review.productKey,
        success: true,
      });

      return {
        success: true,
        review: publicReview(review, { includeModeration: true }),
      };
    });
  }

  async function deleteReview(customerId, reviewId, { asAdmin = false } = {}) {
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);

    return withLock(reviewId, async () => {
      const review = await store.getReview(reviewId);
      if (!review || review.status === 'deleted') {
        throw errorWithCode('Review not found.', 404, 'not_found');
      }
      if (!asAdmin && review.customerId !== id) {
        throw errorWithCode('You can only delete your own reviews.', 403, 'forbidden');
      }
      if (!asAdmin) {
        const ageHours = hoursBetween(review.createdAt, nowFn());
        if (ageHours > config.allowDeleteHours) {
          throw errorWithCode(
            `Reviews can only be deleted within ${config.allowDeleteHours} hours.`,
            403,
            'delete_window_expired'
          );
        }
      }

      if (config.softDeleteOnly || !asAdmin) {
        review.status = 'deleted';
        review.deletedAt = nowFn().toISOString();
        await store.saveReview(review);
        await store.deindexReview(review);
        // keep uniq key to prevent re-review spam after delete? Allow re-review after delete:
        // clear uniq by saving empty — store has no clear uniq helper; re-index won't run
      } else {
        for (const m of review.media || []) {
          await mediaService.removeMedia(m);
        }
        await store.deindexReview(review);
        await store.deleteReviewRecord(reviewId);
      }

      await recomputeAggregate(review.productKey);
      await audit('review_delete', {
        customerId: id,
        reviewId,
        productKey: review.productKey,
        asAdmin,
        success: true,
      });

      return { success: true, deleted: true, reviewId };
    });
  }

  function sortReviews(list, sort) {
    const mode = safeString(sort, 'newest').toLowerCase();
    const copy = [...list];
    if (mode === 'oldest') {
      copy.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    } else if (mode === 'highest' || mode === 'rating_desc') {
      copy.sort((a, b) => b.rating - a.rating || new Date(b.createdAt) - new Date(a.createdAt));
    } else if (mode === 'lowest' || mode === 'rating_asc') {
      copy.sort((a, b) => a.rating - b.rating || new Date(b.createdAt) - new Date(a.createdAt));
    } else if (mode === 'helpful') {
      copy.sort(
        (a, b) =>
          Number(b.helpfulCount || 0) - Number(a.helpfulCount || 0) ||
          new Date(b.createdAt) - new Date(a.createdAt)
      );
    } else {
      // newest
      copy.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    return copy;
  }

  function filterReviews(list, filters = {}) {
    let out = list;
    if (filters.rating) {
      const r = Number(filters.rating);
      out = out.filter((x) => Number(x.rating) === r);
    }
    if (filters.verified === true || filters.verified === 'true' || filters.verified === '1') {
      out = out.filter((x) => x.verifiedPurchase);
    }
    if (filters.withMedia === true || filters.withMedia === 'true' || filters.withMedia === '1') {
      out = out.filter((x) => Array.isArray(x.media) && x.media.length > 0);
    }
    if (filters.q) {
      const q = safeString(filters.q).toLowerCase();
      out = out.filter(
        (x) =>
          safeString(x.comment).toLowerCase().includes(q) ||
          safeString(x.title).toLowerCase().includes(q)
      );
    }
    return out;
  }

  async function listProductReviews({
    productId,
    productHandle,
    page = 1,
    pageSize,
    sort = 'newest',
    rating,
    verified,
    withMedia,
    q,
  }) {
    const productKey = productKeyFromInput({ productId, productHandle });
    if (!productKey) {
      throw errorWithCode('productId or productHandle is required.', 400, 'validation_error');
    }

    const size = Math.min(
      config.pageSizeMax,
      Math.max(1, Number(pageSize) || config.pageSizeDefault)
    );
    const pageNum = Math.max(1, Number(page) || 1);

    const ids = await store.getReviewIdsForProduct(productKey);
    let reviews = (await loadReviewsByIds(ids)).filter(isPubliclyVisible);
    reviews = filterReviews(reviews, { rating, verified, withMedia, q });
    reviews = sortReviews(reviews, sort);

    const total = reviews.length;
    const start = (pageNum - 1) * size;
    const slice = reviews.slice(start, start + size);
    const aggregate = await getProductAggregate(productKey);

    await store.incrMetric('list_product_reviews');

    return {
      success: true,
      productKey,
      productId: productId || null,
      productHandle: productHandle || null,
      aggregate: {
        averageRating: aggregate.averageRating,
        reviewCount: aggregate.reviewCount,
        ratingHistogram: aggregate.ratingHistogram,
        mediaReviewCount: aggregate.mediaReviewCount,
        verifiedCount: aggregate.verifiedCount,
      },
      page: pageNum,
      pageSize: size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
      reviews: slice.map((r) => publicReview(r)),
    };
  }

  async function listMyReviews(customerId, { page = 1, pageSize } = {}) {
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    const size = Math.min(
      config.pageSizeMax,
      Math.max(1, Number(pageSize) || config.pageSizeDefault)
    );
    const pageNum = Math.max(1, Number(page) || 1);
    const ids = await store.getReviewIdsForCustomer(id);
    let reviews = await loadReviewsByIds(ids);
    reviews = reviews.filter((r) => r.status !== 'deleted');
    reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const total = reviews.length;
    const start = (pageNum - 1) * size;
    const slice = reviews.slice(start, start + size);
    return {
      success: true,
      page: pageNum,
      pageSize: size,
      total,
      reviews: slice.map((r) => publicReview(r, { includeModeration: true })),
    };
  }

  async function getReviewById(reviewId, { customerId = null, asAdmin = false } = {}) {
    const review = await store.getReview(reviewId);
    if (!review || review.status === 'deleted') {
      throw errorWithCode('Review not found.', 404, 'not_found');
    }
    const owner =
      customerId &&
      (normalizeShopifyCustomerId(customerId) || safeString(customerId)) === review.customerId;
    if (!isPubliclyVisible(review) && !owner && !asAdmin) {
      throw errorWithCode('Review not found.', 404, 'not_found');
    }
    return {
      success: true,
      review: publicReview(review, { includeModeration: owner || asAdmin }),
    };
  }

  async function voteHelpful(customerId, reviewId, voteValue, risk = {}) {
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    await checkRate(`vote:${id}`, config.rateVotePerHour, 3600);
    if (risk.ip) await checkRate(`vote_ip:${risk.ip}`, config.rateVotePerHour * 2, 3600);

    const value = safeString(voteValue).toLowerCase();
    if (!['helpful', 'not_helpful', 'none'].includes(value)) {
      throw errorWithCode('vote must be helpful, not_helpful, or none.', 400, 'validation_error');
    }

    return withLock(`vote:${reviewId}`, async () => {
      const review = await store.getReview(reviewId);
      if (!isPubliclyVisible(review)) {
        throw errorWithCode('Review not found.', 404, 'not_found');
      }
      if (review.customerId === id) {
        throw errorWithCode('You cannot vote on your own review.', 403, 'forbidden');
      }

      const existing = await store.getVote(reviewId, id);
      if (existing) {
        if (existing.value === 'helpful') review.helpfulCount = Math.max(0, review.helpfulCount - 1);
        if (existing.value === 'not_helpful') {
          review.notHelpfulCount = Math.max(0, review.notHelpfulCount - 1);
        }
      }

      if (value === 'none') {
        await store.deleteVote(reviewId, id);
      } else {
        if (value === 'helpful') review.helpfulCount = Number(review.helpfulCount || 0) + 1;
        if (value === 'not_helpful') review.notHelpfulCount = Number(review.notHelpfulCount || 0) + 1;
        await store.saveVote({
          reviewId,
          customerId: id,
          value,
          createdAt: existing?.createdAt || nowFn().toISOString(),
          updatedAt: nowFn().toISOString(),
        });
      }

      await store.saveReview(review);
      await audit('review_vote', { customerId: id, reviewId, value, success: true });
      return {
        success: true,
        reviewId,
        helpfulCount: review.helpfulCount,
        notHelpfulCount: review.notHelpfulCount,
        myVote: value === 'none' ? null : value,
      };
    });
  }

  async function reportReview(customerId, reviewId, body = {}, risk = {}) {
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    await checkRate(`report:${id}`, config.rateReportPerHour, 3600);

    const reason = sanitizeText(body.reason || body.category, 80);
    const details = sanitizeText(body.details || body.comment, 500);
    if (!reason) {
      throw errorWithCode('Report reason is required.', 400, 'validation_error');
    }

    return withLock(`report:${reviewId}`, async () => {
      const review = await store.getReview(reviewId);
      if (!isPubliclyVisible(review)) {
        throw errorWithCode('Review not found.', 404, 'not_found');
      }
      if (review.customerId === id) {
        throw errorWithCode('You cannot report your own review.', 403, 'forbidden');
      }

      const existing = await store.getReport(reviewId, id);
      if (existing) {
        throw errorWithCode('You already reported this review.', 409, 'duplicate_report');
      }

      const report = {
        id: `rpt_${crypto.randomBytes(10).toString('hex')}`,
        reviewId,
        customerId: id,
        reason,
        details,
        status: 'open',
        createdAt: nowFn().toISOString(),
        risk: {
          ipHash: risk.ip
            ? crypto.createHash('sha256').update(risk.ip).digest('hex').slice(0, 16)
            : null,
        },
      };
      await store.saveReport(report);
      review.reportCount = Number(review.reportCount || 0) + 1;

      if (review.reportCount >= config.reportAutoHideThreshold) {
        review.status = 'hidden';
        review.moderationNote = 'auto_hidden_report_threshold';
        review.moderatedAt = nowFn().toISOString();
        await store.indexReview(review);
        await recomputeAggregate(review.productKey);
      }

      await store.saveReview(review);
      await audit('review_report', {
        customerId: id,
        reviewId,
        reportId: report.id,
        success: true,
      });

      return { success: true, reportId: report.id, reviewStatus: review.status };
    });
  }

  async function moderateReview(adminId, reviewId, { action, note } = {}) {
    const act = safeString(action).toLowerCase();
    if (!['approve', 'reject', 'hide', 'unhide', 'delete'].includes(act)) {
      throw errorWithCode(
        'action must be approve, reject, hide, unhide, or delete.',
        400,
        'validation_error'
      );
    }

    return withLock(reviewId, async () => {
      const review = await store.getReview(reviewId);
      if (!review) {
        throw errorWithCode('Review not found.', 404, 'not_found');
      }

      if (act === 'delete') {
        return deleteReview(adminId || 'admin', reviewId, { asAdmin: true });
      }
      if (act === 'approve') review.status = 'approved';
      if (act === 'reject') review.status = 'rejected';
      if (act === 'hide') review.status = 'hidden';
      if (act === 'unhide') review.status = 'approved';
      review.moderationNote = sanitizeText(note, 500) || null;
      review.moderatedAt = nowFn().toISOString();
      review.moderatedBy = safeString(adminId, 'admin');

      await store.saveReview(review);
      await store.indexReview(review);
      await recomputeAggregate(review.productKey);
      await audit('review_moderate', {
        adminId: safeString(adminId, 'admin'),
        reviewId,
        action: act,
        success: true,
      });

      return { success: true, review: publicReview(review, { includeModeration: true }) };
    });
  }

  async function replyToReview(adminId, reviewId, body = {}, authorType = 'seller') {
    const text = sanitizeText(body.body || body.reply || body.comment, config.maxCommentLength);
    if (text.length < 2) {
      throw errorWithCode('Reply body is required.', 400, 'validation_error');
    }
    const type = ['seller', 'admin'].includes(safeString(authorType))
      ? safeString(authorType)
      : 'seller';

    return withLock(reviewId, async () => {
      const review = await store.getReview(reviewId);
      if (!review || review.status === 'deleted') {
        throw errorWithCode('Review not found.', 404, 'not_found');
      }
      const now = nowFn().toISOString();
      review.reply = {
        body: text,
        authorType: type,
        authorId: safeString(adminId, type),
        createdAt: review.reply?.createdAt || now,
        updatedAt: now,
      };
      await store.saveReview(review);
      await audit('review_reply', { adminId: safeString(adminId), reviewId, success: true });
      return { success: true, review: publicReview(review, { includeModeration: true }) };
    });
  }

  async function listModerationQueue({ page = 1, pageSize } = {}) {
    const size = Math.min(
      config.pageSizeMax,
      Math.max(1, Number(pageSize) || config.pageSizeDefault)
    );
    const pageNum = Math.max(1, Number(page) || 1);
    const ids = await store.getPendingModerationIds();
    let reviews = await loadReviewsByIds(ids);
    reviews = reviews.filter((r) => r.status === 'pending');
    reviews.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const total = reviews.length;
    const start = (pageNum - 1) * size;
    return {
      success: true,
      page: pageNum,
      pageSize: size,
      total,
      reviews: reviews.slice(start, start + size).map((r) => publicReview(r, { includeModeration: true })),
    };
  }

  // ——— Product Q&A ———

  function publicQuestion(q, { includePrivate = false } = {}) {
    if (!q) return null;
    const answers = (Array.isArray(q.answers) ? q.answers : [])
      .filter((a) => a.status === 'approved' || includePrivate)
      .map((a) => ({
        id: a.id,
        body: a.body,
        authorType: a.authorType,
        helpfulCount: Number(a.helpfulCount || 0),
        createdAt: a.createdAt,
        status: includePrivate ? a.status : undefined,
      }));

    return {
      id: q.id,
      productId: q.productId || null,
      productHandle: q.productHandle || null,
      question: q.question,
      status: q.status,
      helpfulCount: Number(q.helpfulCount || 0),
      answers,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
      customerDisplayName: q.customerDisplayName || 'Customer',
      ...(includePrivate ? { customerId: q.customerId } : {}),
    };
  }

  async function createQuestion(customerId, body = {}, risk = {}) {
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    await checkRate(`question:${id}`, config.rateQuestionPerHour, 3600);
    if (risk.ip) await checkRate(`question_ip:${risk.ip}`, config.rateQuestionPerHour * 2, 3600);

    const productId = safeString(body.productId);
    const productHandle = safeString(body.productHandle || body.handle);
    const productKey = productKeyFromInput({ productId, productHandle });
    if (!productKey) {
      throw errorWithCode('productId or productHandle is required.', 400, 'validation_error');
    }
    const questionText = sanitizeText(body.question || body.body || body.text, 1000);
    if (questionText.length < 5) {
      throw errorWithCode('Question must be at least 5 characters.', 400, 'validation_error');
    }

    const now = nowFn().toISOString();
    const question = {
      id: `qa_${crypto.randomBytes(12).toString('hex')}`,
      productKey,
      productId: productId || null,
      productHandle: productHandle || null,
      customerId: id,
      customerDisplayName: sanitizeText(body.customerDisplayName || 'Customer', 40) || 'Customer',
      question: questionText,
      status: config.autoPublish ? 'approved' : 'pending',
      answers: [],
      helpfulCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await store.saveQuestion(question);
    await audit('qa_create', {
      customerId: id,
      questionId: question.id,
      productKey,
      success: true,
    });
    return {
      success: true,
      question: publicQuestion(question, { includePrivate: true }),
      message:
        question.status === 'pending'
          ? 'Question submitted and pending moderation.'
          : 'Question published.',
    };
  }

  async function listQuestions({
    productId,
    productHandle,
    page = 1,
    pageSize,
    q,
    sort = 'newest',
  }) {
    const productKey = productKeyFromInput({ productId, productHandle });
    if (!productKey) {
      throw errorWithCode('productId or productHandle is required.', 400, 'validation_error');
    }
    const size = Math.min(
      config.pageSizeMax,
      Math.max(1, Number(pageSize) || config.pageSizeDefault)
    );
    const pageNum = Math.max(1, Number(page) || 1);
    const ids = await store.getQuestionIdsForProduct(productKey);
    let questions = [];
    for (const id of ids) {
      const row = await store.getQuestion(id);
      if (row && row.status === 'approved') questions.push(row);
    }
    if (q) {
      const needle = safeString(q).toLowerCase();
      questions = questions.filter((row) => safeString(row.question).toLowerCase().includes(needle));
    }
    if (sort === 'helpful') {
      questions.sort((a, b) => Number(b.helpfulCount || 0) - Number(a.helpfulCount || 0));
    } else {
      questions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    const total = questions.length;
    const start = (pageNum - 1) * size;
    return {
      success: true,
      productKey,
      page: pageNum,
      pageSize: size,
      total,
      questions: questions.slice(start, start + size).map((row) => publicQuestion(row)),
    };
  }

  async function answerQuestion(adminId, questionId, body = {}, authorType = 'seller') {
    const text = sanitizeText(body.body || body.answer || body.comment, 2000);
    if (text.length < 2) {
      throw errorWithCode('Answer body is required.', 400, 'validation_error');
    }
    const type = ['seller', 'admin'].includes(safeString(authorType))
      ? safeString(authorType)
      : 'seller';

    const question = await store.getQuestion(questionId);
    if (!question) {
      throw errorWithCode('Question not found.', 404, 'not_found');
    }
    const answer = {
      id: `ans_${crypto.randomBytes(10).toString('hex')}`,
      body: text,
      authorType: type,
      authorId: safeString(adminId, type),
      status: 'approved',
      helpfulCount: 0,
      createdAt: nowFn().toISOString(),
    };
    question.answers = Array.isArray(question.answers) ? question.answers : [];
    question.answers.push(answer);
    if (question.status === 'pending') question.status = 'approved';
    await store.saveQuestion(question);
    await audit('qa_answer', {
      adminId: safeString(adminId),
      questionId,
      answerId: answer.id,
      success: true,
    });
    return { success: true, question: publicQuestion(question, { includePrivate: true }) };
  }

  async function moderateQuestion(adminId, questionId, { action, note } = {}) {
    const act = safeString(action).toLowerCase();
    if (!['approve', 'reject', 'hide'].includes(act)) {
      throw errorWithCode('action must be approve, reject, or hide.', 400, 'validation_error');
    }
    const question = await store.getQuestion(questionId);
    if (!question) {
      throw errorWithCode('Question not found.', 404, 'not_found');
    }
    if (act === 'approve') question.status = 'approved';
    if (act === 'reject') question.status = 'rejected';
    if (act === 'hide') question.status = 'hidden';
    question.moderationNote = sanitizeText(note, 500) || null;
    question.moderatedBy = safeString(adminId, 'admin');
    question.moderatedAt = nowFn().toISOString();
    await store.saveQuestion(question);
    await audit('qa_moderate', {
      adminId: safeString(adminId, 'admin'),
      questionId,
      action: act,
      success: true,
    });
    return { success: true, question: publicQuestion(question, { includePrivate: true }) };
  }

  async function voteQuestionHelpful(customerId, questionId) {
    const id = normalizeShopifyCustomerId(customerId) || safeString(customerId);
    await checkRate(`qa_vote:${id}`, config.rateVotePerHour, 3600);
    const existing = await store.getQaVote('question', questionId, id);
    if (existing) {
      throw errorWithCode('Already voted.', 409, 'duplicate_vote');
    }
    const question = await store.getQuestion(questionId);
    if (!question || question.status !== 'approved') {
      throw errorWithCode('Question not found.', 404, 'not_found');
    }
    question.helpfulCount = Number(question.helpfulCount || 0) + 1;
    await store.saveQuestion(question);
    await store.saveQaVote({
      targetType: 'question',
      targetId: questionId,
      customerId: id,
      value: 'helpful',
      createdAt: nowFn().toISOString(),
    });
    return { success: true, questionId, helpfulCount: question.helpfulCount };
  }

  async function getMetrics() {
    const metricKeys = [
      'event:review_create',
      'event:review_update',
      'event:review_delete',
      'event:review_vote',
      'event:review_report',
      'event:review_moderate',
      'event:qa_create',
      'event:qa_answer',
      'list_product_reviews',
      'aggregate_recompute',
      'aggregate_cache_hit',
      'aggregate_cache_miss',
    ];
    const metrics = {};
    for (const key of metricKeys) {
      metrics[key.replace(/^event:/, '')] = await store.getMetric(key);
    }
    return {
      success: true,
      metrics,
      storeDriver: store.driver,
      mediaDriver: mediaService.driver,
    };
  }

  return {
    createReview,
    updateReview,
    deleteReview,
    listProductReviews,
    listMyReviews,
    getReviewById,
    voteHelpful,
    reportReview,
    moderateReview,
    replyToReview,
    listModerationQueue,
    getProductAggregate,
    recomputeAggregate,
    createQuestion,
    listQuestions,
    answerQuestion,
    moderateQuestion,
    voteQuestionHelpful,
    getMetrics,
    config,
    // exported for tests
    sanitizeText,
    productKeyFromInput,
  };
}

module.exports = {
  createReviewsService,
  sanitizeText,
  productKeyFromInput,
};
