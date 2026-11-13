const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('server.js', 'utf8');
const start = source.indexOf('const allowedOrigins =');
const end = source.indexOf('const apiLimiter =', start);
let options;
vm.runInNewContext(source.slice(start, end), {
  process: { env: { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://configured.example' } },
  helmet: () => null,
  cors: value => { options = value; },
  app: { use() {} },
});
for (const origin of ['https://noodcaribbean.com', 'https://www.noodcaribbean.com', 'https://configured.example']) {
  options.origin(origin, (error, allowed) => { assert.ifError(error); assert.equal(allowed, true); });
}
for (const origin of ['https://evil.example', 'https://noodcaribbean.com.evil.example', 'http://noodcaribbean.com']) {
  options.origin(origin, error => assert.ok(error));
}
console.log('Checkout origin checks passed; unrelated origins remain blocked.');
