const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
async function scenario({prior=false,currency='TTD',manual=true,amount='120.00'}={}) {
 const calls=[];const module={exports:{}};
 const api={get:async path=>{
  calls.push(path);
  if(path.endsWith('/refunds.json'))return {data:{refunds:prior?[{id:99,note:'NOOD external refund provider-1'}]:[]}};
  if(path.endsWith('/transactions.json'))return {data:{transactions:[{id:3,status:'success',manual_payment_gateway:manual}]}};
  return {data:{order:{currency,line_items:[{id:2,variant_id:1,quantity:1}]}}};
 },post:async(path,body)=>{
  calls.push(path);
  if(path.endsWith('/calculate.json'))return {data:{refund:{transactions:[{parent_id:3,amount,gateway:'PayPal'}]}}};
  assert.equal(body.refund.notify,false);assert.equal(body.refund.transactions[0].kind,'refund');
  return {data:{refund:{id:9,transactions:[{status:'success'}]}}};
 }};
 vm.runInNewContext(fs.readFileSync('services/shopify-refunds.js','utf8'),{module,process:{env:{SHOPIFY_STORE_DOMAIN:'test.myshopify.com'}},Intl,require:n=>n==='axios'?{create:()=>api}:n==='./shopify-admin-auth'?{getAdminToken:async()=>'test'}:require('../services/catalog-pricing')});
 return {run:()=>module.exports.recordExternalRefund({orderId:'gid://shopify/Order/7',amount:120,currency:'TTD',items:[{variantId:'gid://shopify/ProductVariant/1',quantity:1}],reference:'provider-1'}),calls};
}
(async()=>{
 const ok=await scenario();assert.equal((await ok.run()).id,'9');
 const retry=await scenario({prior:true});assert.equal((await retry.run()).replay,true);assert.equal(retry.calls.length,1);
 for(const args of [{currency:'USD'},{manual:false},{amount:'119.00'}]){
  const test=await scenario(args);await assert.rejects(test.run);assert(!test.calls.some(p=>p.endsWith('/refunds.json')&&test.calls.filter(x=>x===p).length>1));
 }
 console.log('Shopify refund checks passed: recorded payment only, currency/amount validation, replay.');
})().catch(e=>{console.error(e);process.exitCode=1});
