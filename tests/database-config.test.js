const assert=require('node:assert/strict'); const fs=require('node:fs'); const vm=require('node:vm');
for(const file of ['supabase.js','supabase-admin.js']) {
 let passed; const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../utils',file),'utf8'),{
  module,exports:module.exports,console:{log(){},warn(){},error(){}},
  process:{env:{SUPABASE_URL:' https://test.supabase.co\n\n',SUPABASE_SERVICE_ROLE_KEY:' sb_secret_test\n'}},
  require(name){if(name==='./supabase-credential')return {isSupabaseServiceRoleKey:key=>key.trim().startsWith('sb_secret_'),safeCredentialPrefix:()=>'',describeSupabaseKeyType:()=> 'modern-secret'};if(name==='@supabase/supabase-js')return {createClient:(url,key)=>{passed={url,key};return {};}};throw Error(name);}
 });
 assert.equal(passed.url,'https://test.supabase.co');assert.equal(passed.key,'sb_secret_test');
}
console.log('Database configuration checks passed: copied whitespace removed before client creation.');
