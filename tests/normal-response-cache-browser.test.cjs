// Real Chrome XHR, postMessage bridge and Cache Storage, with public HTTP fixtures.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const origin = 'https://laws.e-gov.go.jp';
const law = '405AC0000000088';
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function open(t, { bridge = true, backend = true, fixtures = null, lawId = law, frequency = 'daily' } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const counts = { data: 0, metadata: 0, endpoints: [], cacheControls: [] };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!fixtures && url.pathname.startsWith('/law/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Law fixture</title><footer class="toolbar toolbar-main"><button id="native-print">印刷</button><button id="native-download">ダウンロード</button></footer>' });
    if (url.pathname.startsWith('/api/2/')) {
      counts.metadata++;
      return route.fulfill({status:503});
    }
    const updateCheck = url.pathname === '/internal-api/SelectLawRevisionData.json' && route.request().resourceType() === 'fetch';
    if (updateCheck) counts.metadata++;
    if (!updateCheck && (url.pathname.startsWith('/internal-api/') || url.pathname.endsWith('_law.html'))) {
      counts.data++;
      counts.endpoints.push(url.pathname);
      counts.cacheControls.push(route.request().headers()['cache-control']);
    }
    if (fixtures) {
      const normalize = body => {
        try { const parsed = JSON.parse(body); delete parsed.occasion; return JSON.stringify(parsed); }
        catch { return body || ''; }
      };
      const record = fixtures.records.find(record => record.url === route.request().url()
        && record.method === route.request().method() && normalize(record.postData) === normalize(route.request().postData()));
      if (!record) return route.fulfill({ status: 404, body: 'Fixture absent' });
      const headers = { ...record.headers };
      for (const name of ['content-encoding','content-length','transfer-encoding','set-cookie']) delete headers[name];
      if (!headers['content-type']) {
        const type = route.request().resourceType();
        headers['content-type'] = type === 'script' ? 'application/javascript'
          : type === 'stylesheet' ? 'text/css' : type === 'document' || url.pathname.endsWith('_law.html') ? 'text/html'
          : url.pathname.startsWith('/internal-api/') ? 'application/json' : 'application/octet-stream';
      }
      return route.fulfill({ status: record.status, headers, body: fs.readFileSync(path.join(fixtures.directory, record.bodyFile)) });
    }
    if (!url.pathname.startsWith('/internal-api/') && !url.pathname.endsWith('_law.html')) counts.data++;
    return route.fulfill({ contentType: url.pathname.endsWith('.html') ? 'application/gzip' : 'application/json',
      body: url.pathname.endsWith('.html') ? '<article>law fixture</article>' : '{"result":{"success":true,"law_data":"law fixture"}}' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const bridgeSource = `
    const listeners = [];
    window.chrome = { storage: {local:{get:async () => ({normalResponseCacheFrequency:${JSON.stringify(frequency)}})}}, runtime: {
      id: 'extension', getManifest: () => ({version:'2.6.2'}),
      onMessage: { addListener: fn => { listeners.push(fn); } },
      sendMessage: message => new Promise(resolve => listeners.some(listener => listener(message,
        {id:'extension', tab:{id:1}, frameId:0, url:location.href}, resolve) === true))
    }};
    ${read('shared/egov-shared.js')}
    ${read('shared/law-update-check.js')}
    ${backend ? read('shared/normal-response-cache-background.js') : ''}
    ${backend ? read('shared/law-update-check-background.js') : ''}
    ${bridge ? read('shared/normal-response-cache-bridge.js') : ''}
  `;
  // Chrome content scripts run apart from the page; exercise actual separate JS worlds.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bridgeSource, worldName: 'EnhancerCacheTestBridge' });
  await page.addInitScript({ content: `
    window.cacheMessages = [];
    window.addEventListener('message', event => {
      if (event.data?.channel === 'egov-normal-response-cache-v1') cacheMessages.push({
        action:event.data.action, direction:event.data.direction, url:event.data.request?.url,
        build:event.data.build,
        length:event.data.value?.text?.length, contentType:event.data.value?.contentType
      });
    });
    ${read('shared/normal-response-cache-page.js')}
    window.requestLaw = (options = {}) => new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      window.lastXhr = xhr;
      const events = [];
      for (const type of ['load','abort','error','loadend']) xhr.addEventListener(type, () => events.push(type));
      xhr.open(options.method || 'POST', options.url || '/internal-api/SelectLawRevisionData.json');
      xhr.responseType = options.responseType || '';
      if (options.timeout) xhr.timeout = options.timeout;
      if (options.header) xhr.setRequestHeader(...options.header);
      xhr.onloadend = () => resolve({status:xhr.status, value:xhr.response, events,
        contentType:xhr.getResponseHeader('content-type'), readyState:xhr.readyState});
      xhr.send(options.body === undefined ? JSON.stringify({law_id:'${law}'}) : options.body);
      if (options.abort) xhr.abort();
    });
  ` });
  await page.goto(`${origin}/law/${lawId}`);
  return { page, counts, errors };
}

async function stored(page) {
  await page.waitForFunction(async () => (await (await caches.open('egov-normal-responses-v1')).keys()).length > 0);
}

test('normal update warning waits for rendered law, ignores future versions and clears after reacquisition', async t => {
  const s = await open(t);
  let checks = 0;
  let history = [
    { LawDataId: 300, SubRevision: '1', EnforcementDate: null, ScheduledEnforcementDate: '2099-01-01', IsCurrentEnforcement: false },
    { LawDataId: 200, SubRevision: '1', EnforcementDate: '2026-01-01', IsCurrentEnforcement: true },
  ];
  await s.page.route('**/internal-api/SelectLawRevisionData.json', async route => {
    if (route.request().resourceType() !== 'fetch') return route.fallback();
    checks++;
    assert.equal(route.request().headers()['cache-control'], 'no-cache');
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { success: true, Amendment_History: history } }) });
  });
  const showRevision = revision => s.page.evaluate(({ law, revision }) => requestLaw({
    url: '/internal-api/SelectLawTextData.json', body: JSON.stringify({ law_id: law, law_data_id: revision, subRevision: '1' }),
  }), { law, revision });
  const state = expected => s.page.waitForFunction(value => document.getElementById('egov-normal-redownload-button').dataset.lawUpdateState === value, expected);
  await showRevision(100);
  await state('waiting');
  assert.equal(checks, 0);
  await s.page.evaluate(() => {
    const main = document.createElement('main'); main.id = 'provisionview'; main.textContent = '表示中の法令本文'; document.body.prepend(main);
  });
  await state('updated');
  const button = s.page.locator('#egov-normal-redownload-button');
  assert.equal(await button.innerText(), '法令ファイルの再取得');
  assert.equal(await button.getAttribute('title'), '法令に更新があります');
  await s.page.addStyleTag({ content: read('content.css') });
  assert.equal(await button.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(180, 83, 9)');
  await s.page.screenshot({ path: path.join(root, 'tmp/normal-law-update-warning.png') });
  await showRevision(100);
  assert.equal(checks, 1); // Additional chunks of the same version reuse this check.
  await showRevision(200);
  await state('current');
  assert.equal(await button.getAttribute('title'), '法令ファイルの再取得');
  assert.equal(await button.evaluate(node => node.classList.contains('has-law-update')), false);
  assert.equal(checks, 2);
  history = [];
  await showRevision(400);
  await state('unknown');
  assert.equal(await button.evaluate(node => node.classList.contains('has-law-update')), false);
  await s.page.evaluate(() => history.replaceState(null, '', '?occasion_date=2025-01-01'));
  await showRevision(100);
  await state('not-checked');
  assert.equal(checks, 3);
});

