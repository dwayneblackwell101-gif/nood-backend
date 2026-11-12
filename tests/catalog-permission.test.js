const assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
async function run(message, expectedRequests) {
 const routes={}, requests=[]; const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../routes/catalog.js'),'utf8'),{
  module,exports:module.exports,console,process:{env:{SHOPIFY_STORE_DOMAIN:'test.myshopify.com',SHOPIFY_STOREFRONT_ACCESS_TOKEN:'public-test'}},
  require(name){ if(name==='express')return {Router:()=>({get:(p,h)=>{routes[p]=h;}})}; if(name==='axios')return {post:async(url,payload,options)=>{requests.push({payload,options});return {data:payload.query.includes('quantityAvailable')?{errors:[{message}]}:{data:{products:{edges:[{node:{id:'1',availableForSale:true}}]}}}}};throw Error(name);}
 });
 const response={statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};
 await routes['/api/catalog/products']({query:{first:'1'}},response);
 assert.equal(requests.length,expectedRequests);
 assert.equal(requests[0].options.headers['X-Shopify-Storefront-Access-Token'],'public-test');
 if(expectedRequests===2){assert.equal(response.statusCode,200);assert.equal(requests[1].payload.query.includes('quantityAvailable'),false);assert.equal(requests[1].payload.variables.first,1);assert.equal(response.body.data.products.edges[0].node.availableForSale,true);}
 else assert.equal(response.statusCode,400);
}
(async()=>{await run('Access denied for quantityAvailable field. Required inventory scope.',2);await run('Invalid Storefront credentials',1);console.log('Catalog checks passed: token alias, inventory permission fallback and unrelated errors preserved.');})().catch(e=>{console.error(e);process.exitCode=1;});
