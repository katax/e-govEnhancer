// Read-only public-site experiment in a fresh browser context. Product files and
// user browser profiles are never modified. Cached HTTP responses are supplied
// through Playwright routing to the site's unchanged application.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { chromium } = require('playwright');
const repo = path.resolve(__dirname,'../../..');
const cacheDir = path.join(repo,'tmp','egov-download-response-cache');
fs.mkdirSync(cacheDir,{recursive:true});
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const endpoints = ['SelectLawRevisionData.json','SelectLawTocData.json','SelectLawData.json','SelectLawTextData.json'];
const endpoint = url => new URL(url).pathname.split('/').at(-1);
const isLawHtml = url => { const p=new URL(url).pathname; return p.startsWith('/data/')&&p.endsWith('_law.html'); };
const keyOf = request => JSON.stringify([request.method(),request.url(),request.postData()||'']);
const index = new Map(fs.existsSync(path.join(cacheDir,'index.json'))?JSON.parse(fs.readFileSync(path.join(cacheDir,'index.json'),'utf8')):[]);
const baselineBodies = new Map();
const rows = [];
const observations = [];
let current;

function instrument() {
  window.__downloadProbe = { firstArticleMs:null, bodyLastMutationMs:0, revisionFirstMs:null };
  const seen = window.__downloadProbe;
  const articleSelector = '#provisionview article[id*="-At_"],#provisionview section[id*="-At_"]';
  const observer = new MutationObserver(mutations => {
    const root = document.getElementById('provisionview');
    if (root && mutations.some(m => m.target===root || root.contains(m.target))) seen.bodyLastMutationMs=performance.now();
    if (seen.firstArticleMs===null && document.querySelector(articleSelector)?.textContent.trim()) seen.firstArticleMs=performance.now();
    if (seen.revisionFirstMs===null && document.querySelector('.revisionid')?.textContent.includes('Law RevisionID:')) seen.revisionFirstMs=performance.now();
  });
  observer.observe(document,{subtree:true,childList:true,characterData:true});
}