test('unrelated DOM mutations do not rescan or measure the footer; hidden footer switches hosts', async t => {
  const s = await open(t);
  const cdp = await s.page.context().newCDPSession(s.page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id, worldName: 'EnhancerCacheTestBridge',
  });
  const evaluate = expression => cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true });
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await evaluate(`(() => {
    window.footerScans = 0; window.footerMeasures = 0;
    const query = Document.prototype.querySelectorAll, rects = Element.prototype.getClientRects;
    Document.prototype.querySelectorAll = function(selector) {
      if(selector === 'footer.toolbar-main') footerScans++;
      return query.call(this, selector);
    };
    Element.prototype.getClientRects = function() {
      if(this.matches('footer.toolbar-main')) footerMeasures++;
      return rects.call(this);
    };
  })()`);
  await s.page.evaluate(async () => {
    const main = document.createElement('main'); document.body.prepend(main);
    for(let i=0;i<10;i++) {
      main.append(document.createElement('span')); main.className = 'updated-' + i;
      await new Promise(requestAnimationFrame);
    }
  });
  const counters = await evaluate('({ scans: footerScans, measures: footerMeasures })');
  assert.deepEqual(counters.result.value, { scans: 0, measures: 0 });
  await s.page.evaluate(() => {
    const other = document.createElement('footer'); other.className = 'toolbar-main'; other.id = 'replacement';
    other.textContent = 'alternate'; document.body.append(other);
    document.querySelector('footer.toolbar-main').hidden = true;
  });
  await s.page.waitForFunction(() => document.querySelector('#replacement > #egov-normal-cache-status'));
});

test('cold request stores in native Cache Storage; warm navigation skips law download', async t => {
  const s = await open(t);
  const first = await s.page.evaluate(() => requestLaw());
  await stored(s.page);
  await s.page.reload();
  const second = await s.page.evaluate(() => requestLaw());
  assert.equal(second.value, first.value);
  assert.equal(second.status, 200);
  assert.equal(second.readyState, 4);
  assert.deepEqual(second.events, ['load', 'loadend']);
  assert.equal(s.counts.data, 1, JSON.stringify({counts:s.counts,errors:s.errors}));
  assert.equal(s.counts.metadata, 0);
  assert.deepEqual(s.errors, []);
});

test('manual button bypasses cache for one reload and shows actual body download date', async t => {
  const s = await open(t, {frequency:'manual'});
  const options = {method:'GET',body:null,url:`/data/Act/${law}/641200_1/${law}_20260724_508AC0000000066_law.html`};
  await s.page.evaluate(options => requestLaw(options), options);
  await stored(s.page);
  const label = s.page.locator('#egov-normal-cache-status [role="status"]');
  await s.page.waitForFunction(() => document.querySelector('#egov-normal-cache-status').textContent.includes('法令ファイル取得日時：20'));
  const firstDate = await label.innerText();
  await s.page.reload();
  await s.page.evaluate(options => requestLaw(options), options);
  await s.page.waitForFunction(() => document.querySelector('#egov-normal-cache-status').textContent.includes('法令ファイル取得日時：20'));
  assert.equal(await label.innerText(), firstDate);
  assert.equal(s.counts.data, 1);
  await Promise.all([s.page.waitForNavigation(),s.page.getByRole('button',{name:'法令ファイルの再取得',exact:true}).click()]);
  assert.equal((await s.page.evaluate(options => requestLaw(options), options)).status,200);
  assert.equal(s.counts.data, 2);
  await stored(s.page);
  await s.page.reload();
  await s.page.evaluate(options => requestLaw(options), options);
  assert.equal(s.counts.data, 2);
  assert.equal(s.counts.metadata,0);
  assert.deepEqual(s.errors,[]);
});

