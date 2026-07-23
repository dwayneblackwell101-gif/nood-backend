/**
 * Review media storage abstraction.
 * Drivers:
 *  - memory: holds buffers in process (tests)
 *  - local: filesystem under REVIEWS_MEDIA_DIR
 *  - url: stores remote CDN/object URLs only (no binary)
 *
 * CDN-compatible: public URL = mediaPublicBaseUrl + relative path
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getReviewsConfig } = require('./config');

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function errorWithCode(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function detectMimeFromBase64Meta(dataUrlOrB64) {
  const raw = safeString(dataUrlOrB64);
  const match = raw.match(/^data:([^;]+);base64,/i);
  if (match) return match[1].toLowerCase();
  return '';
}

function stripDataUrl(dataUrlOrB64) {
  const raw = safeString(dataUrlOrB64);
  const idx = raw.indexOf('base64,');
  if (idx >= 0) return raw.slice(idx + 7);
  return raw;
}

function extensionForMime(mime) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
  };
  return map[mime] || 'bin';
}

function createMemoryMediaDriver() {
  const files = new Map();
  return {
    driver: 'memory',
    async put({ key, buffer, mime }) {
      files.set(key, { buffer, mime, size: buffer.length });
      return { key, size: buffer.length, mime };
    },
    async get(key) {
      return files.get(key) || null;
    },
    async remove(key) {
      files.delete(key);
      return true;
    },
    publicUrl(key, config) {
      const base = safeString(config.mediaPublicBaseUrl).replace(/\/+$/, '');
      if (base) return `${base}/${key}`;
      return `memory://${key}`;
    },
  };
}

function createLocalMediaDriver(config) {
  const root = path.resolve(config.mediaStorageDir || './uploads/reviews');

  function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return {
    driver: 'local',
    async put({ key, buffer, mime }) {
      const full = path.join(root, key);
      ensureDir(path.dirname(full));
      await fs.promises.writeFile(full, buffer);
      return { key, size: buffer.length, mime, path: full };
    },
    async get(key) {
      const full = path.join(root, key);
      try {
        const buffer = await fs.promises.readFile(full);
        return { buffer, size: buffer.length };
      } catch {
        return null;
      }
    },
    async remove(key) {
      const full = path.join(root, key);
      try {
        await fs.promises.unlink(full);
      } catch {
        // ignore missing
      }
      return true;
    },
    publicUrl(key, cfg) {
      const base = safeString(cfg.mediaPublicBaseUrl).replace(/\/+$/, '');
      if (base) return `${base}/${key.replace(/\\/g, '/')}`;
      return `/media/reviews/${key.replace(/\\/g, '/')}`;
    },
  };
}

/**
 * URL-only driver: client/CDN already hosts the file.
 * Validates absolute https URL only.
 */
function createUrlMediaDriver() {
  return {
    driver: 'url',
    async put({ url, mime, sizeBytes }) {
      const normalized = safeString(url);
      if (!/^https:\/\//i.test(normalized)) {
        throw errorWithCode('Media URL must be https.', 400, 'invalid_media_url');
      }
      return { key: normalized, url: normalized, mime, size: sizeBytes || 0 };
    },
    async get() {
      return null;
    },
    async remove() {
      return true;
    },
    publicUrl(key) {
      return key;
    },
  };
}

