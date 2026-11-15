const crypto = require('crypto');
const TYPES = {new_product:{label:'New products',route:'/'},'deal-live':{label:'Deals',route:'/(tabs)/deals'},'flash-live':{label:'Flash sale',route:'/flash-sale'},broadcast:{label:'Store news',route:'/'}};
function validate(input) {
  if (!TYPES[input.type]) throw Error('Choose new products, deals, flash sale, or store news.');
  const title=String(input.title||'').trim(), body=String(input.body||'').trim();
  if (!title || title.length>80 || !body || body.length>240) throw Error('Add a title (up to 80 characters) and message (up to 240).');
  if (!['all','device'].includes(input.audience)) throw Error('Choose an audience.');
  const target=String(input.target||'').trim();
  if(input.audience==='device'&&!/^[a-f0-9]{24}$/.test(target)) throw Error('Choose a test phone.');
  const handle=String(input.productHandle||'').trim();
  if(handle&&!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,250}$/.test(handle)) throw Error('Use the product handle from its store link.');
  return {type:input.type,title,body,audience:input.audience,target:input.audience==='device'?target:'',productHandle:handle,route:handle?`/product/${handle}`:TYPES[input.type].route};
}
const deviceKey = token=>crypto.createHash('sha256').update(String(token)).digest('hex').slice(0,24);
function createHandlers({loadRecipients,sendPush,config,secret=()=>process.env.NOOD_ADMIN_TOKEN,now=Date.now}) {
  const sign=text=>crypto.createHmac('sha256',secret()).update(text).digest('hex');
  const active=async()=> (await loadRecipients()).filter(x=>x.active!==false&&!x.test&&/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(x.token||''));
  async function prepare(input) {
    const payload=validate(input), all=await active();
    const recipients=payload.audience==='all'?all:all.filter(x=>deviceKey(x.token)===payload.target);
    if (!recipients.length) throw Error('No active phones match this audience. Open the app and try again.');
    const audience=recipients.map(x=>deviceKey(x.token)).sort();
    return {payload,recipients,audience};
  }
  return {
    targets:async(req,res)=>{try{const devices=await active();return res.json({success:true,devices:devices.map(x=>({id:deviceKey(x.token),label:`${x.platform||'Phone'} · ${x.email||'Guest'} · ${deviceKey(x.token).slice(-6)}`,lastSeenAt:x.lastSeenAt||x.updatedAt||x.createdAt})),maxPerDay:config.maxPromoPerDay});}catch{return res.status(500).json({success:false,message:'Could not load phones.'});}},
    preview:async(req,res)=>{try{const {payload,recipients,audience}=await prepare(req.body||{});const proof={payload,audience,expires:now()+300000,campaignId:'manual_'+crypto.randomUUID()};const text=Buffer.from(JSON.stringify(proof)).toString('base64url');return res.json({success:true,...payload,deviceCount:recipients.length,maxPerDay:config.maxPromoPerDay,approval:text+'.'+sign(text)});}catch(e){return res.status(400).json({success:false,message:e.message});}},
    send:async(req,res)=>{try{const approval=String(req.body?.approval||'');const [text,sig,...extra]=approval.split('.');if(extra.length||!text||!sig||sig.length!==64||!crypto.timingSafeEqual(Buffer.from(sign(text)),Buffer.from(sig)))throw Error('Preview the message before sending.');const proof=JSON.parse(Buffer.from(text,'base64url').toString());if(proof.expires<now())throw Error('The preview expired. Preview again.');const {payload,recipients,audience}=await prepare(proof.payload);if(JSON.stringify(audience)!==JSON.stringify(proof.audience))throw Error('The audience changed. Preview again.');const result=await sendPush({recipients,title:payload.title,body:payload.body,data:{type:payload.type,route:payload.route,...(payload.productHandle?{productHandle:payload.productHandle}:{})},campaignId:proof.campaignId,dedupeKey:proof.campaignId,campaignType:payload.type,frequency:{check:true}});return res.json({success:true,sent:result.sent,failed:result.failed,skipped:result.skipped,duplicate:!!result.duplicate,quietHours:!!result.quietHours,campaignId:result.campaignId});}catch(e){return res.status(400).json({success:false,message:e.message});}}
  };
}
module.exports={TYPES,validate,deviceKey,createHandlers};
