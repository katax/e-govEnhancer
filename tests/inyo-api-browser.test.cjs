const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const lawId = '322AC0000000054', origin = 'https://laws.e-gov.go.jp';
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

for (const normal of [true,false]) test(`download notice persists through storage and overlapping setup (${normal?'normal':'Lite'})`,async t=>{
  const page=await browser.newPage();t.after(()=>page.close());
  await page.setContent('<body></body>');
  const source=read(normal?'content.js':'viewer.js');
  const start=source.indexOf(normal?'  const persistentPageIndicator':'  const persistentToast');
  const end=source.indexOf(normal?'  function getArticleAtViewport25pct':'  function setFocusedPane',start);
  await page.addScriptTag({content:'let pageIndicatorTimer,indicatorTimer;'+source.slice(start,end)});
  await page.evaluate(normal=>{
    window.finishDownload=normal?showPageIndicator('取得・保存中',null,{persistent:true}):showToast('取得・保存中',{persistent:true});
    window.finishSetup=normal?showPageIndicator('設定中',null,{persistent:true}):showToast('設定中',{persistent:true});
  },normal);
  const indicator=page.locator(normal?'#egov-page-indicator':'#lite-indicator');
  await page.waitForTimeout(1850);
  assert.equal(await indicator.isVisible(),true);
  await page.evaluate(()=>finishDownload('保存完了'));
  assert.equal(await indicator.innerText(),'設定中');
  await page.evaluate(()=>finishSetup('設定完了'));
  assert.equal(await indicator.innerText(),'設定完了');
  await page.waitForTimeout(1850);
  assert.equal(await indicator.isVisible(),false);
});

test('large reverse-reference analysis yields to input and painting, preserves results, and cancels stale work', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.setContent('<button id="input">操作</button><main id="law"></main>');
  await page.addScriptTag({ content: read('shared/egov-shared.js') });
  const result = await page.evaluate(async lawId => {
    const root = document.getElementById('law');
    root.innerHTML = Array.from({length:1200}, (_,i) => `<article id="Mp-At_${i+1}" data-article-num="${i+1}"><div class="article-title">第${i+1}条</div>${[1,2,3].map(p=>`<div id="Mp-At_${i+1}-Pr_${p}" data-article-num="${i+1}" data-paragraph-num="${p}"><span class="law-num">${p}</span>本文 <a href="https://laws.e-gov.go.jp/law/${lawId}#Mp-At_${Math.max(1,i)}">前条</a></div>`).join('')}</article>`).join('');
    await new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const options={lawId,baseUrl:`https://laws.e-gov.go.jp/law/${lawId}`};
    let clicks=0,frames=0,active=false;
    document.getElementById('input').onclick=()=>{if(active)clicks++;};
    const timer=setInterval(()=>document.getElementById('input').click(),5);
    let frame;const animate=()=>{if(active)frames++;frame=requestAnimationFrame(animate);};animate();
    const start=performance.now();active=true;
    const sync=EgovShared.collectInternalLawReferences(root,options);
    const syncMs=performance.now()-start, syncClicks=clicks;
    active=false;await new Promise(resolve=>setTimeout(resolve,20));
    clicks=0;frames=0;active=true;
    const asyncStart=performance.now();
    const asyncResult=await EgovShared.collectInternalLawReferencesAsync(root,options);
    const asyncMs=performance.now()-asyncStart;active=false;
    clearInterval(timer);cancelAnimationFrame(frame);
    let current=true;setTimeout(()=>{current=false;},0);
    const cancelled=await EgovShared.collectInternalLawReferencesAsync(root,options,()=>current);
    const merged=await EgovShared.mergeLawReferencesAsync([asyncResult,asyncResult]);
    return {syncMs,asyncMs,syncClicks,clicks,frames,equal:JSON.stringify(sync)===JSON.stringify(asyncResult),
      mergeEqual:JSON.stringify(merged)===JSON.stringify(EgovShared.mergeLawReferences(sync,sync)),cancelled:cancelled===null,
      sources:Object.values(asyncResult).reduce((n,x)=>n+x.externalLawSources.length,0)};
  },lawId);
  console.log('Responsiveness:',JSON.stringify(result));
  assert.equal(result.equal,true);assert.equal(result.mergeEqual,true);assert.equal(result.cancelled,true);
  assert.equal(result.syncClicks,0);assert.ok(result.clicks>0);assert.ok(result.frames>0);assert.ok(result.sources>1000);
});