function createMediaService({
  config = getReviewsConfig(),
  driverName = null,
  driver = null,
} = {}) {
  const resolvedDriverName =
    driverName ||
    safeString(process.env.REVIEWS_MEDIA_DRIVER, config.mediaPublicBaseUrl ? 'local' : 'local');

  const mediaDriver =
    driver ||
    (resolvedDriverName === 'memory'
      ? createMemoryMediaDriver()
      : resolvedDriverName === 'url'
        ? createUrlMediaDriver()
        : createLocalMediaDriver(config));

  function classifyMime(mime) {
    const m = safeString(mime).toLowerCase();
    if (config.allowedImageMime.has(m)) return 'image';
    if (config.allowedVideoMime.has(m)) return 'video';
    return null;
  }

  /**
   * Lightweight “compression” placeholder: strip EXIF-bearing full data by
   * re-encoding only the raw bytes we store; real image re-encode can be
   * plugged in later without API changes.
   */
  function compressBuffer(buffer, kind) {
    // No external image libs in deps — store as-is with size enforcement.
    // Hook point for sharp/ffmpeg later.
    return {
      buffer,
      compressed: false,
      kind,
      originalBytes: buffer.length,
      storedBytes: buffer.length,
    };
  }

  async function storeBase64Media({
    data,
    mime: mimeHint,
    customerId,
    reviewId = null,
    sortOrder = 0,
  }) {
    const mime = safeString(mimeHint || detectMimeFromBase64Meta(data)).toLowerCase();
    const kind = classifyMime(mime);
    if (!kind) {
      throw errorWithCode('Unsupported media type.', 400, 'invalid_media_type');
    }

    let buffer;
    try {
      buffer = Buffer.from(stripDataUrl(data), 'base64');
    } catch {
      throw errorWithCode('Invalid media payload.', 400, 'invalid_media_payload');
    }

    if (!buffer.length) {
      throw errorWithCode('Empty media payload.', 400, 'invalid_media_payload');
    }

    const maxBytes = kind === 'image' ? config.maxImageBytes : config.maxVideoBytes;
    if (buffer.length > maxBytes) {
      throw errorWithCode(
        `Media exceeds maximum size of ${maxBytes} bytes.`,
        400,
        'media_too_large'
      );
    }

    const compressed = compressBuffer(buffer, kind);
    const id = `media_${crypto.randomBytes(12).toString('hex')}`;
    const ext = extensionForMime(mime);
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}/${safeString(customerId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(-24)}/${id}.${ext}`;

    const stored = await mediaDriver.put({
      key,
      buffer: compressed.buffer,
      mime,
    });

    const url = mediaDriver.publicUrl(stored.key || key, config);

    return {
      id,
      type: kind,
      mime,
      sizeBytes: compressed.storedBytes,
      originalBytes: compressed.originalBytes,
      compressed: compressed.compressed,
      url,
      storageKey: stored.key || key,
      storageDriver: mediaDriver.driver,
      reviewId: reviewId || null,
      sortOrder: Number(sortOrder) || 0,
      createdAt: new Date().toISOString(),
    };
  }

  async function storeRemoteUrlMedia({
    url,
    mime,
    sizeBytes = 0,
    customerId: _customerId,
    reviewId = null,
    sortOrder = 0,
  }) {
    const kind = classifyMime(mime);
    if (!kind) {
      throw errorWithCode('Unsupported media type.', 400, 'invalid_media_type');
    }
    const maxBytes = kind === 'image' ? config.maxImageBytes : config.maxVideoBytes;
    if (sizeBytes && sizeBytes > maxBytes) {
      throw errorWithCode(
        `Media exceeds maximum size of ${maxBytes} bytes.`,
        400,
        'media_too_large'
      );
    }

    const urlDriver = createUrlMediaDriver();
    const stored = await urlDriver.put({ url, mime, sizeBytes });
    const id = `media_${crypto.randomBytes(12).toString('hex')}`;

    return {
      id,
      type: kind,
      mime: safeString(mime).toLowerCase(),
      sizeBytes: Number(sizeBytes) || 0,
      originalBytes: Number(sizeBytes) || 0,
      compressed: false,
      url: stored.url,
      storageKey: stored.key,
      storageDriver: 'url',
      reviewId: reviewId || null,
      sortOrder: Number(sortOrder) || 0,
      createdAt: new Date().toISOString(),
    };
  }

  async function removeMedia(mediaRecord) {
    if (!mediaRecord?.storageKey) return true;
    if (mediaRecord.storageDriver === 'url') return true;
    try {
      await mediaDriver.remove(mediaRecord.storageKey);
    } catch {
      // best effort
    }
    return true;
  }

  return {
    driver: mediaDriver.driver,
    storeBase64Media,
    storeRemoteUrlMedia,
    removeMedia,
    classifyMime,
  };
}

module.exports = {
  createMediaService,
  createMemoryMediaDriver,
  createLocalMediaDriver,
  createUrlMediaDriver,
  detectMimeFromBase64Meta,
};