async function run(browser, law, mode, iteration, context=null) {
  const ownContext=!context;
  context ||= await browser.newContext();
  const page=await context.newPage();
  await page.addInitScript(instrument);
  const errors=[];
  const consoleErrors=[];
  const requests=[];
  const pending = new Set();
  const bodies=[];
  const nativeBodyResponses=[];
  const cacheEvents=[];
  const liveRequests=[];
  if(mode==='xhr-cache'||mode==='xhr-body-miss') {
    await page.exposeBinding('__readCachedLawResponse',async(_source,request)=>{
      const bodyHtml=isLawHtml(request.url),end=endpoint(request.url);
      if(new URL(request.url).origin!=='https://laws.e-gov.go.jp')return null;
      if(mode==='xhr-body-miss'&&(bodyHtml||end==='SelectLawTextData.json'))return null;
      const key=JSON.stringify([request.method,request.url,request.body||'']);
      const cached=index.get(key);
      if(!cached||cached.status!==200)return null;
      const body=await fs.promises.readFile(path.join(cacheDir,cached.bodyFile));
      if(digest(body)!==cached.sha256)return null;
      const headers={...cached.headers,'content-type':bodyHtml?'text/html; charset=utf-8':'application/json; charset=utf-8'};
      cacheEvents.push({endpoint:end,action:'main-world-xhr-local',bytes:body.length,lawApi:endpoints.includes(end),bodyHtml});
      return {text:body.toString('utf8'),headers};
    });
    await page.addInitScript({path:path.join(__dirname,'normal-download-xhr-prototype.js')});
  }
  const cdp=await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived',event=>{
    if(endpoints.includes(endpoint(event.response.url)) || isLawHtml(event.response.url)) {
      nativeBodyResponses.push({url:event.response.url,status:event.response.status,
        fromDiskCache:!!event.response.fromDiskCache,fromServiceWorker:!!event.response.fromServiceWorker,
        protocol:event.response.protocol});
    }
  });
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('request',request=>{
    if(endpoints.includes(endpoint(request.url()))||isLawHtml(request.url()))pending.add(request);
  });
  page.on('requestfinished',request=>pending.delete(request));
  page.on('requestfailed',request=>pending.delete(request));
  page.on('response',response=>{
    const request=response.request();
    if(!request.url().startsWith('https://laws.e-gov.go.jp/'))return;
    const bodyPromise=(async()=>{
      const headers=await response.allHeaders();
      const body=await response.body();
      const key=keyOf(request);
      const filename=digest(key)+'.bin';
      const record={url:request.url(),method:request.method(),resourceType:request.resourceType(),postData:request.postData(),
        status:response.status(),headers,bytes:body.length,sha256:digest(body),bodyFile:filename};
      if(mode==='stock-cold'||mode==='stock-warm'){
        if(response.status()===200){fs.writeFileSync(path.join(cacheDir,filename),body);index.set(key,record);}
        if(endpoints.includes(endpoint(request.url()))||isLawHtml(request.url()))requests.push(record);
      }
      if(mode==='stock-cold' && endpoint(request.url())==='SelectLawRevisionData.json'){
        try {
          const json=JSON.parse(body);
          const history=json?.result?.Amendment_History;
          observations.push({law:law.id,kind:'revision-schema',resultKeys:Object.keys(json?.result||{}),
            historyType:Array.isArray(history)?'array':typeof history,
            firstKeys:history?Object.keys(Array.isArray(history)?history[0]||{}:history):[],
            sample:Array.isArray(history)?history.slice(0,1):history});
        }catch(_){}
      }
    })().catch(error=>{bodies.push({url:request.url(),error:error.message});});
    bodies.push(bodyPromise);
  });
  if(!mode.startsWith('stock-')) {
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!=='https://laws.e-gov.go.jp')return route.abort();
      const end=endpoint(request.url());
      const lawApi=endpoints.includes(end);
      const bodyHtml=isLawHtml(request.url());
      const internal=url.pathname.startsWith('/internal-api/');
      const shouldReplay=(!internal&&!bodyHtml) || mode==='all-data-cache'&&(lawApi||bodyHtml)
        || mode==='body-cache'&&(end==='SelectLawTextData.json'||bodyHtml)
        || mode==='live-revision-cache'&&(bodyHtml||lawApi&&end!=='SelectLawRevisionData.json');
      const key=keyOf(request),cached=index.get(key);
      if(shouldReplay&&cached&&cached.status===200){
        const body=await fs.promises.readFile(path.join(cacheDir,cached.bodyFile));
        if(digest(body)!==cached.sha256){cacheEvents.push({endpoint:end,action:'corrupt-fallback'});return route.continue();}
        const headers={...cached.headers};
        for(const name of ['content-encoding','content-length','transfer-encoding','set-cookie'])delete headers[name];
        // Cached/revalidated Chrome responses may omit content-type from the
        // returned header map even though Chrome retained the original MIME.
        // Replay needs the correct MIME explicitly for module scripts.
        if(!headers['content-type']) {
          const type=request.resourceType();
          headers['content-type']=type==='script'?'application/javascript; charset=utf-8'
            :type==='stylesheet'?'text/css; charset=utf-8':type==='document'?'text/html; charset=utf-8'
            :bodyHtml?'text/html; charset=utf-8':internal?'application/json; charset=utf-8':url.pathname.endsWith('.svg')?'image/svg+xml':'application/octet-stream';
        }
        cacheEvents.push({endpoint:end,action:'local',bytes:body.length,lawApi,bodyHtml});
        return route.fulfill({status:cached.status,headers,body});
      }
      if(lawApi||bodyHtml)liveRequests.push({endpoint:end,url:request.url(),resourceType:request.resourceType(),method:request.method(),postData:request.postData()});
      return route.continue();
    });
  }
  const start=performance.now();
  await page.goto(law.url,{waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForFunction(()=>typeof window.__downloadProbe?.firstArticleMs==='number',{},{timeout:20000}).catch(async error=>{
    const failure={law,mode,errors,consoleErrors,cacheEvents,liveRequests,
      text:await page.locator('body').innerText().catch(()=>''),title:await page.title(),
      scripts:await page.locator('script[src]').evaluateAll(els=>els.map(e=>e.src))};
    fs.writeFileSync(path.join(__dirname,'normal-download-failure.json'),JSON.stringify(failure,null,2));
    fs.writeFileSync(path.join(cacheDir,'index.json'),JSON.stringify([...index.entries()],null,2));
    console.error(JSON.stringify(failure));throw error;
  });
  await page.waitForFunction(()=>{
    const s=window.__downloadProbe;
    return s?.bodyLastMutationMs>0&&performance.now()-s.bodyLastMutationMs>250;
  },{},{timeout:45000});
  // Verify that the body request has completed, then observe a stable DOM once.
  if(pending.size)await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
  const view=await page.evaluate(()=>{
    const root=document.getElementById('provisionview');
    const articles=[...root.querySelectorAll('article[id*="-At_"],section[id*="-At_"]')]
      .filter(e=>/-At_[\d_]+$/.test(e.id)&&e.offsetParent!==null);
    return {timing:window.__downloadProbe,html:root.innerHTML,text:root.textContent,
      ids:articles.map(e=>e.id),revision:document.querySelector('.revisionid')?.textContent.trim(),
      navigation:performance.getEntriesByType('navigation').map(n=>({responseEnd:n.responseEnd,domContentLoaded:n.domContentLoadedEventEnd,load:n.loadEventEnd}))[0]};
  });
  await Promise.all(bodies.filter(b=>typeof b?.then==='function'));
  const htmlHash=digest(view.html),textHash=digest(view.text);
  if(mode==='stock-cold')baselineBodies.set(law.id,{htmlHash,textHash,ids:view.ids,revision:view.revision});
  const baseline=baselineBodies.get(law.id);
  let nativeTocInteraction=null;
  if(mode==='xhr-cache') {
    const tocLink=page.locator('#toc a[href^="#"]').first();
    const href=await tocLink.getAttribute('href');
    const before=await page.evaluate(()=>({hash:location.hash,scroll:[...document.querySelectorAll('*')].reduce((n,e)=>n+e.scrollTop,0)}));
    await tocLink.click({timeout:5000});
    const after=await page.evaluate(()=>({hash:location.hash,scroll:[...document.querySelectorAll('*')].reduce((n,e)=>n+e.scrollTop,0)}));
    nativeTocInteraction=after.hash===href||after.scroll!==before.scroll;
    if(!nativeTocInteraction)throw new Error('Native TOC interaction failed after cached response replay');
  }
  const row={lawId:law.id,lawName:law.name,mode,iteration,
    firstArticleMs:view.timing.firstArticleMs,bodyLastMutationMs:view.timing.bodyLastMutationMs,
    revisionFirstMs:view.timing.revisionFirstMs,wallObservationMs:performance.now()-start,
    articleCount:view.ids.length,htmlCharacters:view.html.length,textCharacters:view.text.length,
    htmlHash,textHash,revision:view.revision,
    sameHtml:baseline?.htmlHash===htmlHash,sameText:baseline?.textHash===textHash,
    sameArticleIds:baseline?.ids?JSON.stringify(baseline.ids)===JSON.stringify(view.ids):baseline?.htmlHash===htmlHash,
    sameRevision:baseline?.revision===view.revision,
    apiResponses:requests.map(r=>({endpoint:endpoint(r.url),url:r.url,method:r.method,resourceType:r.resourceType,postData:r.postData,
      status:r.status,decodedBytes:r.bytes,cacheControl:r.headers['cache-control'],etag:r.headers.etag,lastModified:r.headers['last-modified']})),
    liveLawApiRequests:liveRequests,cacheEvents,nativeBodyResponses,errors,nativeTocInteraction,navigation:view.navigation};
  rows.push(row);
  fs.writeFileSync(path.join(cacheDir,'index.json'),JSON.stringify([...index.entries()],null,2));
  fs.writeFileSync(path.join(__dirname,process.argv.includes('--xhr-only')?'normal-download-xhr-results.json':'normal-download-results.json'),JSON.stringify({dateJapan:'2026-10-16',browser:browser.version(),
    note:'Stock modes use native HTTP cache. Routed modes disable it and supply the captured application document/static assets from local files in every routed condition; data/*_law.html is treated as law-body data, NOT a shared static asset. Only law-data replay policy changes. No Enhancer installed. Local response replay is a feasibility prototype, not an installed-extension benchmark.',rows,observations},null,2)+'\n');
  console.log(JSON.stringify({law:law.name,mode,iteration,firstMs:row.firstArticleMs,bodyMs:row.bodyLastMutationMs,
    articles:row.articleCount,sameHtml:row.sameHtml,liveApi:liveRequests.map(r=>r.endpoint),
    localData:cacheEvents.filter(e=>e.lawApi||e.bodyHtml).map(e=>e.endpoint),errors}));
  await page.close();
  if(ownContext)await context.close();
}

async function main(){
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    let laws=[{id:'405AC0000000088',name:'行政手続法',url:'https://laws.e-gov.go.jp/law/405AC0000000088'},
      {id:'129AC0000000089',name:'民法',url:'https://laws.e-gov.go.jp/law/129AC0000000089'}];
    if(process.argv.includes('--inspect'))laws=laws.slice(0,1);
    if(process.argv.includes('--xhr-only')){
      const previous=JSON.parse(fs.readFileSync(path.join(__dirname,'normal-download-results.json'),'utf8'));
      for(const law of laws){const baseline=previous.rows.find(r=>r.lawId===law.id&&r.mode==='stock-cold');
        baselineBodies.set(law.id,{htmlHash:baseline.htmlHash,textHash:baseline.textHash,ids:null,revision:baseline.revision});
        for(let i=0;i<3;i++)await run(browser,law,'xhr-cache',i);
        await run(browser,law,'xhr-body-miss',0);
      }
      return;
    }
    for(const law of laws){
      const context=await browser.newContext();
      await run(browser,law,'stock-cold',0,context);
      await run(browser,law,'stock-warm',1,context);
      await context.close();
      if(process.argv.includes('--inspect')){await run(browser,law,'data-live',0);continue;}
      const modes=['data-live','body-cache','live-revision-cache','all-data-cache'];
      for(let iteration=0;iteration<3;iteration++){
        for(const mode of iteration%2===0?modes:[...modes].reverse())await run(browser,law,mode,iteration);
      }
    }
    fs.writeFileSync(path.join(cacheDir,'index.json'),JSON.stringify([...index.entries()],null,2));
  }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
