function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function envInt(name, fallback) {
  const raw = safeString(process.env[name]);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function envBool(name, fallback) {
  const raw = safeString(process.env[name]).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function getReviewsConfig(env = process.env) {
  return {
    enabled: envBool('REVIEWS_ENABLED', true),
    requireVerifiedPurchase: envBool('REVIEWS_REQUIRE_VERIFIED_PURCHASE', true),
    autoPublish: envBool('REVIEWS_AUTO_PUBLISH', false),
    allowEditHours: envInt('REVIEWS_ALLOW_EDIT_HOURS', 48),
    allowDeleteHours: envInt('REVIEWS_ALLOW_DELETE_HOURS', 24),
    softDeleteOnly: envBool('REVIEWS_SOFT_DELETE_ONLY', true),
    minRating: 1,
    maxRating: 5,
    minCommentLength: envInt('REVIEWS_MIN_COMMENT_LENGTH', 10),
    maxCommentLength: envInt('REVIEWS_MAX_COMMENT_LENGTH', 4000),
    maxTitleLength: envInt('REVIEWS_MAX_TITLE_LENGTH', 120),
    maxMediaPerReview: envInt('REVIEWS_MAX_MEDIA_PER_REVIEW', 8),
    maxImageBytes: envInt('REVIEWS_MAX_IMAGE_BYTES', 5 * 1024 * 1024),
    maxVideoBytes: envInt('REVIEWS_MAX_VIDEO_BYTES', 40 * 1024 * 1024),
    allowedImageMime: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
    allowedVideoMime: new Set(['video/mp4', 'video/quicktime', 'video/webm']),
    mediaStorageDir: safeString(env.REVIEWS_MEDIA_DIR, './uploads/reviews'),
    mediaPublicBaseUrl: safeString(env.REVIEWS_MEDIA_PUBLIC_BASE_URL, ''),
    pageSizeDefault: envInt('REVIEWS_PAGE_SIZE_DEFAULT', 20),
    pageSizeMax: envInt('REVIEWS_PAGE_SIZE_MAX', 50),
    rateCreatePerHour: envInt('REVIEWS_RATE_CREATE_PER_HOUR', 10),
    rateVotePerHour: envInt('REVIEWS_RATE_VOTE_PER_HOUR', 60),
    rateReportPerHour: envInt('REVIEWS_RATE_REPORT_PER_HOUR', 20),
    rateQuestionPerHour: envInt('REVIEWS_RATE_QUESTION_PER_HOUR', 15),
    spamRepeatWindowSeconds: envInt('REVIEWS_SPAM_WINDOW_SECONDS', 3600),
    spamMaxSameComment: envInt('REVIEWS_SPAM_MAX_SAME_COMMENT', 2),
    reportAutoHideThreshold: envInt('REVIEWS_REPORT_AUTO_HIDE', 5),
    aggregateCacheTtlSeconds: envInt('REVIEWS_AGGREGATE_CACHE_TTL', 60),
    historyLimit: envInt('REVIEWS_HISTORY_LIMIT', 200),
  };
}

module.exports = {
  getReviewsConfig,
};
