const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
test('source labels include local article, paragraph, item, branches and supplements in both UIs',()=>{
  const context=vm.createContext({URL});vm.runInContext(read('shared/egov-shared.js'),context);
  const format=context.EgovShared.formatProvisionSourcePathFromEgovUrl;
  const cases={ 'paragraph-182-2':'第182条第2項', 'item-44-1-3':'第44条第1項第3号',
    'paragraph-222_2-1':'第222条の2第1項','Sp_4-paragraph-1-2-5':'附則第1条第2項',
    'Sp-item-19_3-2-1':'附則第19条の3第2項第1号','article-309':'第309条',
    'paragraph-1':'前文第1項','Sp-paragraph-1':'附則第1項'};
  for(const [hash,label] of Object.entries(cases)) {
    assert.equal(format('viewer.html?localRule=criminal-procedure#'+hash),label);
    assert.equal(format('chrome-extension://test/viewer.html?localRule=criminal-procedure#'+hash),label);
  }
  assert.equal(format('https://laws.e-gov.go.jp/law/323AC0000000131#Mp-At_309-Pr_2'),'第309条第2項');
  for(const file of ['content.js','viewer.js']){
    const source=read(file),start=source.indexOf('  function getReferenceSourceLabel('),end=source.indexOf('\n  function ',start+5);
    const realm=vm.createContext({formatProvisionSourcePathFromEgovUrl:format,location:{href:'https://laws.e-gov.go.jp/'}});
    vm.runInContext(source.slice(start,end),realm);
    assert.equal(realm.getReferenceSourceLabel({sourceLawTitle:'刑事訴訟規則',sourceUrl:'viewer.html?localRule=criminal-procedure#paragraph-182-2'}),'刑事訴訟規則 第182条第2項');
  }
});
function setup(){
  const calls=[];
  const context=vm.createContext({URL,Response,chrome:{runtime:{getURL:f=>'chrome-extension://test/'+f}},
    fetch:async url=>{calls.push(url);return new Response(read(url.replace('chrome-extension://test/','')));}});
  vm.runInContext(read('shared/egov-shared.js'),context);
  vm.runInContext(read('shared/local-references-background.js'),context);
  return {api:context.EgovLocalReferences,calls};
}
test('unregistered law reads the small ID index only',async()=>{
  const s=setup();const api={'1':{externalLawSources:[]}};
  assert.equal(await s.api.merge('999AC0000000000',api),api);
  assert.deepEqual(s.calls,['chrome-extension://test/data/local-references/index.json']);
});
test('API and local sources coexist, use absolute viewer links and reuse installed data in both modes',async()=>{
  const s=setup();
  const api={'2.9.2':{externalLawSources:[{sourceLawId:'327CO0000000373',sourceLawTitle:'組織令',sourceUrl:'https://laws.e-gov.go.jp/law/327CO0000000373#Mp-At_16'}]}};
  for(const mode of ['normal','lite']){
    const result=await s.api.merge('322AC0000000054',api);
    assert.ok(result['2.9.2'].externalLawSources.some(x=>x.sourceLawId==='327CO0000000373'));
    assert.ok(result['2.9.2'].externalLawSources.some(x=>x.sourceLawId==='LOCALDOC80320A680A7A'&&x.sourceUrl.startsWith('chrome-extension://test/viewer.html?localRule=')));
  }
  assert.equal(s.calls.filter(x=>x.endsWith('/references.json')).length,1);
});
test('local target IDs work independently of e-Gov IDs and both UIs route local sources directly',async()=>{
  const s=setup();const index=JSON.parse(read('data/local-references/index.json'));
  const id=Object.keys(index.targets).find(x=>x.startsWith('COURTRULE'));assert.ok(id);
  assert.ok(Object.keys(await s.api.get(id)).length);
  for(const file of ['content.js','viewer.js'])assert.match(read(file),/source(?:\?|)\.sourceUrl\?\.startsWith\(chrome\.runtime\.getURL\('viewer.html'\)/);
});
test('export returns the bundled-only JSON and installed index matches all data targets',async()=>{
  const expected=JSON.parse(read('data/local-references/references.json'));
  assert.deepEqual(Object.keys(JSON.parse(read('data/local-references/index.json')).targets).sort(),Object.keys(expected).sort());
  const context=vm.createContext({chrome:{runtime:{getURL:x=>x}},fetch:async file=>new Response(read(file))});
  const source=read('options.js');vm.runInContext(source.slice(source.indexOf('  async function readBundledReferencesForExport()'),source.indexOf('  async function exportReferences()')),context);
  assert.deepEqual(JSON.parse(JSON.stringify(await context.readBundledReferencesForExport())),expected);
});
test('normal and Lite open a bundled source in its local viewer without asking e-Gov for it',async()=>{
  for(const file of ['content.js','viewer.js']){
    const calls=[];
    const context=vm.createContext({hideReferencesPopup(){},isLawRefScrollMode:()=>true,lawRefOtherLawPopupEnabled:false,
      shouldOpenReferenceSourcePopup:()=>false,chrome:{runtime:{getURL:f=>'chrome-extension://test/'+f,
      sendMessage:async message=>{calls.push(message);return {ok:true};}}}});
    const code=read(file),start=code.indexOf(file==='content.js'?'  async function openReferenceSource(':'  function openReferenceSource(');
    const end=code.indexOf('  function clearExternalReferenceLinks(',start);
    vm.runInContext(code.slice(start,end),context);
    const url='chrome-extension://test/viewer.html?localRule=local-doc-80320a680a7a#paragraph-3-1';
    await context.openReferenceSource({sourceLawId:'LOCALDOC80320A680A7A',sourceUrl:url});
    assert.equal(calls.length,1);assert.equal(calls[0].type,'egov-open-law-reference-tab');assert.equal(calls[0].url,url);
  }
});
test('both modes honor popup mode and Ctrl inversion for local references',async()=>{
  for(const file of ['content.js','viewer.js'])for(const ctrlKey of [false,true]){
    let popups=0,tabs=0;
    const realm=vm.createContext({hideReferencesPopup(){},isLawRefScrollMode:()=>false,lawRefOtherLawPopupEnabled:false,
      shouldOpenReferenceSourcePopup:event=>!event.ctrlKey,EgovApp:{showLocalReferencePopup:()=>popups++},
      chrome:{runtime:{getURL:f=>'chrome-extension://test/'+f,sendMessage:async()=>{tabs++;}}}});
    const source=read(file),start=source.indexOf(file==='content.js'?'  async function openReferenceSource(':'  function openReferenceSource(');
    vm.runInContext(source.slice(start,source.indexOf('  function clearExternalReferenceLinks(',start)),realm);
    await realm.openReferenceSource({sourceLawId:'COURTRULECRIMPROC001',sourceUrl:'chrome-extension://test/viewer.html?localRule=criminal-procedure#paragraph-182-2'},{ctrlKey});
    assert.equal(popups,ctrlKey?0:1);assert.equal(tabs,ctrlKey?1:0);
  }
});