test('every-visit mode always downloads and never writes cache', async t => {
  const s = await open(t,{frequency:'always'});
  await s.page.evaluate(() => requestLaw());
  await s.page.reload();
  await s.page.evaluate(() => requestLaw());
  assert.equal(s.counts.data,2);
  assert.deepEqual(s.counts.cacheControls,['no-cache','no-cache']);
  assert.equal(await s.page.evaluate(async () => (await (await caches.open('egov-normal-responses-v1')).keys()).length),0);
});

test('every-visit mode shows the latest body download when its requested sections change', async t => {
  const s=await open(t,{frequency:'always'});
  const now=Date.now();
  const request=section=>({url:'/internal-api/SelectLawTextData.json',body:JSON.stringify({law_id:law,selTextList:[section]})});
  await s.page.evaluate(at=>{Date.now=()=>at;},now-3600000);
  await s.page.evaluate(options=>requestLaw(options),request('#old'));
  await s.page.waitForFunction(()=>document.querySelector('#egov-normal-cache-status [role="status"]').textContent.includes('法令ファイル取得日時：20'));
  await s.page.evaluate(at=>{Date.now=()=>at;},now);
  await s.page.evaluate(options=>requestLaw(options),request('#new'));
  const expected=await s.page.evaluate(at=>`法令ファイル取得日時：${new Date(at).toLocaleString('ja-JP')}`,now);
  await s.page.waitForFunction(expected=>document.querySelector('#egov-normal-cache-status [role="status"]').textContent===expected,expected,{timeout:1500});
  assert.equal(s.counts.data,2);
});

test('JSON response type, XHR reuse and abort retain usable behavior', async t => {
  const s = await open(t);
  await s.page.evaluate(() => requestLaw());
  await stored(s.page);
  const json = await s.page.evaluate(() => requestLaw({responseType:'json'}));
  assert.equal(json.value.result.law_data, 'law fixture');
  assert.equal(s.counts.data, 1);
  const reuse = await s.page.evaluate(() => new Promise(resolve => {
    const xhr = lastXhr;
    xhr.open('GET', '/unrelated.json');
    xhr.onloadend = () => resolve({status:xhr.status, value:xhr.response});
    xhr.send();
  }));
  assert.equal(reuse.status, 200);
  const aborted = await s.page.evaluate(() => requestLaw({abort:true}));
  assert.deepEqual(aborted.events, ['abort','loadend']);
  assert.equal(aborted.status, 0);
  assert.deepEqual(s.errors, []);
});

test('missing bridge times out to native XHR; cancellation does not later send', async t => {
  const s = await open(t, {bridge:false});
  assert.equal((await s.page.evaluate(() => requestLaw())).status, 200);
  assert.equal(s.counts.data, 1);
  const aborted = await s.page.evaluate(() => requestLaw({abort:true}));
  assert.equal(aborted.status, 0);
  await s.page.waitForTimeout(1600);
  assert.equal(s.counts.data, 1);
});

test('explicit native timeouts, authorization headers and non-law requests bypass cache', async t => {
  const s = await open(t);
  await s.page.evaluate(() => requestLaw({timeout:10000}));
  await s.page.evaluate(() => requestLaw({header:['Authorization','test']}));
  await s.page.evaluate(() => requestLaw({url:'/internal-api/Other.json'}));
  assert.equal(s.counts.data, 3);
  assert.equal(s.counts.metadata, 0);
});

test('static law HTML skips its native GET on a warm request', async t => {
  const s = await open(t);
  const options = {method:'GET', body:null,
    header:['Content-Encoding','gzip'],
    url:`/data/Act/${law}/641200_1/${law}_20260724_508AC0000000066_law.html`};
  const first = await s.page.evaluate(options => requestLaw(options), options);
  await stored(s.page);
  const second = await s.page.evaluate(options => requestLaw(options), options);
  assert.equal(second.value, first.value);
  assert.equal(s.counts.data, 1);
});

