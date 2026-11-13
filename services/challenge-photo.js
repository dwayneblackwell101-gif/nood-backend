const crypto = require('crypto');
const MAX_PHOTO_BYTES = 600 * 1024;

function decodeChallengePhoto(base64) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 ||
      base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('Choose a smaller photo (maximum 600 KB).');
  }
  const bytes = Buffer.from(base64, 'base64');
  let extension;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) extension = 'jpg';
  else if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) extension = 'png';
  else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') extension = 'webp';
  if (!extension || !bytes.length || bytes.length > MAX_PHOTO_BYTES) throw new Error('Choose a JPEG, PNG, or WebP photo under 600 KB.');
  return { bytes, extension, contentType: extension === 'jpg' ? 'image/jpeg' : `image/${extension}` };
}

async function uploadChallengePhoto(storage, userId, base64) {
  const photo = decodeChallengePhoto(base64);
  const bucket = 'challenge-photos';
  const { error: bucketError } = await storage.createBucket(bucket, {
    public: true, fileSizeLimit: MAX_PHOTO_BYTES, allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  });
  if (bucketError && !/already exists|duplicate/i.test(bucketError.message || '')) throw bucketError;
  const owner = crypto.createHash('sha256').update(userId).digest('hex');
  const path = `${owner}/${crypto.randomUUID()}.${photo.extension}`;
  const { error } = await storage.from(bucket).upload(path, photo.bytes, { contentType: photo.contentType, upsert: false });
  if (error) throw error;
  return storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

module.exports = { decodeChallengePhoto, uploadChallengePhoto, MAX_PHOTO_BYTES };
