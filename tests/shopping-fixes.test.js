const assert = require('node:assert/strict');
const { decodeChallengePhoto, uploadChallengePhoto, MAX_PHOTO_BYTES } = require('../services/challenge-photo');

(async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSeYAAAAASUVORK5CYII=';
  assert.equal(decodeChallengePhoto(png).contentType, 'image/png');
  for (const invalid of ['', 'file:///phone/photo.jpg', 'YWJj', '!'.repeat(12), Buffer.alloc(MAX_PHOTO_BYTES + 1).toString('base64')]) {
    assert.throws(() => decodeChallengePhoto(invalid));
  }
  let uploaded;
  const storage = {
    createBucket: async () => ({ error: { message: 'The resource already exists' } }),
    from: () => ({
      upload: async (path, bytes, options) => { uploaded = { path, bytes, options }; return {}; },
      getPublicUrl: (path) => ({ data: { publicUrl: `https://storage.example/challenge-photos/${path}` } }),
    }),
  };
  const url = await uploadChallengePhoto(storage, 'customer-1', png);
  assert.match(url, /^https:\/\/storage.example\/challenge-photos\/[a-f0-9]{64}\/[a-f0-9-]+\.png$/);
  assert.equal(uploaded.options.contentType, 'image/png');
  assert.equal(uploaded.bytes.toString('base64'), png);
  await assert.rejects(uploadChallengePhoto({ createBucket: async () => ({ error: new Error('denied') }) }, 'customer', png), /denied/);

  // Exercise the actual cart handler with isolated dependencies; no live requests.
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  const auth = require('../services/customer-auth');
  const db = require('../utils/supabase');
  auth.authenticateCustomer = async () => ({ userId: 'owned-user', email: 'owned@example.test' });
  let saved;
  db.supabase = { from: () => ({ upsert: (record) => { saved = record; return { select: async () => ({ data: [{ id: 'cart' }] }) }; } }) };
  const { router } = require('../routes/cart');
  const handler = router.stack.find((layer) => layer.route?.path === '/api/cart/sync').route.stack[0].handle;
  const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await handler({ body: { items: [], email: 'spoofed@example.test' } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(saved.items, []);
  assert.equal(saved.email, 'owned@example.test');
  await handler({ body: { items: 'invalid' } }, res);
  assert.equal(res.code, 400);
  await handler({ body: { items: Array(101).fill({}) } }, res);
  assert.equal(res.code, 400);
  console.log('Shopping regression checks passed: photo format/size, upload URL/data/failure, empty-cart clearing, identity and input validation.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