test('options persist capacity, reject invalid input and report storage failure', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route('https://extension.test/**', route => {
    const file = path.resolve(root, '.' + new URL(route.request().url()).pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
    const contentType = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json' }[path.extname(file)] || 'application/octet-stream';
    return route.fulfill({ contentType, body: fs.readFileSync(file) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.chrome = {
      storage: { onChanged:{addListener(){}}, local: {
        get: async () => JSON.parse(localStorage.getItem('settings') || '{}'),
        set: async values => {
          if (window.failWrites) throw new Error('Storage unavailable');
          localStorage.setItem('settings', JSON.stringify({...JSON.parse(localStorage.getItem('settings') || '{}'), ...values}));
        },
      } },
      runtime: {getURL: file => location.origin + '/' + file, sendMessage:async () => ({})},
      tabs: {query:async () => [], create:async () => {}, reload(){}}, commands:{getAll:async () => []},
    };
  });
  await page.goto('https://extension.test/options.html');
  const input = page.locator('#normalResponseCacheCapacity');
  const status = page.locator('#normalResponseCacheCapacityStatus');
  assert.equal(await input.inputValue(), '256');
  const frequency = page.locator('#normalResponseCacheFrequency');
  assert.equal(await frequency.inputValue(),'daily');
  for (const value of ['always','daily','weekly','monthly','manual']) {
    await frequency.selectOption(value);
    await page.waitForFunction(value => JSON.parse(localStorage.getItem('settings') || '{}').normalResponseCacheFrequency === value, value);
  }
  await input.fill('512');
  await input.press('Tab');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('settings') || '{}').normalResponseCacheCapacityMiB === 512);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#normalResponseCacheCapacity').value === '512');
  assert.equal(await frequency.inputValue(),'manual');
  for (const value of ['0','1.5','4097','']) {
    await input.fill(value);
    await input.dispatchEvent('change');
    assert.match(await status.innerText(), /整数/);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('settings')).normalResponseCacheCapacityMiB), 512);
  }
  await page.evaluate(() => { window.failWrites = true; });
  await input.fill('128');
  await input.press('Tab');
  await page.waitForFunction(() => document.querySelector('#normalResponseCacheCapacityStatus').textContent.includes('保存できません'));
  assert.equal(await input.isEnabled(), true);
  assert.deepEqual(errors, []);
  // A screenshot is useful when checking the actual options layout locally.
  await input.scrollIntoViewIfNeeded();
  fs.mkdirSync(path.join(root, 'tmp'), {recursive:true});
  await page.screenshot({path:path.join(root, 'tmp/normal-cache-options.png')});
});

async function mountFooterGuide(page) {
  const source = read('content.js');
  const guideCode = source.slice(source.indexOf('  function updateGuideButtonState()'),
    source.indexOf('  function applyDefaultLawSidebarVisibility()'));
  const keyStart = source.indexOf("  document.addEventListener('keydown', (e) => {", source.indexOf('// キーボードイベント'));
  const keyEnd = source.indexOf("  document.addEventListener('wheel'",keyStart);
  const headerHostCode=source.slice(source.indexOf('  function ensureHeaderControlHost()'),source.indexOf('  function ensureFavoriteHeaderBadge()'));
  const stateCode=source.slice(source.indexOf('  function setHeaderToggleButtonState('),source.indexOf('  function isLawRefScrollMode()'));
  const buttonsCode=source.slice(source.indexOf('  function ensureHeaderToggleButtons()'),source.indexOf('  function getLightweightViewerUrl('));
  const manualCode=source.slice(source.indexOf('  function openManualPageFromGuide()'),source.indexOf('  // ==================',source.indexOf('  function openManualPageFromGuide()')));
  await page.evaluate(() => {
    if(!document.querySelector('h1.appid')) {const heading=document.createElement('h1');heading.className='appid';heading.textContent='法令検索';document.body.prepend(heading);}
  });
  await page.addStyleTag({content:read('content.css')});
  // Reproduce native footer positioning in the small standalone fixtures.
  if(await page.locator('#native-print').count()) await page.addStyleTag({content:'footer.toolbar-main {position:fixed;bottom:0;left:0;width:100%;box-sizing:border-box;display:flex;align-items:center;padding:6px 12px;background:white;}'});
  await page.addScriptTag({content:`(() => {
    let extensionEnabled=true, guideTooltipPinned=false, activeDialog=null, keyboardBookmarkTargetId='';
    const injectHighlightStyles=()=>{}, isInputActive=()=>false;
    window.chrome={runtime:{sendMessage:async message=>{
      if(message.type==='egov-open-manual-page') window.manualOpens=(window.manualOpens||0)+1;
      if(message.type==='egov-open-options-page') window.optionsOpens=(window.optionsOpens||0)+1;
      return {ok:true};
    }}};
    ${manualCode}
    const scrollPage=()=>{window.scrollCalls=(window.scrollCalls||0)+1;};
    const toggleDefinitionHeaderLinks=()=>{window.definitionToggles=(window.definitionToggles||0)+1;},toggleLawRefPageMode=()=>{},toggleTextHighlightFeature=()=>{};
    const updateHeaderToggleButtonStates=()=>updateGuideButtonState();
    const openLightweightViewerFromPage=()=>{window.liteOpens=(window.liteOpens||0)+1;};
    ${headerHostCode}
    ${stateCode}
    ${buttonsCode}
    ${guideCode}
    ${source.slice(keyStart,keyEnd)}
    ensureHeaderToggleButtons();ensureShortcutGuide();
    window.recheckFooterButtons=()=>{ensureLightweightViewerButton();ensureShortcutGuide();};
  })();`});
}

