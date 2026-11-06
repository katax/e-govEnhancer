const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
test('blue local badges in both lists; popup loads complete bundled law and scrolls to source',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1100,height:900}});
  await context.addInitScript(()=>{window.chrome={runtime:{getURL:f=>'https://local.test/'+f,sendMessage:async()=>({})},
    storage:{onChanged:{addListener(){}},local:{get:async()=>({liteDefTooltipEnabled:false}),set:async()=>{},remove:async()=>{}}}};});
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://local.test')return route.abort();
    if(url.pathname==='/host')return route.fulfill({body:'<!doctype html><body>Host</body>',contentType:'text/html'});
    const file=url.pathname.slice(1);if(file.includes('..'))return route.abort();
    return route.fulfill({body:read(file),contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  const page=await context.newPage();await page.goto('https://local.test/host');
  for(const f of ['shared/egov-shared.js','shared/egov-app.js'])await page.addScriptTag({content:read(f)});
  for(const prefix of ['egov-ext','egov-lite']){
    await page.addStyleTag({content:read(prefix==='egov-ext'?'content.css':'viewer.css')});
    await page.evaluate(prefix=>{
      const source={sourceLawId:'COURTRULECRIMPROC001',sourceLawTitle:'刑事訴訟規則',sourceUrl:chrome.runtime.getURL('viewer.html?localRule=criminal-procedure#paragraph-182-2')};
      EgovApp.createReferencePopup({targetKey:'309',sources:[source],currentLawTitle:'刑事訴訟法',classPrefix:prefix,
        sortSources:EgovShared.sortReferenceSources,escapeHtml:EgovShared.escapeHtml,getSourceLabel:s=>s.sourceLawTitle,
        onOpen:s=>EgovApp.showLocalReferencePopup(s),onClose(){}});
    },prefix);
    const badge=page.locator('.'+prefix+'-reference-local-badge');
    assert.equal(await badge.innerText(),'ローカル');assert.equal(await badge.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(219, 234, 254)');
    await page.locator('.'+prefix+'-reference-link').click();
    const frame=page.frameLocator('.egov-local-reference-viewer iframe');
    await frame.locator('#paragraph-182-2').waitFor();
    assert.equal(await frame.locator('.viewer-header').isVisible(),false);
    assert.equal(await frame.locator('.viewer-cache-status').isVisible(),false);
    assert.equal(await frame.locator('#source-notice').isVisible(),false);
    assert.equal(await frame.locator('#external-references-button').isVisible(),false);
    assert.ok(await frame.locator('.law-article').count()>300);
    await page.waitForFunction(()=>{
      const frame=document.querySelector('.egov-local-reference-viewer iframe');
      const node=frame?.contentDocument?.getElementById('paragraph-182-2');if(!node)return false;
      const rect=node.getBoundingClientRect();return rect.top>=0&&rect.top<frame.clientHeight;
    });
    await page.locator('.egov-local-reference-viewer button[aria-label="閉じる"]').click();
    assert.equal(await page.locator('.egov-local-reference-viewer').count(),0);
    await page.locator('.'+prefix+'-reference-popup').evaluate(el=>el.remove());
  }
  // A standalone local viewer keeps its ordinary controls.
  await page.goto('https://local.test/viewer.html?localRule=criminal-procedure');
  await page.locator('#paragraph-182-2').waitFor();
  assert.equal(await page.locator('.viewer-header').isVisible(),true);
  assert.equal(await page.locator('.viewer-cache-status').isVisible(),true);
});
