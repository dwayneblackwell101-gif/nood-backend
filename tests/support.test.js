const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
const { SUPPORT_CATEGORIES, supportRecipientRecords } = require('../routes/platform');
const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'platform.js'), 'utf8');

const tests = [
  ['stable support category IDs are accepted', () => {
    for (const id of ['order','delivery','return','payment','product','account','rewards','other']) assert.equal(SUPPORT_CATEGORIES.has(id), true);
    assert.equal(SUPPORT_CATEGORIES.has('Return or refund'), false);
  }],
  ['customer list and detail queries are scoped to authenticated user', () => {
    assert.match(source, /eq\('user_id', customer\.userId\)/);
    assert.match(source, /eq\('ticket_id',[\s\S]*?eq\('user_id', customer\.userId\)\.maybeSingle\(\)/);
  }],
  ['linked order must belong to authenticated customer', () => {
    assert.match(source, /from\('orders'\)[\s\S]*?eq\('user_id', customer\.userId\)[\s\S]*?eq\('shopify_order_id', orderId\)/);
  }],
  ['customer replies cannot target a closed or foreign case', () => {
    assert.match(source, /Support case not found/);
    assert.match(source, /supportCase\.status === 'closed'/);
  }],
  ['token-keyed push records select only the case owner', () => {
    const selected = supportRecipientRecords({ a:{userId:'owner'}, b:{user_id:'owner'}, c:{userId:'other'} }, 'owner');
    assert.equal(selected.length, 2);
  }],
  ['agent reply persists inbox before optional push delivery', () => {
    assert.ok(source.indexOf('await createInboxItem({') < source.indexOf('const tokenStore = await loadTokens()'));
    assert.match(source, /saveInbox: false/);
  }],
];

let passed=0;
for(const [name,run] of tests){try{run();passed++;console.log(`  ✓ ${name}`);}catch(error){console.error(`  ✗ ${name}`);throw error;}}
console.log(`\n${passed} support contract tests passed\n`);