test('header toggles shortcuts; footer launches download, Lite and help independently', async t => {
  const s=await open(t);
  await s.page.evaluate(() => {
    const root=document.createElement('main');root.id='provisionview';document.body.prepend(root);
  });
  await mountFooterGuide(s.page);
  const footer=s.page.locator('#egov-normal-cache-status');
  await s.page.keyboard.press('Alt+d');
  assert.equal(await s.page.evaluate(()=>definitionToggles),1);
  await s.page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'d',code:'KeyD',altKey:true,repeat:true,bubbles:true,cancelable:true})));
  assert.equal(await s.page.evaluate(()=>definitionToggles),1);
  const help=footer.getByRole('button',{name:'ヘルプ',exact:true});
  const toggle=s.page.locator('#egov-ext-header-controls #egov-ext-shortcuts-toggle');
  const panel=s.page.getByRole('dialog',{name:'キーボードショートカット',exact:true});
  assert.equal(await footer.locator('#egov-ext-guide').count(),1);
  assert.equal(await s.page.locator('footer.toolbar-main > #egov-normal-cache-status').count(),1);
  assert.equal(await s.page.getByRole('button',{name:'印刷',exact:true}).isVisible(),true);
  assert.equal(await s.page.getByRole('button',{name:'ダウンロード',exact:true}).isVisible(),true);
  assert.notEqual(await footer.evaluate(node=>getComputedStyle(node).position),'fixed');
  assert.equal(await footer.locator('#egov-ext-shortcuts-toggle').count(),0);
  assert.equal(await s.page.locator('#egov-ext-header-controls #egov-ext-lightweight-viewer-button').count(),0);
  const expectedOrder=['法令ファイルの再取得','Lite','マニュアル','オプション','ヘルプ'];
  const buttons=footer.locator('#egov-normal-cache-actions > button, .egov-normal-cache-help-actions > button, #egov-ext-guide > button');
  assert.deepEqual(await buttons.allTextContents(),expectedOrder);
  await s.page.evaluate(()=>{recheckFooterButtons();recheckFooterButtons();});
  assert.deepEqual(await buttons.allTextContents(),expectedOrder);
  await footer.getByRole('button',{name:'マニュアル',exact:true}).click();
  assert.equal(await s.page.evaluate(()=>manualOpens),1);
  await footer.getByRole('button',{name:'オプション',exact:true}).click();
  assert.equal(await s.page.evaluate(()=>optionsOpens),1);
  assert.equal(await panel.isVisible(),false);
  await footer.getByRole('button',{name:'Liteモードで開く',exact:true}).click();
  assert.equal(await s.page.evaluate(()=>liteOpens),1);
  assert.equal(await toggle.innerText(),'ショートカット');
  assert.equal(await toggle.getAttribute('title'),'ショートカットを無効化（ALT+P）');
  assert.equal(await footer.locator('#egov-ext-lightweight-viewer-button').getAttribute('title'),'Liteモードで開く（ALT+L）');
  assert.equal(await footer.locator('#egov-ext-footer-options-button').getAttribute('title'),'オプション（ALT+O）');
  assert.equal(await help.getAttribute('title'),'ヘルプ（?）');
  const dateBox=await footer.locator('.egov-normal-cache-date').boundingBox();
  const actionBox=await footer.locator('#egov-normal-cache-actions').boundingBox();
  assert.ok(dateBox.x<20 && dateBox.x+dateBox.width<actionBox.x);
  const nativeBox=await s.page.locator('#native-print').boundingBox();
  assert.ok(actionBox.x+actionBox.width<=nativeBox.x);
  await help.hover();
  assert.equal(await panel.isVisible(),false);
  await help.click();
  assert.equal(await panel.isVisible(),true);
  assert.equal(await toggle.getAttribute('aria-pressed'),'true');
  await help.click();
  assert.equal(await panel.isVisible(),false);
  await toggle.click();
  assert.equal(await toggle.innerText(),'ショートカット');
  assert.equal(await toggle.getAttribute('title'),'ショートカットを有効化（ALT+P）');
  await s.page.locator('h1.appid').hover();
  await s.page.waitForFunction(() => {
    const toggle = getComputedStyle(document.getElementById('egov-ext-shortcuts-toggle'));
    const other = getComputedStyle(document.getElementById('egov-ext-wide-button'));
    return ['backgroundColor', 'borderTopColor', 'color'].every(property => toggle[property] === other[property]);
  });
  assert.equal(await panel.isVisible(),false);
  await help.click();
  assert.equal(await panel.isVisible(),true);
  await help.focus();
  await s.page.keyboard.press('Tab');
  assert.equal(await panel.getByRole('button',{name:'マニュアル',exact:true}).count(),0);
  assert.equal(await panel.getByRole('button',{name:'閉じる',exact:true}).evaluate(node => node===document.activeElement),true);
  await s.page.keyboard.press('Enter');
  assert.equal(await panel.isVisible(),false);
  assert.equal(await s.page.evaluate(() => manualOpens),1);
  await help.click();
  await s.page.keyboard.press('Escape');
  assert.equal(await panel.isVisible(),false);
  assert.equal(await help.evaluate(node => node === document.activeElement),true);
  await s.page.keyboard.press('Alt+p');
  assert.equal(await toggle.innerText(),'ショートカット');
  assert.equal(await toggle.getAttribute('aria-pressed'),'true');
  await toggle.focus();
  await s.page.keyboard.press('Space');
  assert.equal(await toggle.innerText(),'ショートカット');
  assert.equal(await toggle.getAttribute('aria-pressed'),'false');
  await s.page.keyboard.press('?');
  assert.equal(await panel.isVisible(),true);
  await panel.getByRole('button',{name:'閉じる',exact:true}).click();
  assert.equal(await panel.isVisible(),false);
  await help.click();
  await s.page.locator('#provisionview').dispatchEvent('pointerdown');
  assert.equal(await panel.isVisible(),false);
  await s.page.keyboard.press('Alt+p');
  await s.page.evaluate(() => document.activeElement?.blur());
  await s.page.keyboard.press('d');
  assert.equal(await s.page.evaluate(() => scrollCalls),1);
  assert.deepEqual(s.errors,[]);
  await help.click();
  fs.mkdirSync(path.join(root,'tmp'),{recursive:true});
  await s.page.screenshot({path:path.join(root,'tmp/normal-cache-footer-help.png')});
  await s.page.setViewportSize({width:360,height:740});
  const box=await panel.boundingBox();
  assert.ok(box.x>=0 && box.x+box.width<=360);
  await s.page.screenshot({path:path.join(root,'tmp/normal-cache-footer-help-mobile.png')});
});

