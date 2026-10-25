// Isolated experiment: production files are read, never rewritten.
// Browser DOM and production algorithms are real; storage transport is an
// in-memory JSON round trip. Native chrome.storage latency is NOT measured.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../..');
const lawId = '405AC0000000088';
const fixtureSource = 'Synthetic old/new normal-mode DOM, informed by observed e-Gov article/paragraph/column structure. Not a full downloaded statute.';

function fixture(count = 24, modern = false, denseDefinitions = false) {
  const article = (n, text, extra = '', scope = '') => {
    const id = `${scope || 'Mp-Ch_1'}-At_${n}`;
    const sentence = `<p class="sentence">${text}</p>`;
    const first = modern
      ? `<div class="_div_ArticleTitle" id="${id}-Pr_1"><span>第${n}条　</span>${sentence}${extra}</div>`
      : `<div class="paragraph" id="${id}-Pr_1"><div class="istitle"><span class="paragraphtitle">第${n}条　</span>${sentence}</div>${extra}</div>`;
    const second = `<div class="${modern ? '_div_ParagraphSentence' : 'paragraph space'}" id="${id}-Pr_2"><span class="paragraphtitle">２　</span><p class="sentence">${denseDefinitions ? `特別用語${String(n).padStart(4,'0')}及び` : ''}検査対象、書類、担当職員、申請者及び附則用語について、<a href="#Mp-Ch_1-At_1-Pr_1">第一条</a>及び<a href="/law/OTHER#Mp-At_2">他法令第二条</a>による。</p></div>`;
    const body = `<${modern ? 'div' : 'em'} class="${modern ? '_div_ArticleCaption' : 'articleheading'}">（試験条文）</${modern ? 'div' : 'em'}>${first}${second}`;
    return `<${modern ? 'section' : 'article'} class="${modern ? 'Article' : 'article'}" id="${id}">${modern ? body : `<div class="articlecontent">${body}</div>`}<div class="articleoptions" aria-label="条オプション"></div></${modern ? 'section' : 'article'}>`;
  };
  const texts = [
    'この法律において「検査対象」とは、検査を受ける物をいう。',
    '申請書類（以下「書類」という。）を提出する。',
    '担当職員（事務を担当する職員をいう。以下同じ。）が確認する。',
    'この法律において、用語の意義は、当該各号に定めるところによる。',
  ];
  return Array.from({ length: count }, (_, i) => article(i + 1,
    texts[i] || (denseDefinitions
      ? `この法律において「特別用語${String(i+1).padStart(4,'0')}」とは、検査に関する特別な手続をいう。`
      : '検査対象、書類、担当職員及び申請者は、記録を確認する。'.repeat(3)),
    i === 3 ? '<div class="item _div_ItemSentence" id="Mp-Ch_1-At_4-Pr_1-It_1"><span class="itemtitle">一　</span><div class="column"><p class="sentence">申請者</p>　</div><div class="column"><p class="sentence">申請をする者</p><br></div></div>' : ''
  )).join('') + article(1, 'この法律において「附則用語」とは、附則で使用する語をいう。', '', `${lawId}-Sp_1`)
    + article(2, '附則用語及び検査対象について定める。', '', `${lawId}-Sp_1`);
}

const hooks = `
  globalThis.normalTest = {
    reset(html) {
      clearDefinitionTooltips();
      clearExternalReferenceLinks();
      getDefinitionRoot().innerHTML = html;
      invalidateArticleCache();
      referenceTargetElementIndex = new Map();
      defTooltipEnabled = true;
      externalReferencesEnabled = false;
    },
    articles: getAllArticles,
    invalidateArticles: invalidateArticleCache,
    candidates: collectProvisionLinkTargets,
    extract: extractDefinitions,
    mark: markDefinedTerms,
    clearDefinitions: clearDefinitionTooltips,
    setDefinitions(definitions) { definitionMap = definitions; },
    setupDefinitionTooltipInteractions,
    showDefinitionTooltip,
    refs() { return collectInternalLawReferences(getDefinitionRoot(), {
      lawId: '${lawId}', lawTitle: '試験用法令', baseUrl: location.href
    }); },
    applyRefs(refs) {
      externalReferencesEnabled = true;
      return applyReferenceLinksForLaw(refs, { clear: true });
    },
    setupExternalReferenceInteractions,
    showReferencesPopup,
    getRoot: getDefinitionRoot,
  };
`;

