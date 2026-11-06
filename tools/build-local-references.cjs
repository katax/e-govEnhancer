// Build reverse references from the bundled XML using the same provision linker
// as the local viewer. No network requests and no runtime source changes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const catalog = JSON.parse(read('data/court-rules/catalog.json'));
// Reuse the old corpus as a name/ID dictionary, not as reverse-reference rows.
const oldReferences = fs.existsSync(path.join(root,'data/references.json'))
  ? JSON.parse(read('data/references.json').replace(/^\uFEFF/,'')) : {};
const names = new Map(catalog.referenceLaws || []);
if(fs.existsSync(path.join(root,'data/local-references/law-names.json')))
  for(const entry of JSON.parse(read('data/local-references/law-names.json'))) names.set(...entry);
for (const provisions of Object.values(oldReferences)) for (const entry of Object.values(provisions))
  for (const source of entry.externalLawSources || []) if(source.sourceLawTitle&&source.sourceLawId)names.set(source.sourceLawTitle,source.sourceLawId);
for(const rule of catalog.rules)names.set(rule.title,rule.id);
const lawNames=[...names];
const output = path.join(root, 'data/local-references');
const digest = name => crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const references = {}, evidence = [], documents = [], review = [], errors = [];
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.chrome = { runtime: { getURL: file => 'https://local-reference-build.test/' + file, sendMessage: async () => ({}) },
        storage: { onChanged: { addListener() {} }, local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } };
      // Rendering is invoked explicitly. Deferred UI enhancements are unnecessary.
      window.requestIdleCallback = () => 0;
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://local-reference-build.test') return route.abort();
      const file = decodeURIComponent(url.pathname.slice(1));
      if (!file || file.includes('..')) return route.abort();
      let body = read(file);
      if (file === 'viewer.js') {
        if (!body.includes('  loadLaw();')) throw new Error('Viewer entry point changed');
        body = body.replace('  loadLaw();', () => `  globalThis.renderLocalReferences = renderLawXml;
          globalThis.configureReferenceNames = (entries, xml) => {
            const slash = String.fromCharCode(92);
            const escape = text => [...text].map(c => '^$.*+?()[]{}|'.includes(c) || c === slash ? slash+c : c).join('');
            const all = new Map(entries);
            const titles = [...all.keys()].sort((a,b)=>b.length-a.length);
            const explicit = new RegExp('(' + titles.map(escape).join('|') + ')(?:（[^）]*）)?$');
            const original = resolveLocalRuleReferenceLawId;
            resolveLocalRuleReferenceLawId = (text,index,previous='') => {
              const prefix = text.slice(0,index).replace(/\\s+/g,'');
              const match = prefix.match(explicit);
              return match ? all.get(match[1]) : original(text,index,previous);
            };
          };`);
      }
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const rule of catalog.rules) {
      await page.goto('https://local-reference-build.test/viewer.html?localRule=' + encodeURIComponent(rule.slug));
      try { await page.waitForFunction(() => typeof renderLocalReferences === 'function',null,{timeout:5000}); }
      catch(error){throw new Error(errors.join('\n') || error.message);}
      const extracted = await page.evaluate(({ xml, rules, rule, lawNames }) => {
        configureReferenceNames(lawNames,xml);
        renderLocalReferences(xml);
        const root = document.getElementById('law-content') || document.querySelector('.law-article')?.parentElement;
        if (!root) throw new Error('Rendered law root missing');
        const found = [], uncertain = [];
        const bySlug = new Map(rules.map(r => [r.slug,r.id]));
        for (const anchor of root.querySelectorAll('a[href]')) {
          const url = new URL(anchor.href);
          const target = url.pathname.match(/^\/law\/([^/]+)/)?.[1] || bySlug.get(url.searchParams.get('localRule'));
          if (!target || target === rule.id) continue;
          const key = EgovShared.getReferenceTargetKeyFromEgovUrl(url.href);
          if (!key) continue;
          const source = anchor.closest('.law-item[id], .law-paragraph[id], .law-article[id]') || anchor.closest('[id]');
          if (!source?.id) { uncertain.push({reason:'source-position',text:anchor.textContent}); continue; }
          let keys = [key];
          const range = anchor.textContent.match(/^第(.+?)条から第?(.+?)条まで$/);
          if (range) {
            const first=EgovShared.parseJapaneseReferenceNumber(range[1]),last=EgovShared.parseJapaneseReferenceNumber(range[2]);
            if (Number.isInteger(first)&&Number.isInteger(last)&&last>=first&&last-first<500) keys=Array.from({length:last-first+1},(_,i)=>String(first+i));
            else uncertain.push({reason:'range',text:anchor.textContent});
          }
          for (const targetKey of keys) found.push({targetLawId:target,targetKey,sourceId:source.id,
            text:anchor.textContent,context:anchor.parentElement.textContent});
        }
        // Unlinked explicit article citations require review; do not invent targets.
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
        let node;
        while((node=walker.nextNode())) {
          if(node.parentElement.closest('a,script,style,.law-toc'))continue;
          if(/(?:法律|法|規則)(?:（[^）]*）)?第[〇零一二三四五六七八九十百千万0-9０-９]+条/.test(node.textContent))
            uncertain.push({reason:'unlinked-explicit-citation',text:node.textContent.trim()});
        }
        return {found,uncertain};
      }, { xml: read(rule.dataPath), rules: catalog.rules, rule, lawNames });
      let added = 0;
      for (const row of extracted.found) {
        const sources = ((references[row.targetLawId] ||= {})[row.targetKey] ||= {externalLawSources:[]}).externalLawSources;
        const source = { sourceLawId: rule.id, sourceLawTitle: rule.title,
          sourceUrl: `viewer.html?localRule=${encodeURIComponent(rule.slug)}#${encodeURIComponent(row.sourceId)}` };
        if (!sources.some(s => s.sourceUrl === source.sourceUrl && s.sourceLawId === source.sourceLawId)) { sources.push(source); added++; }
        evidence.push({sourceLawId:rule.id,...row});
      }
      review.push(...extracted.uncertain.map(row=>({sourceLawId:rule.id,sourceLawTitle:rule.title,...row})));
      documents.push({id:rule.id,title:rule.title,path:rule.dataPath,sha256:digest(rule.dataPath),references:added});
    }
    if(errors.length)throw new Error(errors.join('\n'));
    // Deterministic output: keep metadata outside the legacy schema.
    const sorted = {};
    for (const id of Object.keys(references).sort()) {
      sorted[id]={};
      for(const key of Object.keys(references[id]).sort((a,b)=>a.localeCompare(b,'en',{numeric:true}))) {
        const value=references[id][key];value.externalLawSources.sort((a,b)=>a.sourceLawId.localeCompare(b.sourceLawId)||a.sourceUrl.localeCompare(b.sourceUrl));
        sorted[id][key]=value;
      }
    }
    fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'law-names.json'),JSON.stringify(lawNames,null,2)+'\n');
    fs.writeFileSync(path.join(output,'references.json'),JSON.stringify(sorted,null,2)+'\n');
    fs.writeFileSync(path.join(output,'index.json'),JSON.stringify({ targets: Object.fromEntries(Object.keys(sorted).map(id=>[id,true])) },null,2)+'\n');
    const stats={documents:documents.length,sourceDocuments:documents.filter(d=>d.references).length,targetLaws:Object.keys(sorted).length,
      targetProvisions:Object.values(sorted).reduce((n,x)=>n+Object.keys(x).length,0),references:documents.reduce((n,x)=>n+x.references,0),review:review.length};
    fs.writeFileSync(path.join(output,'build-report.json'),JSON.stringify({stats,inputs:{catalog:digest('data/court-rules/catalog.json'),viewer:digest('viewer.js'),shared:digest('shared/egov-shared.js')},documents,review,evidence},null,2)+'\n');
    console.log(JSON.stringify(stats,null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