test('guide waits for a late footer instead of creating another floating control', async t => {
  const context=await browser.newContext();t.after(()=>context.close());
  const page=await context.newPage();
  await page.setContent('<main id="provisionview"></main>');
  await mountFooterGuide(page);
  assert.equal(await page.locator('#egov-ext-guide').count(),0);
  await page.evaluate(() => {
    const footer=document.createElement('aside');footer.id='egov-normal-cache-status';
    const actions=document.createElement('div');actions.id='egov-normal-cache-actions';footer.append(actions);document.body.append(footer);
  });
  await page.waitForSelector('#egov-normal-cache-status #egov-ext-guide');
  assert.equal(await page.locator('#egov-ext-guide').count(),1);
});

test('native footer replacement reattaches the same controls and preserves native actions', async t => {
  const s=await open(t);
  await s.page.evaluate(()=>{
    const main=document.createElement('main');main.id='provisionview';document.body.prepend(main);
  });
  await mountFooterGuide(s.page);
  await s.page.evaluate(()=>{
    const old=document.querySelector('footer.toolbar-main');
    const replacement=document.createElement('footer');replacement.className='toolbar toolbar-main';
    replacement.innerHTML='<button id="native-print">印刷</button><button id="native-download">ダウンロード</button>';
    replacement.querySelector('#native-print').onclick=()=>{window.nativePrints=(window.nativePrints||0)+1;};
    replacement.querySelector('#native-download').onclick=()=>{window.nativeDownloads=(window.nativeDownloads||0)+1;};
    old.replaceWith(replacement);
  });
  await s.page.waitForSelector('footer.toolbar-main > #egov-normal-cache-status #egov-ext-guide');
  assert.equal(await s.page.locator('#egov-normal-cache-status').count(),1);
  await s.page.locator('#native-print').click();
  await s.page.locator('#native-download').click();
  assert.deepEqual(await s.page.evaluate(()=>[nativePrints,nativeDownloads]),[1,1]);
  await s.page.getByRole('button',{name:'マニュアル',exact:true}).click();
  assert.equal(await s.page.evaluate(()=>manualOpens),1);
  assert.deepEqual(s.errors,[]);
});

