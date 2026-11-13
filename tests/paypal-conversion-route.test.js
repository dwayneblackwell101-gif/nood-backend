const assert=require('assert'); const express=require('express');
const sessions=new Map(); let createdArgs,fulfilledArgs,captureAmount='10.00';
function mock(p,exports){const id=require.resolve(p); require.cache[id]={id,filename:id,loaded:true,exports};}
mock('../server',{createShopifyOrder:async args=>{fulfilledArgs=args;return {id:'shop-1',name:'#1'}}});
mock('../services/paypal',{createOrder:async args=>{createdArgs=args;return {id:'pp-1',status:'CREATED',links:[]}},captureOrder:async()=>({purchase_units:[{payments:{captures:[{id:'capture-1',status:'COMPLETED',amount:{value:captureAmount,currency_code:'USD'}}]}}]})});
mock('../utils/payment-state',{savePayment:async s=>sessions.set(s.provider_order_id,structuredClone(s)),getPayment:async id=>structuredClone(sessions.get(id))});
mock('../services/customer-auth',{authenticateCustomer:async()=>null});
mock('../services/promotions',{quoteCart:async()=>({total:'67.80',currency:'TTD',subtotal:'67.80',lines:[{variantId:'1',quantity:1}]}),reserveCoupon:async()=>{},finalizeCoupon:async()=>{},releaseCoupon:async()=>{}});
mock('../services/paypal-currency',{quotePayPalSettlement:async()=>({amount:'10.00',currency:'USD',sourceAmount:'67.80',sourceCurrency:'TTD',ttdPerUsd:6.78})});
const app=express();app.use(express.json());app.use(require('../routes/payments').router);
const server=app.listen(0,'127.0.0.1');
(async()=>{await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
async function post(path){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cartItems:[{id:'1',quantity:1}],total:'0.01'})});return {status:r.status,body:await r.json()};}
const made=await post('/api/orders');assert.equal(createdArgs.amount,'10.00');assert.equal(createdArgs.currency,'USD');assert.equal(made.body.settlement.amount,'10.00');assert.equal(sessions.get('pp-1').amount,'67.80');
captureAmount='9.99';const bad=await post('/api/orders/pp-1/capture');assert.equal(bad.status,409);assert.equal(fulfilledArgs,undefined);assert.equal(sessions.get('pp-1').status,'created');
captureAmount='10.00';const paid=await post('/api/orders/pp-1/capture');assert.equal(paid.body.success,true);assert.equal(fulfilledArgs.currency,'TTD');assert.equal(fulfilledArgs.total,'67.80');assert.equal((await post('/api/orders/pp-1/capture')).body.replay,true);
console.log('PayPal route integration passed: trusted conversion, saved quote, mismatch rejection, original-currency fulfillment, replay.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server.close());
