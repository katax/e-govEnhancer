const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const fixturePath=path.join(root,'tmp/egov-download-response-cache');
for(const kind of ['json','html'])test(`normal ${kind} cache displays in Lite with notice, zero network and zero Lite cache`,async t=>{
 if(!fs.existsSync(path.join(fixturePath,'index.json')))return t.skip('Recorded native responses unavailable');
 const files=JSON.parse(fs.readFileSync(path.join(fixturePath,'index.json'),'utf8')).map(x=>x[1]);
 const law=kind==='json'?'405AC0000000088':'129AC0000000089';
 const body=files.find(x=>kind==='json'?x.url.endsWith('/SelectLawTextData.json'):x.url.includes('/'+law+'/')&&x.url.endsWith('_law.html'));
 const metadata=files.filter(x=>x.url.endsWith('/SelectLawData.json')).map(x=>fs.readFileSync(path.join(fixturePath,x.bodyFile),'utf8')).find(x=>JSON.parse(x).result.law_data.LawId===law);
 const text=fs.readFileSync(path.join(fixturePath,body.bodyFile),'utf8');
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const context=await browser.newContext(),requests=[];
 await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.origin!=='https://offline.test'){requests.push(url.href);return route.abort();}
   if(url.pathname==='/seed')return route.fulfill({body:'<!doctype html><body>Seed</body>',contentType:'text/html'});
   const file=url.pathname.slice(1);if(file.includes('..'))return route.abort();
   return route.fulfill({body:read(file),contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});
 });
 await context.addInitScript({content:`
   window.offlineMessages=[];const listeners=[];
   window.chrome={runtime:{id:'test',getURL:f=>'https://offline.test/'+f,onMessage:{addListener:f=>listeners.push(f)},
     sendMessage:message=>{offlineMessages.push(message.type);return new Promise(resolve=>{for(const listener of listeners)if(listener(message,{id:'test',url:location.href},resolve)===true)return;resolve({});});}},
     storage:{local:{get:async()=>({liteDefTooltipEnabled:false}),set:async()=>{}},onChanged:{addListener(){}}},tabs:{onRemoved:{addListener(){}}}};
   ${read('shared/egov-shared.js')}
   ${read('shared/normal-cache-fallback-background.js')}
 `});
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('https://offline.test/seed');
 await page.evaluate(async({law,text,metadata,kind})=>{
   const cache=await caches.open('egov-normal-responses-v1');
   const save=async(name,value,format)=>{
     const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
     await cache.put('https://laws.e-gov.go.jp/__enhancer_normal_cache__/'+name,new Response(value,{headers:{
       'x-normal-view':encodeURIComponent('/law/'+law),'x-normal-kind':format,'x-normal-revision':'1_1','x-saved':String(Date.now()-86400000*3),'x-sha256':hash}}));
   };
   await save('body',text,kind);await save('metadata',metadata,'metadata');
 },{law,text,metadata,kind});
 await page.goto(`https://offline.test/viewer.html?lawId=${law}&normalCache=${encodeURIComponent('https://laws.e-gov.go.jp/law/'+law)}`);
 await page.waitForSelector('.law-article');
 assert.equal(await page.locator('#normal-cache-fallback-notice').innerText(),'e-Gov法令検索にアクセスできなかったため、キャッシュを利用してLiteモードで表示しています');
 assert.equal(await page.locator('#normal-cache-fallback-notice').isVisible(),true);
 assert.ok((await page.locator('#law-title').innerText()).startsWith(kind==='json'?'行政手続法':'民法'));
 assert.ok(await page.locator('.law-article').count()>(kind==='json'?40:1000));
 assert.equal(await page.locator('#law-content').innerText().then(x=>x.replace(/\s+/g,'').includes(kind==='json'?'行政運営における公正の確保':'私権は、公共の福祉に適合しなければならない')),true);
 assert.equal(await page.locator('#lite-redownload-button').innerText(),'e-Govで再接続');
 assert.deepEqual(requests,[]);
 assert.deepEqual(await page.evaluate(()=>offlineMessages),['egov-read-normal-offline']);
 assert.deepEqual(await page.evaluate(()=>caches.keys()),['egov-normal-responses-v1']);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(root,`tmp/normal-cache-fallback-${kind}.png`)});
});