// Optional large public-site recordings are deliberately not committed or packaged.
const fixtureDirectory = path.join(root, 'tmp/egov-download-response-cache');
const fixtureIndex = path.join(fixtureDirectory, 'index.json');
for (const lawId of [law, '129AC0000000089']) {
  test(`recorded real e-Gov application preserves DOM and TOC with zero warm law downloads: ${lawId}`,
    { skip: !fs.existsSync(fixtureIndex) && 'Public-site recordings unavailable' }, async t => {
      const fixtures = { directory: fixtureDirectory, records: JSON.parse(fs.readFileSync(fixtureIndex, 'utf8')).map(pair => pair[1]) };
      const s = await open(t, { fixtures, lawId });
      const snapshot = async () => {
        await s.page.waitForSelector('#provisionview [id*="-At_"]', { timeout: 15000 });
        await s.page.waitForLoadState('networkidle');
        await s.page.waitForFunction(() => ['current', 'updated', 'unknown'].includes(document.querySelector('#egov-normal-redownload-button')?.dataset.lawUpdateState));
        return s.page.evaluate(() => {
          const body=document.querySelector('#provisionview').cloneNode(true);
          body.querySelector('#egov-normal-cache-status')?.remove();
          body.querySelectorAll('.egov-ext-footer-host').forEach(node=>node.classList.remove('egov-ext-footer-host'));
          return {
          html: body.innerHTML,
          revision: document.querySelector('.revisionid')?.textContent,
          ids: Array.from(document.querySelectorAll('#provisionview [id*="-At_"]'), node => node.id),
        };});
      };
      const first = await snapshot();
      await s.page.waitForFunction(() => document.querySelector('#egov-normal-revision-status')?.textContent === '現行版');
      assert.deepEqual(await s.page.locator('#egov-normal-revision-status').evaluate(badge => {
        const native = badge.previousElementSibling;
        const style = node => {
          const css = getComputedStyle(node);
          return [css.color, css.backgroundColor, css.border, css.fontSize, css.padding];
        };
        return { label: native.textContent, sameStyle: JSON.stringify(style(native)) === JSON.stringify(style(badge)) };
      }), { label: '未施行あり', sameStyle: true });
      await stored(s.page);
      assert.ok(s.counts.data >= 4);
      const initialRequests = s.counts.data;
      await s.page.reload();
      const second = await snapshot();
      assert.deepEqual(second, first);
      assert.equal(s.counts.data, initialRequests, JSON.stringify({counts:s.counts,errors:s.errors,messages:await s.page.evaluate(() => cacheMessages)}));
      assert.equal(s.counts.metadata, 2); // One lightweight update check per displayed page.
      const link = s.page.locator('#toc a[href^="#"]').first();
      const target = await link.getAttribute('href');
      const before = await s.page.evaluate(() => Array.from(document.querySelectorAll('*')).reduce((sum, node) => sum + node.scrollTop, 0));
      await link.click();
      const moved = await s.page.evaluate(({before, target}) => location.hash === target
        || Array.from(document.querySelectorAll('*')).reduce((sum, node) => sum + node.scrollTop, 0) !== before, {before, target});
      assert.equal(moved, true);
      assert.deepEqual(s.errors, []);
      await s.page.addStyleTag({content:read('content.css')});
      await Promise.all([s.page.waitForNavigation(),s.page.getByRole('button',{name:'法令ファイルの再取得',exact:true}).click()]);
      assert.deepEqual(await snapshot(), first);
      assert.equal(s.counts.data, initialRequests * 2);
      assert.match(await s.page.locator('#egov-normal-cache-status').innerText(), /法令ファイル取得日時：20/);
      // The bypass applies to this reload only; the next visit uses the new data.
      await s.page.reload();
      assert.deepEqual(await snapshot(), first);
      assert.equal(s.counts.data, initialRequests * 2);
      assert.deepEqual(s.errors, []);
      await mountFooterGuide(s.page);
      assert.equal(await s.page.locator('footer.toolbar-main > #egov-normal-cache-status').count(),1);
      await s.page.screenshot({path:path.join(root,`tmp/normal-cache-law-${lawId}.png`)});
    });
}

 test('normal revision badge follows history selection and survives title replacement', async t => {
  const {page}=await open(t);
  await page.route('**/internal-api/SelectLawRevisionData.json', route=>route.fulfill({contentType:'application/json',body:JSON.stringify({result:{success:true,Amendment_History:[
    {LawDataId:30,SubRevision:'1',EnforcementDate:null,ScheduledEnforcementDate:'2099-01-01'},
    {LawDataId:20,SubRevision:'1',EnforcementDate:'2020-01-01',IsCurrentEnforcement:true},
    {LawDataId:10,SubRevision:'1',EnforcementDate:'2010-01-01'}
  ]}})}));
  await page.evaluate(async()=>{
    document.body.insertAdjacentHTML('afterbegin','<div id="titlebar"><div class="titlegroup"><h1>法令</h1><div class="statustags"><span class="statustag">未施行あり</span></div></div></div><ul><li class="revisionitem" data-revisionid="20" aria-selected="true"></li></ul>');
    await requestLaw();
  });
  const badge=page.locator('#egov-normal-revision-status');
  await page.waitForFunction(()=>document.querySelector('#egov-normal-revision-status')?.textContent==='現行版');
  assert.equal(await badge.evaluate(el=>el.previousElementSibling.textContent),'未施行あり');
  assert.equal(await badge.getAttribute('class'),'statustag');
  for(const [id,text] of [['10','過去版'],['30','未施行版'],['20','現行版']]){
    await page.locator('.revisionitem').evaluate((el,id)=>el.dataset.revisionid=id,id);
    await page.waitForFunction(text=>document.querySelector('#egov-normal-revision-status')?.textContent===text,text);
  }
  await page.locator('#titlebar .titlegroup').evaluate(el=>el.innerHTML='<h1>法令</h1>');
  await page.waitForFunction(()=>document.querySelector('#egov-normal-revision-status')?.textContent==='現行版');
  assert.equal(await badge.count(),1);
  await page.locator('.revisionitem').evaluate(el=>el.dataset.revisionid='999');
  await page.waitForFunction(()=>!document.querySelector('#egov-normal-revision-status'));
 });