test('DOM application uses a time budget, starts in a later task and checks cancellation between chunks', async t => {
  const page=await browser.newPage();t.after(()=>page.close());
  await page.addScriptTag({content:read('shared/egov-shared.js')});
  const result=await page.evaluate(async()=>{
    let applied=0,tasks=0,active=true;
    const refs=Object.fromEntries(Array.from({length:200},(_,i)=>[String(i+1),{externalLawSources:[{}]}]));
    const promise=EgovShared.applyReferenceLinksInBatches(refs,{
      isEnabled:()=>active,findTarget:()=>({}),makeClickable:()=>{applied++;const start=performance.now();while(performance.now()-start<1){}},
      schedule:fn=>setTimeout(()=>{tasks++;fn();if(tasks===1)active=false;},0)
    });
    const immediate=applied;const complete=await promise;
    return {immediate,complete,applied,tasks};
  });
  assert.equal(result.immediate,0);assert.equal(result.complete,false);assert.ok(result.applied<20);assert.ok(result.tasks>=2);
});

test('rendered native page prefetches while OFF, reuses cache, and invalidates on body refresh', async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  let calls = 0;
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.includes('/internal-api/SelectInyoLawData.json')) {
      calls++;
      return route.fulfill({ contentType: 'application/json', body: read(`docs/research/2026-10-25-inyo-api/${lawId}-inyo.json`) });
    }
    if (url === `${origin}/law/${lawId}`) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="provisionview">第二条　法令本文</div><footer class="toolbar-main"></footer>' });
    return route.abort();
  });
  await context.addInitScript({ content: `
    window.chrome = { storage: { local: { get: async () => ({normalResponseCacheFrequency:'daily'}) } }, runtime: {
      sendMessage: async message => {
        if(message.type === 'egov-invalidate-law-references') {await EgovInyoApi.invalidate(message.context);return {ok:true};}
        if(message.type === 'egov-prepare-law-references') {await EgovInyoApi.prepare(message.context);if(window.pausePreparation)await new Promise(resolve=>window.releasePreparation=resolve);window.preparedAt=message.context.downloadedAt;return {ok:true};}
        if(message.type === 'egov-get-imported-law-references') {
          try { return {ok:true,lawReferences:await EgovInyoApi.get(message.context)}; }
          catch(error){return {ok:false,error:error.message};}
        }
        return null;
      }
    }};
    ${read('shared/egov-shared.js')}
    ${read('shared/law-update-check.js')}
    ${read('shared/inyo-api-background.js')}
    ${read('shared/normal-response-cache-bridge.js')}
  ` });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const at = Date.now() - 10000;
  const metadata = async (downloadedAt, fromCache = false) => {
    await page.evaluate(({lawId, downloadedAt, fromCache}) => {
      const request = {method:'POST',url:location.origin+'/internal-api/SelectLawTocData.json',body:JSON.stringify({law_data_id:610982,subRevision:'4'})};
      window.postMessage({channel:'egov-normal-response-cache-v1',direction:'request',id:'toc',action:'put',request,
        value:{text:JSON.stringify({result:{success:true,Toc_Data:{TocBody:[{'-ObjectId':'#Mp-Ch_1-At_2'}]}}})}},location.origin);
      window.postMessage({channel:'egov-normal-response-cache-v1',direction:'notice',downloadedAt,fromCache,
        request:{method:'GET',url:location.origin+'/data/law/'+lawId+'/610982_4/'+lawId+'_20260521_law.html',body:''}},location.origin);
    }, {lawId,downloadedAt,fromCache});
    await page.waitForFunction(({lawId,downloadedAt}) => EgovNormalLawContext.get(lawId)?.downloadedAt===downloadedAt, {lawId,downloadedAt});
  };
  await page.goto(`${origin}/law/${lawId}`);
  await page.evaluate(()=>{window.pausePreparation=true;});
  await metadata(at);
  await page.waitForFunction(()=>typeof window.releasePreparation==='function');
  assert.equal(await page.evaluate(()=>EgovNormalLawContext.isPreparing()),true);
  await page.evaluate(()=>{window.pausePreparation=false;releasePreparation();});
  await page.waitForFunction(at=>window.preparedAt===at,at);
  await page.waitForFunction(()=>!EgovNormalLawContext.isPreparing());
  assert.equal(calls, 1);
  assert.equal(await page.locator('.egov-ext-reference-clickable').count(),0);
  const result = await page.evaluate(lawId => EgovShared.getLawReferencesData(lawId), lawId);
  assert.ok(result['2']); assert.equal(calls, 1);
  await page.reload(); await metadata(at,true);
  await page.waitForFunction(at=>window.preparedAt===at,at);
  await page.evaluate(lawId => EgovShared.getLawReferencesData(lawId), lawId);
  assert.equal(calls, 1);
  await metadata(at + 1000);
  await page.waitForFunction(at=>window.preparedAt===at,at+1000);
  await page.evaluate(lawId => EgovShared.getLawReferencesData(lawId), lawId);
  assert.equal(calls, 2);
  assert.deepEqual(errors, []);
});