// Runs in the isolated page. This is a prototype of the small wrapper only.
function installPrototype(options = {}) {
  const guard = options.guard || 'recapture';
  const store = new Map();
  const controls = { enabled: true, run: 0, getFailure: false, putFailure: false,
    beforeReturn: null, view: 'text', transformed: false };
  const api = window.normalTest;
  const root = () => api.getRoot();
  const encode = value => JSON.stringify(value);
  const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : encode(value)).length;
  const counters = { extracts: 0, referenceAnalyses: 0 };
  const capture = kind => {
    const target = root();
    if (controls.view !== 'text' || controls.transformed) return null;
    const articles = api.articles();
    if (!articles.length || articles.some(e => !target.contains(e)) || api.candidates().some(e => !target.contains(e))) return null;
    const ids = new Set();
    for (const el of target.querySelectorAll('[id]')) {
      if (ids.has(el.id)) return null;
      ids.add(el.id);
    }
    return { root: target, url: location.href, raw: encode([1, kind, '405AC0000000088', '試験用法令', location.href,
      articles.map(e => e.id), target.outerHTML]) };
  };
  const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map(n => n.toString(16).padStart(2, '0')).join('');
  const pack = defs => [...defs.values()].map(({ term, definition, key, targetDepth, sourceType, anchorEl }) =>
    ({ term, definition, key, targetDepth, sourceType, sourceId: anchorEl.id }));
  const unpack = records => {
    if (!Array.isArray(records)) throw new Error('invalid definitions');
    const index = new Map();
    for (const el of root().querySelectorAll('[id]')) {
      if (index.has(el.id)) throw new Error('ambiguous source');
      index.set(el.id, el);
    }
    const defs = new Map();
    for (const d of records) {
      if (!d || typeof d.term !== 'string' || typeof d.definition !== 'string'
          || typeof d.key !== 'string' || typeof d.sourceType !== 'string'
          || !Number.isInteger(d.targetDepth) || !index.has(d.sourceId)) throw new Error('invalid source');
      const el = index.get(d.sourceId);
      defs.set(d.term, { term: d.term, definition: d.definition, key: d.key,
        targetDepth: d.targetDepth, sourceType: d.sourceType,
        anchorEl: el, sourceEl: el, excludeEl: el });
    }
    return defs;
  };
  const validRefs = value => value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(v => Array.isArray(v?.externalLawSources)
      && v.externalLawSources.every(s => typeof s.sourceUrl === 'string'
        && typeof s.sourceProvisionText === 'string' && s.isInternalLawSource === true));
  const analyze = kind => {
    if (kind === 'definitions') { counters.extracts++; return api.extract(); }
    counters.referenceAnalyses++; return api.refs();
  };
  const get = async key => {
    if (controls.getFailure) throw new Error('get failed');
    const result = store.has(key) ? JSON.parse(store.get(key)) : null;
    if (controls.beforeReturn) { const f = controls.beforeReturn; controls.beforeReturn = null; f(); }
    return result;
  };
  const put = (key, record) => {
    if (controls.putFailure) throw new Error('put failed');
    store.set(key, encode(record));
  };
  async function acquire(kind, mode = 'cache') {
    const start = performance.now();
    const job = controls.run;
    if (!controls.enabled) return { status: 'cancelled' };
    if (mode === 'off') { const value = analyze(kind); return { status: 'off', value, ms: performance.now() - start }; }
    let changed = false;
    const observer = guard === 'observer' ? new MutationObserver(() => { changed = true; }) : null;
    const resized = () => { changed = true; };
    observer?.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    if (observer) window.addEventListener('resize', resized);
    const stopObserving = () => {
      if (observer?.takeRecords().length) changed = true;
      observer?.disconnect();
      if (observer) window.removeEventListener('resize', resized);
    };
    const input = capture(kind);
    if (!input) { stopObserving(); const value = analyze(kind); return { status: 'bypass', value, ms: performance.now() - start }; }
    const fingerprint = await hash(input.raw);
    const key = 'normalAnalysis:' + kind + ':405AC0000000088';
    let record;
    try { record = await get(key); } catch (_) {}
    stopObserving();
    if (!controls.enabled || job !== controls.run) return { status: 'cancelled' };
    const now = guard === 'observer' ? input : capture(kind);
    if (changed || !now || now.root !== input.root || root() !== input.root || !now.root.isConnected
        || now.raw !== input.raw || location.href !== input.url) return { status: 'stale' };
    if (record?.cacheVersion === 1 && record.fingerprint === fingerprint) {
      try {
        const value = kind === 'definitions' ? unpack(record.data) : validRefs(record.data) ? record.data : (() => { throw new Error('bad refs'); })();
        return { status: 'hit', value, ms: performance.now() - start, recordBytes: bytes(record), inputBytes: bytes(input.raw) };
      } catch (_) {}
    }
    const value = analyze(kind);
    const data = kind === 'definitions' ? pack(value) : value;
    const next = { cacheVersion: 1, fingerprint, savedAt: 0, data };
    try { put(key, next); } catch (_) {}
    return { status: 'miss', value, ms: performance.now() - start, recordBytes: bytes(next), inputBytes: bytes(input.raw) };
  }
  window.cacheExperiment = { store, controls, counters, capture, hash, pack, unpack, acquire, bytes,
    serialDefs: defs => encode(pack(defs)),
    key: kind => 'normalAnalysis:' + kind + ':405AC0000000088',
  };
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.equal(content.split('  startWhenDomReady(initializeLawPageFeatures);').length, 2);
  const instrumented = content.replace('  startWhenDomReady(initializeLawPageFeatures);', hooks);
  const mock = `window.chrome = { runtime:{sendMessage:async()=>({}),getURL:f=>f},storage:{onChanged:{addListener(){}},local:{get(keys,cb){if(cb){cb({});return;}return Promise.resolve({});},set:async()=>{},remove:async()=>{}}}};`;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://normal.test') return route.abort();
    const file = url.pathname.slice(1);
    if (file.startsWith('law/')) return route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><meta charset="utf-8"><title>試験用法令</title><h1>試験用法令</h1><div id="provisionview"></div>'
      + '<script src="/mock.js"></script><script src="/shared/egov-shared.js"></script><script src="/shared/egov-app.js"></script><script src="/content-controller.js"></script><script src="/content.js"></script>' });
    if (file === 'mock.js') return route.fulfill({ contentType: 'application/javascript', body: mock });
    if (!['shared/egov-shared.js', 'shared/egov-app.js', 'content-controller.js', 'content.js'].includes(file)) return route.abort();
    return route.fulfill({ contentType: 'application/javascript', body: file === 'content.js' ? instrumented : fs.readFileSync(path.join(root, file), 'utf8') });
  });
  const checks = [];
  const record = (name, details) => { checks.push({ name, passed: true, details }); console.log('PASS ' + name); };
  try {
    await page.goto(`https://normal.test/law/${lawId}`);
    await page.waitForFunction(() => !!window.normalTest);
    const guard = process.argv.includes('--observer') ? 'observer' : 'recapture';
    await page.evaluate(installPrototype, { guard });
    if (process.argv.includes('--profile-only')) {
      const profiles=[];
      for(const count of [240,800])for(const dense of [false,true]) {
        const profile=await page.evaluate(async({html,count,dense})=>{
          const t=normalTest,e=cacheExperiment,rows=[];
          for(const kind of ['definitions','internalReferences']) {
            t.reset(html);t.articles();e.store.clear();await e.acquire(kind);
            const serialized=e.store.get(e.key(kind)),samples=[];
            for(let i=-2;i<10;i++) {
              t.reset(html);t.articles();
              const s=performance.now(),first=e.capture(kind),a=performance.now();
              const hash=await e.hash(first.raw),b=performance.now();
              const record=JSON.parse(serialized),c=performance.now();
              const second=e.capture(kind),same=second.raw===first.raw,d=performance.now();
              const value=kind==='definitions'?e.unpack(record.data):record.data,end=performance.now();
              if(!same||hash!==record.fingerprint||!value)throw new Error('profile mismatch');
              if(i>=0)samples.push({captureMs:a-s,hashMs:b-a,jsonReadMs:c-b,recheckMs:d-c,bindMs:end-d,totalMs:end-s});
            }
            rows.push({kind,samples});
          }
          return {count:count+2,dense,rows};
        },{html:fixture(count,false,dense),count,dense});
        profiles.push(profile);
      }
      fs.writeFileSync(path.join(__dirname,'normal-cache-phase-results.json'),JSON.stringify({browser:browser.version(),profiles},null,2)+'\n');
      console.log('Completed phase profiles.');
      return;
    }
    for (const modern of [false, true]) {
      const html = fixture(24, modern);
      const result = await page.evaluate(async html => {
        const t = normalTest, e = cacheExperiment;
        t.reset(html); e.store.clear();
        const baseline = await e.acquire('definitions', 'off');
        const defs = e.serialDefs(baseline.value);
        const patterns = [...new Set([...baseline.value.values()].map(d => d.sourceType))].sort();
        const markCount = t.mark(baseline.value);
        const output = t.getRoot().innerHTML;
        t.reset(html);
        const miss = await e.acquire('definitions');
        t.reset(html);
        const before = e.counters.extracts;
        const hit = await e.acquire('definitions');
        const serializedMatch = defs === e.serialDefs(hit.value);
        const sourcesCurrent = [...hit.value.values()].every(d => d.anchorEl.isConnected
          && d.anchorEl === d.sourceEl && d.sourceEl === d.excludeEl);
        const restoredMarkCount = t.mark(hit.value);
        const htmlMatch = t.getRoot().innerHTML === output;
        return { patterns, markCount, restoredMarkCount, serializedMatch, sourcesCurrent,
          htmlMatch, miss: miss.status, hit: hit.status, extractedOnHit: e.counters.extracts - before,
          recordBytes: hit.recordBytes };
      }, html);
      assert.deepEqual(result.patterns, ['patternA','patternB','patternC','patternD']);
      assert.equal(result.miss, 'miss'); assert.equal(result.hit, 'hit');
      assert.equal(result.extractedOnHit, 0); assert.ok(result.markCount > 0);
      assert.equal(result.markCount, result.restoredMarkCount);
      assert.ok(result.serializedMatch && result.sourcesCurrent && result.htmlMatch);
      record(`${modern ? 'new' : 'old'} DOM: A/B/C/D definitions, current source rebinding, exact marked HTML`, result);
      const refs = await page.evaluate(async html => {
        const t = normalTest, e = cacheExperiment;
        t.reset(html); e.store.clear();
        const baseline = await e.acquire('internalReferences','off');
        const expected = JSON.stringify(baseline.value);
        await t.applyRefs(baseline.value);
        const output = t.getRoot().innerHTML;
        t.reset(html); await e.acquire('internalReferences');
        t.reset(html);
        const before = e.counters.referenceAnalyses;
        const hit = await e.acquire('internalReferences');
        await t.applyRefs(hit.value);
        return { hit: hit.status, analysesOnHit: e.counters.referenceAnalyses - before,
          jsonMatch: expected === JSON.stringify(hit.value), htmlMatch: output === t.getRoot().innerHTML,
          targets: Object.keys(hit.value).length,
          sourceCount: Object.values(hit.value).reduce((n,v)=>n+v.externalLawSources.length,0),
          clickableCount: t.getRoot().querySelectorAll('.egov-ext-reference-clickable').length,
          recordBytes: hit.recordBytes };
      }, html);
      assert.equal(refs.hit, 'hit'); assert.equal(refs.analysesOnHit,0);
      assert.ok(refs.jsonMatch && refs.htmlMatch && refs.clickableCount > 0);
      record(`${modern ? 'new' : 'old'} DOM: internal reference JSON and clickable DOM round trip`, refs);
    }
    const scenarios = await page.evaluate(async html => {
      const t=normalTest,e=cacheExperiment, outcomes=[];
      const prepare=async()=>{ t.reset(html);e.store.clear();e.controls.enabled=true;e.controls.run=0;
        e.controls.getFailure=false;e.controls.putFailure=false;e.controls.view='text';e.controls.transformed=false;
        await e.acquire('definitions');t.reset(html); };
      const test=async(name,alter)=>{await prepare();alter();const r=await e.acquire('definitions');outcomes.push({name,status:r.status});};
      await test('changed text',()=>{t.getRoot().querySelector('.sentence').firstChild.textContent+='訂正';});
      await test('href only',()=>{t.getRoot().querySelector('a').setAttribute('href','#Mp-Ch_1-At_3');});
      await test('duplicate IDs',()=>{const el=t.getRoot().querySelector('[id]');el.after(el.cloneNode(true));});
      await test('outside candidates',()=>{const el=document.createElement('div');el.id='OUTSIDE-At_999';document.body.append(el);});
      document.getElementById('OUTSIDE-At_999')?.remove();
      await test('comparison view',()=>{e.controls.view='compare';});
      await test('transformed text',()=>{e.controls.transformed=true;});
      await test('corrupt source ID',()=>{const k=e.key('definitions'),r=JSON.parse(e.store.get(k));r.data[0].sourceId='missing';e.store.set(k,JSON.stringify(r));});
      await test('corrupt record JSON',()=>{e.store.set(e.key('definitions'),'{broken');});
      await test('old cache version',()=>{const k=e.key('definitions'),r=JSON.parse(e.store.get(k));r.cacheVersion=0;e.store.set(k,JSON.stringify(r));});
      await test('storage get failure',()=>{e.controls.getFailure=true;});
      await test('storage put failure',()=>{e.store.clear();e.controls.putFailure=true;});
      await test('disabled during read',()=>{e.controls.beforeReturn=()=>{e.controls.enabled=false;};});
      await test('newer job during read',()=>{e.controls.beforeReturn=()=>{e.controls.run++;};});
      await test('text changed during read',()=>{e.controls.beforeReturn=()=>{t.getRoot().querySelector('.sentence').textContent+='更新';};});
      await test('root replaced during read',()=>{e.controls.beforeReturn=()=>{const old=t.getRoot();old.replaceWith(old.cloneNode(true));};});
      await test('same markup, descendants replaced with cached article list',()=>{e.controls.beforeReturn=()=>{t.getRoot().innerHTML=html;};});
      await test('same markup, descendants replaced and article list invalidated',()=>{e.controls.beforeReturn=()=>{t.getRoot().innerHTML=html;t.invalidateArticles();};});
      // Exact HTML hashing deliberately loses hits for unrelated UI/wrappers.
      await test('unrelated bookmark button',()=>{const b=document.createElement('button');b.className='egov-ext-bookmark';t.getRoot().append(b);});
      await test('parentheses wrapper',()=>{const p=t.getRoot().querySelector('.sentence');const s=document.createElement('span');s.className='egov-ext-muted-paren';s.textContent=p.firstChild.textContent;p.firstChild.replaceWith(s);});
      await prepare();
      const supplemented=await e.acquire('definitions');
      const supplement=[...supplemented.value.values()].find(d=>d.term==='附則用語');
      outcomes.push({name:'supplement source',status:supplement?.anchorEl.id,scopePreserved:supplement?.anchorEl.id.includes('-Sp_1-')});
      t.reset('<article class="article" id="Mp-At_1"><div class="articlecontent"><div class="paragraph" id="Mp-At_1-Pr_1"><p class="sentence">定義のない本文。</p></div></div></article>');
      e.store.clear();const emptyMiss=await e.acquire('definitions');const emptyHit=await e.acquire('definitions');
      outcomes.push({name:'zero definitions',status:emptyHit.status,size:emptyHit.value.size,first:emptyMiss.status});
      return outcomes;
    }, fixture());
    for (const item of scenarios) {
      const expected = ['comparison view','transformed text','duplicate IDs','outside candidates'].includes(item.name) ? 'bypass'
        : ['disabled during read','newer job during read'].includes(item.name) ? 'cancelled'
        : ['text changed during read','root replaced during read','same markup, descendants replaced with cached article list'].includes(item.name) ? 'stale'
        : item.name==='same markup, descendants replaced and article list invalidated' ? (guard==='observer'?'stale':'hit')
        : item.name==='zero definitions' ? 'hit'
        : item.name==='supplement source' ? null : 'miss';
      if (expected) assert.equal(item.status,expected,item.name);
      if (item.name==='supplement source') assert.ok(item.scopePreserved);
      if (item.name==='zero definitions') assert.equal(item.size,0);
      record(item.name,item);
    }
    // Real event handlers after source-ID restoration / JSON reference reuse.
    await page.evaluate(async html=>{
      normalTest.reset(html);cacheExperiment.store.clear();await cacheExperiment.acquire('definitions');normalTest.reset(html);
      const hit=await cacheExperiment.acquire('definitions');normalTest.setDefinitions(hit.value);normalTest.mark(hit.value);
      normalTest.setupDefinitionTooltipInteractions();
    },fixture());
    await page.locator('.egov-ext-defined-term[data-term="検査対象"]').first().click();
    await page.locator('.egov-ext-definition-tooltip').waitFor({state:'visible'});
    assert.match(await page.locator('.egov-ext-definition-tooltip').innerText(),/検査対象/);
    record('restored definitions open a real tooltip on click',{});
    await page.evaluate(async html=>{
      normalTest.reset(html);cacheExperiment.store.clear();await cacheExperiment.acquire('internalReferences');normalTest.reset(html);
      const hit=await cacheExperiment.acquire('internalReferences');await normalTest.applyRefs(hit.value);
      normalTest.setupExternalReferenceInteractions();
    },fixture());
    await page.locator('.egov-ext-reference-clickable').first().click();
    await page.locator('.egov-ext-reference-popup').waitFor({state:'visible'});
    record('restored reference JSON opens a real source popup on click',{});

    const benchmarks=[];
    const configurations=[... [24,240,800].flatMap(count=>[false,true].map(modern=>({count,modern,dense:false}))),
      {count:240,modern:false,dense:true},{count:800,modern:false,dense:true}];
    for (const {count,modern,dense} of configurations) {
        console.log(`BENCH ${count} articles, ${modern?'new':'old'} DOM, ${dense?'dense':'sparse'} definitions`);
        const result=await page.evaluate(async({html,count,modern,dense})=>{
          const t=normalTest,e=cacheExperiment;
          e.controls.enabled=true;e.controls.run=0;e.controls.getFailure=false;e.controls.putFailure=false;
          e.controls.view='text';e.controls.transformed=false;e.controls.beforeReturn=null;
          const results=[];
          for(const kind of ['definitions','internalReferences']) {
            const samples=[];
            for(let iteration=-2;iteration<10;iteration++) {
              const order=iteration%2===0?['off','hit','miss']:['miss','hit','off'];
              for(const mode of order) {
                t.reset(html);t.articles();e.store.clear();
                if(mode==='hit'){await e.acquire(kind);t.reset(html);t.articles();}
                const start=performance.now();
                const acquired=await e.acquire(kind,mode==='off'?'off':'cache');
                const analysisMs=performance.now()-start;
                const applyStart=performance.now();
                if(kind==='definitions')t.mark(acquired.value);
                // Reference application has idle-scheduling delays; measure its CPU
                // output equivalence above, and keep this benchmark analysis-only.
                const applyMs=kind==='definitions'?performance.now()-applyStart:null;
                if(iteration>=0)samples.push({iteration,mode,status:acquired.status,analysisMs,applyMs,
                  totalMs:kind==='definitions'?analysisMs+applyMs:null,
                  recordBytes:acquired.recordBytes,inputBytes:acquired.inputBytes});
              }
            }
            results.push({kind,samples});
          }
          t.reset(html);
          return {count:count+2,modern,dense,definitionCount:t.extract().size,htmlBytes:e.bytes(html),results};
        },{html:fixture(count,modern,dense),count,modern,dense});
        benchmarks.push(result);
    }
    assert.deepEqual(pageErrors,[]);
    const report={dateJapan:'2026-10-16',guard,browser:browser.version(),fixtureSource,
      productionSource:'Unmodified functions from current content.js and shared/egov-shared.js; automatic feature startup replaced with test hooks in memory.',
      storage:'In-memory JSON round-trip only. Native chrome.storage.local IPC, latency, quota and service worker behavior are NOT tested.',
      repetitions:{warmups:2,measuredPerMode:10,alternatedOrder:true},checks,benchmarks};
    fs.writeFileSync(path.join(__dirname,guard==='observer'?'normal-cache-observer-results.json':'normal-cache-experiment-results.json'),JSON.stringify(report,null,2)+'\n');
    console.log(`Completed: ${checks.length} checks, ${benchmarks.length} DOM/size combinations.`);
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