test('switching law/compare/cite footers preserves layout and native comparison controls', async t => {
  const {page}=await open(t);
  await page.evaluate(()=>{
    document.body.classList.add('laws');
    document.querySelector('footer').remove();
    for(const tab of ['law','compare','cite','cited']) {
      const panel=document.createElement('section');panel.id='panel-'+tab;panel.setAttribute('aria-hidden',String(tab!=='law'));
      panel.innerHTML=`<footer class="toolbar toolbar-main ${tab==='compare'?'toolbar-split':''}">${tab==='compare'?'<div class="toolbarleading"><button class="provisioncomparisonoption">前の差分</button><button class="provisioncomparisonoption">次の差分</button></div><div class="toolbarleading"><button class="toolbarbutton">印刷</button></div>':'<button class="toolbarbutton">印刷</button>'}</footer>`;
      document.body.append(panel);
    }
  });
  await page.addStyleTag({content:`
    .laws [aria-hidden=true] {display:none;}
    .laws .toolbar {position:fixed;bottom:0;left:0;width:100%;display:flex;align-items:center;padding:8px 16px;}
    .laws .toolbar-split {flex-wrap:nowrap;justify-content:space-between!important;}
    .toolbarleading {display:flex;gap:12px;}
    .provisioncomparisonoption {height:32px;padding:2px;border:0;background:transparent;}
  `});
  await page.waitForSelector('#egov-normal-cache-actions');
  await mountFooterGuide(page);
  for(const width of [1280,800]) {
    await page.setViewportSize({width,height:900});
    for(const tab of ['compare','cite','cited','law','compare']) {
      await page.evaluate(tab=>{
        history.replaceState(null,'','?occasion_date=20200101&tab='+tab);
        for(const panel of document.querySelectorAll('section[id^="panel-"]')) panel.setAttribute('aria-hidden',String(panel.id!=='panel-'+tab));
      },tab);
      await page.waitForFunction(tab=>document.querySelector('#egov-normal-cache-status')?.closest('section')?.id==='panel-'+tab,tab);
      assert.equal(await page.locator('.egov-normal-cache-date').isVisible(), tab==='law');
      assert.equal(await page.locator('#egov-normal-redownload-button').isVisible(), tab==='law');
      if (tab !== 'law') {
        const rightGap = await page.locator('#egov-normal-cache-status').evaluate(bar =>
          bar.getBoundingClientRect().right - bar.querySelector('.egov-ext-guide-btn').getBoundingClientRect().right);
        assert.ok(Math.abs(rightGap) < 2, `Buttons must stay right-aligned: ${tab}, gap=${rightGap}`);
      }
      const layout=await page.locator('#panel-'+tab+' footer').evaluate(footer=>{
        const rect=footer.getBoundingClientRect();
        const buttons=[...footer.querySelectorAll('button')].filter(el=>el.getClientRects().length);
        const bounds=buttons.map(el=>el.getBoundingClientRect());
        return {inside:bounds.every(b=>b.left>=rect.left&&b.right<=rect.right+1&&b.top>=rect.top&&b.bottom<=rect.bottom+1),
          overlaps:bounds.some((a,i)=>bounds.slice(i+1).some(b=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)),
          comparisonHeight:footer.querySelector('.provisioncomparisonoption')?.getBoundingClientRect().height};
      });
      assert.equal(layout.inside,true,JSON.stringify({width,tab,layout}));
      assert.equal(layout.overlaps,false,JSON.stringify({width,tab,layout}));
      if(tab==='compare') assert.equal(layout.comparisonHeight,32);
      assert.equal(await page.locator('#egov-ext-guide').count(),1);
      assert.equal(await page.getByRole('button',{name:'マニュアル',exact:true}).isVisible(),true);
    }
  }
});

test('expanded footer width survives tab footer replacement and restores with sidebar', async t => {
  const {page}=await open(t);
  await page.addStyleTag({content:'.laws footer.toolbar-main {position:fixed;left:0;bottom:0;width:calc(100% - 380px);display:flex;}'+read('content.css')});
  await page.evaluate(()=>{
    document.body.classList.add('laws');
    document.body.insertAdjacentHTML('afterbegin','<aside id="sidebar"></aside><main id="revision"></main>');
  });
  const source=read('content.js');
  const fn=source.slice(source.indexOf('  function setLawRevisionAreaExpanded('),source.indexOf('  function toggleLawRevisionArea('));
  await page.addScriptTag({content:`let lawRevisionAreaOriginalStyle=null,lawRevisionAreaExpanded=false;const updateHeaderToggleButtonStates=()=>{};${fn}`});
  await page.evaluate(()=>setLawRevisionAreaExpanded(true));
  for(const tab of ['compare','cite','law']){
    await page.evaluate(tab=>{
      document.querySelector('footer').remove();
      const footer=document.createElement('footer');footer.className='toolbar toolbar-main';footer.textContent=tab;document.body.append(footer);
    },tab);
    await page.waitForSelector('footer.egov-ext-footer-host');
    assert.equal(await page.locator('footer').evaluate(el=>Math.round(el.getBoundingClientRect().right)),await page.evaluate(()=>innerWidth));
  }
  await page.evaluate(()=>setLawRevisionAreaExpanded(false));
  assert.equal(await page.locator('footer').evaluate(el=>Math.round(el.getBoundingClientRect().width)),await page.evaluate(()=>innerWidth-380));
});

test('memo eligibility follows native tabs even while the URL is unchanged', async t => {
  const {page}=await open(t);
  const source=read('content.js');
  const fn=source.slice(source.indexOf('  function canRestoreTextHighlights('),source.indexOf('  function scheduleTextHighlightRestoreNotice('));
  await page.addScriptTag({content:`let textHighlightFeatureEnabled=true;${fn}`});
  await page.evaluate(()=>{
    document.body.insertAdjacentHTML('afterbegin','<input type="radio" name="segments-provisionviews" value="law" checked><input type="radio" name="segments-provisionviews" value="compare"><input type="radio" name="segments-provisionviews" value="cite"><input type="radio" name="segments-provisionviews" value="cited"><main id="provisionview"></main>');
  });
  assert.equal(await page.evaluate(()=>canRestoreTextHighlights()),true);
  for(const tab of ['compare','cite','cited']) {
    await page.locator(`input[value="${tab}"]`).check();
    assert.equal(await page.evaluate(()=>canRestoreTextHighlights()),false);
  }
  await page.locator('input[value="law"]').check();
  await page.locator('#provisionview').evaluate(el=>el.innerHTML='<div class="provisioncomparison">比較本文</div>');
  assert.equal(await page.evaluate(()=>canRestoreTextHighlights()),false);
  await page.locator('.provisioncomparison').evaluate(el=>el.hidden=true);
  assert.equal(await page.evaluate(()=>canRestoreTextHighlights()),true);
});