for (const auto of [false, true]) test(`real Lite viewer defers reverse references until body rendering (auto=${auto})`, async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  let calls = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname.startsWith('/internal-api/')) {
      calls++;
      const suffix = url.pathname.includes('Revision') ? 'history' : url.pathname.includes('Toc') ? 'toc' : 'inyo';
      return route.fulfill({ contentType: 'application/json', body: read(`docs/research/2026-10-25-inyo-api/${lawId}-${suffix}.json`) });
    }
    if (url.origin !== 'https://lite.test') return route.abort();
    const file = url.pathname.slice(1);
    if (!file || file.includes('..')) return route.abort();
    return route.fulfill({ body: read(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await context.addInitScript({ content: `
    const stored = {externalReferencesAutoEnable:${auto},reverseReferenceScope:'external',liteDefTooltipEnabled:false,normalResponseCacheFrequency:'daily'};
    window.chrome = {storage:{onChanged:{addListener(){}},local:{get:async()=>stored,set:async()=>{},remove:async()=>{}}},runtime:{
      getURL:file=>'https://lite.test/'+file,
      sendMessage:async message=>{
        if(message.type==='egov-invalidate-law-references') {await EgovInyoApi.invalidate(message.context);return {ok:true};}
        if(message.type==='egov-prepare-law-references') {await EgovInyoApi.prepare(message.context);if(!${auto})await new Promise(resolve=>window.releasePreparation=resolve);window.prefetchComplete=true;return {ok:true};}
        if(message.type==='egov-load-lite-law') return new Promise(resolve=>{window.resolveLaw=resolve;});
        if(message.type==='egov-get-imported-law-references') {
          window.referenceRequestRendered=!!document.querySelector('.law-article');
          try{return {ok:true,lawReferences:await EgovInyoApi.get(message.context)};}
          catch(error){return {ok:false,error:error.message};}
        }
        return {};
      }
    }};
    window.idleQueue=[];
    window.requestIdleCallback=fn=>{idleQueue.push(fn);return idleQueue.length;};
    window.flushIdle=()=>{const tasks=idleQueue.splice(0);tasks.forEach(fn=>fn({timeRemaining:()=>50,didTimeout:true}));};
    ${read('shared/egov-shared.js')}
    ${read('shared/inyo-api-background.js')}
  ` });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`https://lite.test/viewer.html?lawId=${lawId}`);
  await page.waitForFunction(() => typeof resolveLaw === 'function');
  await page.evaluate(() => flushIdle());
  assert.equal(calls, 0);
  await page.evaluate(lawId => resolveLaw({ok:true,downloadedAt:Date.now(),currentRevisionId:lawId+'_20260521_505AC0000000063',revisions:[],
    xmlText:'<Law><LawNum>試験法律</LawNum><LawBody><LawTitle>試験法</LawTitle><MainProvision><Article Num="2"><ArticleTitle>第二条</ArticleTitle><Paragraph Num="1"><ParagraphNum>１</ParagraphNum><ParagraphSentence><Sentence>試験本文。</Sentence></ParagraphSentence></Paragraph></Article></MainProvision></LawBody></Law>'}), lawId);
  await page.waitForSelector('.law-article');
  assert.equal(calls, 0);
  if (!auto) {
    await page.waitForFunction(()=>{flushIdle();return typeof window.releasePreparation==='function';});
    assert.equal(await page.locator('#external-references-button').isDisabled(),true);
    await page.evaluate(()=>releasePreparation());
    await page.waitForFunction(()=>{flushIdle();return window.prefetchComplete;});
    await page.waitForFunction(()=>!document.getElementById('external-references-button').disabled);
    assert.equal(calls,3);
    assert.equal(await page.locator('.egov-lite-reference-clickable').count(),0);
    await page.locator('#external-references-button').click();
  }
  await page.waitForFunction(() => { flushIdle(); return window.referenceRequestRendered === true; });
  await page.waitForFunction(() => { flushIdle(); return !!document.querySelector('.egov-lite-reference-clickable'); });
  assert.equal(calls, 3);
  assert.deepEqual(errors, []);
});
