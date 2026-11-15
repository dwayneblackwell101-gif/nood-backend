const assert=require('node:assert/strict');
const {createHandlers,validate,deviceKey}=require('../utils/manual-notifications');
let calls=[];let rows=[{token:'ExponentPushToken[phone-a]',active:true,platform:'android'},{token:'ExponentPushToken[phone-b]',active:true},{token:'ExponentPushToken[disabled]',active:false}];let clock=1000;
const handlers=createHandlers({loadRecipients:async()=>rows,sendPush:async x=>{calls.push(x);return {sent:x.recipients.length,failed:0,skipped:0,campaignId:x.campaignId}},config:{maxPromoPerDay:6},secret:()=> 'test-only-secret',now:()=>clock});
async function call(handler,body={}){const res={statusCode:200,status(n){this.statusCode=n;return this},json(x){this.data=x;return this}};await handler({body},res);return res;}
(async()=>{
 const draft={type:'new_product',title:'New arrivals',body:'See the latest products.',audience:'device',target:deviceKey(rows[0].token),productHandle:'gallery-dept'};
 assert.throws(()=>validate({...draft,type:'order-confirmed'}));assert.throws(()=>validate({...draft,audience:'device',target:''}));assert.throws(()=>validate({...draft,productHandle:'https://evil.test'}));
 let preview=await call(handlers.preview,draft);assert.equal(preview.statusCode,200);assert.equal(preview.data.deviceCount,1);assert.equal(preview.data.route,'/product/gallery-dept');assert.equal(calls.length,0,'preview must not send');
 let sent=await call(handlers.send,{approval:preview.data.approval});assert.equal(sent.data.sent,1);assert.equal(calls[0].recipients[0].token,rows[0].token);assert.equal(calls[0].frequency.check,true);assert.equal(calls[0].campaignType,'new_product');
 let forged=preview.data.approval.slice(0,-1)+(preview.data.approval.endsWith('0')?'1':'0');assert.equal((await call(handlers.send,{approval:forged})).statusCode,400);
 let all=await call(handlers.preview,{...draft,audience:'all'});assert.equal(all.data.deviceCount,2);rows.push({token:'ExponentPushToken[new-phone]',active:true});assert.equal((await call(handlers.send,{approval:all.data.approval})).statusCode,400,'changed audience requires preview');
 clock+=300001;assert.equal((await call(handlers.send,{approval:preview.data.approval})).statusCode,400,'expired preview rejected');
 assert.equal((await call(handlers.preview,{...draft,target:'f'.repeat(24)})).statusCode,400,'empty test audience must not broadcast');
 for(const type of ['new_product','deal-live','flash-live','broadcast'])assert.ok(validate({...draft,type}).route);
 console.log('Manual notification checks passed: four presets, private targeting, preview without send, marketing limits, signed approval, audience changes and expiry.');
})().catch(e=>{console.error(e);process.exitCode=1});
