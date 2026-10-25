const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();});

async function open(t,html='<p id="p1">追加説明。復元する文言。その後。</p>') {
  const page=await browser.newPage();t.after(()=>page.close());
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  t.after(()=>assert.deepEqual(errors,[]));
  await page.setContent(`<main id="provisionview"><article id="article" class="law-article" data-article-num="1"><div class="law-paragraph" data-paragraph-num="1">${html}</div></article></main>`);
  await page.addScriptTag({content:read('shared/egov-shared.js')});
  const source=read('content.js');
  const restore=source.slice(source.indexOf('  function restoreTextHighlightPortableRange('),source.indexOf('  function restoreTextHighlightRecord('));
  await page.addScriptTag({content:`
    const TEXT_HIGHLIGHT_PORTABLE_EXCLUDE_SELECTOR='rt,rp,.excluded';
    const rangeFromNormalizedTextAnchorOffsets=EgovShared.rangeFromNormalizedTextAnchorOffsets;
    const isRangeInsideProvisionView=range=>document.querySelector('#provisionview').contains(range.startContainer)&&document.querySelector('#provisionview').contains(range.endContainer);
    const textHighlightPortableRangeMatchesRecord=(range,record)=>EgovShared.textHighlightQuoteMatches(EgovShared.getTextRangeText(range,{excludeSelector:TEXT_HIGHLIGHT_PORTABLE_EXCLUDE_SELECTOR}).replace(/\\s+/g,''),record);
    ${restore}
    window.recordFor=(text,extra={})=>({id:'note',c:'yellow',a:'p1',h:'1.1',s:0,e:text.length,l:text.length,q:text.slice(0,256),z:text.length>256?text.slice(-128):'',u:'1.1',v:'1.1',x:0,y:text.length,f:2,w:EgovShared.getNormalizedTextSignature(text),m:'保存したメモ',...extra});
    window.recoverNormal=(record,starts=['p1'],ends=starts)=>{
      const index=new Map([[record.u,starts.map(id=>document.getElementById(id))],[record.v,ends.map(id=>document.getElementById(id))]]);
      return restoreTextHighlightPortableRange(record,index)?.toString()||null;
    };
  `});
  return page;
}

async function installNormalAnchorIndex(page) {
  const source=read('content.js');
  const between=(first,next)=>source.slice(source.indexOf(first),source.indexOf(next,source.indexOf(first)));
  await page.addScriptTag({content:`(()=>{
    const parseProvisionHash=EgovShared.parseProvisionHash;
    const getRangeContainerElement=node=>node instanceof Element?node:node?.parentElement;
    ${between('  function buildJumpHistoryKey(', '  function navigateJumpHistory(')}
    ${between('  function parseProvisionPath(', '  function getProvisionJumpKeyFromNode(')}
    ${between('  function formatTextHighlightPortableKey(', '  function getTextOffsetInAnchor(')}
    ${between('  function collectProvisionLinkTargets(', '  function getProvisionLinkCopyItems(')}
    ${between('  function getTextHighlightFallbackAnchorIndex(', '  function restoreTextHighlightPortableRange(')}
    window.restoreWithNormalIndex=record=>restoreTextHighlightPortableRange(record,getTextHighlightFallbackAnchorIndex({value:null}));
  })();`});
}

// Public wording and sibling layout from the e-Gov 2026-08-12 revision. No private
// memo text or user identifiers are part of this regression fixture.
const companyQuote='当該株式会社が前項第二号の損害を賠償するとすれば当該役員等が当該株式会社に対して第四百二十三条第一項の責任を負う場合には、同号に掲げる損失のうち当該責任に係る部分';
const companyPrefix='Mp-Pa_2-Ch_4-Se_12-At_430_2';
const companyParagraph=`<div id="${companyPrefix}-Pr_2" class="_div_ParagraphSentence"><span>２</span><span>株式会社は、補償契約を締結している場合であっても、当該補償契約に基づき、次に掲げる費用等を補償することができない。</span></div>
<div id="${companyPrefix}-Pr_2-It_1" class="_div_ItemSentence"><span>一</span><span>前項第一号に掲げる費用のうち通常要する費用の額を超える部分</span></div>
<div id="${companyPrefix}-Pr_2-It_2" class="_div_ItemSentence"><span>二</span><span>${companyQuote}</span></div>`;

test('company-law paragraph-2 memo made in Lite restores to its sibling item in normal mode',async t=>{
  const page=await open(t);
  await page.evaluate(({html,prefix})=>{
    document.getElementById('provisionview').innerHTML=`<section id="${prefix}">${html}</section>`;
  },{html:companyParagraph,prefix:companyPrefix});
  await installNormalAnchorIndex(page);
  const result=await page.evaluate(quote=>{
    const record=recordFor(quote,{u:'430_2.2',v:'430_2.2',x:86,y:167,w:'29-1oajcwt'});
    const range=restoreWithNormalIndex(record);
    return range?{text:EgovShared.getTextRangeText(range).replace(/\s/g,''),parent:range.startContainer.parentElement.closest('[id]').id}:null;
  },companyQuote);
  assert.deepEqual(result,{text:companyQuote,parent:companyPrefix+'-Pr_2-It_2'});
});

test('sibling-item recovery remains within the saved paragraph and rejects duplicate quotes',async t=>{
  const page=await open(t);
  await installNormalAnchorIndex(page);
  assert.deepEqual(await page.evaluate(({html,prefix,quote})=>{
    const root=document.getElementById('provisionview');
    const other=`<div id="${prefix}-Pr_3">別の項${quote}</div>`;
    root.innerHTML=`<section id="${prefix}">${html}${other}</section>`;
    const record=recordFor(quote,{u:'430_2.2',v:'430_2.2',x:86,y:167,w:'29-1oajcwt'});
    const restored=!!restoreWithNormalIndex(record);
    document.getElementById(prefix+'-Pr_2-It_2').remove();
    const wrongParagraph=restoreWithNormalIndex(record);
    root.innerHTML=`<section id="${prefix}">${html}<div id="${prefix}-Pr_2-It_3">${quote}</div></section>`;
    const ambiguous=restoreWithNormalIndex(record);
    return [restored,wrongParagraph?.toString()||null,ambiguous?.toString()||null];
  },{html:companyParagraph,prefix:companyPrefix,quote:companyQuote}),[true,null,null]);
});

test('normal mode recovers shifted offsets across formatting and excluded ruby',async t=>{
  const page=await open(t,'<p id="p1">追加説明。<b>復元</b>する <ruby>文言<rt>ぶんげん</rt></ruby>。その後。</p>');
  assert.equal((await page.evaluate(()=>recoverNormal(recordFor('復元する文言')))).replace(/\s/g,''),'復元する文言');
});

test('ambiguous, changed, missing and wrong-provision text are left unrestored',async t=>{
  const page=await open(t,'<p id="p1">説明。対象語。対象語。</p><p id="p2">復元する文言</p>');
  assert.equal(await page.evaluate(()=>recoverNormal(recordFor('対象語'))),null);
  assert.equal(await page.evaluate(()=>recoverNormal(recordFor('復元する文言'))),null);
  assert.equal(await page.evaluate(()=>recoverNormal(recordFor('存在しない'))),null);
  assert.equal(await page.evaluate(()=>recoverNormal(recordFor('対象語',{w:'wrong'}))),null);
});

test('long quote recovery verifies middle text, not just its saved head and tail',async t=>{
  const page=await open(t);
  assert.deepEqual(await page.evaluate(()=>{
    const text='甲'.repeat(256)+'原文'+'乙'.repeat(128);
    const record=recordFor(text);
    document.getElementById('p1').textContent='先頭追加'+text;
    const restored=recoverNormal(record)===text;
    document.getElementById('p1').textContent='先頭追加'+text.replace('原文','変更');
    return [restored,recoverNormal(record)];
  }),[true,null]);
});

test('a highlight spanning two provisions can recover without moving to another article',async t=>{
  const page=await open(t,'<p id="p1">前置き。始まり</p><p id="p2">終わり。後続</p>');
  assert.equal(await page.evaluate(()=>recoverNormal(recordFor('始まり終わり',{u:'1.1',v:'1.2',x:0,y:1}),['p1'],['p2'])),'始まり終わり');
});

async function createLite(page,failures=0) {
  await page.evaluate(failures=>{
    const paragraph=document.querySelector('.law-paragraph');paragraph.id='p1';
    window.savedRecords=[recordFor('復元する文言')];window.readFailures=failures;window.reads=0;window.writes=0;
    window.chrome={storage:{onChanged:{addListener(){}},local:{
      get:async()=>{reads++;if(readFailures>0){readFailures--;throw new Error('temporary read error');}return {'textHighlights:v1:law':savedRecords};},
      set:async()=>{writes++;},remove:async()=>{writes++;},
    }}};
  },failures);
  await page.addScriptTag({content:read('shared/text-highlights.js')});
  await page.evaluate(()=>{window.notes=EgovTextHighlights.create({root:document.getElementById('provisionview'),lawId:'law'});});
}

test('Lite restores shifted notes with their memo, without rewriting stored records',async t=>{
  const page=await open(t);await createLite(page);
  const entries=await page.evaluate(async()=>(await notes.getEntries()).map(entry=>({memo:entry.memo,text:entry.text,restored:!!entry.range})));
  assert.deepEqual(entries,[{memo:'保存したメモ',text:'復元する文言',restored:true}]);
  assert.equal(await page.evaluate(()=>writes),0);
});

test('temporary read failures retry; persistent failures allow retry without erasing notes',async t=>{
  const page=await open(t);await createLite(page,2);
  assert.equal(await page.evaluate(async()=>(await notes.getEntries())[0].memo),'保存したメモ');
  assert.equal(await page.evaluate(()=>reads),3);
  assert.equal(await page.evaluate(()=>writes),0);
  const failed=await open(t);await createLite(failed,100);
  await failed.waitForSelector('#egov-ext-text-highlight-restore-notice[data-load-failure]');
  assert.equal(await failed.evaluate(()=>writes),0);
  assert.equal(await failed.getByRole('button',{name:'再試行',exact:true}).count(),0);
  await failed.evaluate(()=>{readFailures=0;});
  await failed.evaluate(()=>notes.restore());
  await failed.waitForFunction(()=>!document.querySelector('[data-load-failure]'));
  assert.equal(await failed.evaluate(async()=>(await notes.getEntries())[0].memo),'保存したメモ');
  assert.equal(await failed.evaluate(()=>writes),0);
});

test('normal-mode loader does not mark failed reads as loaded and can retry them',async t=>{
  const page=await open(t);
  const source=read('content.js');
  const loader=source.slice(source.indexOf('  async function loadTextHighlightRecords()'),source.indexOf('  function getTextHighlightRecordSignature('));
  await page.addScriptTag({content:`(()=>{
    let textHighlightRecordsLoaded=false,textHighlightLoadPromise=null;
    const textHighlightRecords=new Map();
    const getTextHighlightStorageKey=()=> 'notes';
    const canRestoreTextHighlights=()=>true;
    const normalizeTextHighlightRecord=record=>record;
    window.normalReadFailures=100;window.normalWrites=0;
    window.chrome={storage:{local:{get:async()=>{
      if(normalReadFailures>0){normalReadFailures--;throw new Error('read unavailable');}
      return {notes:[{id:'saved',m:'元のメモ'}]};
    },set:async()=>{normalWrites++;}}}};
    async function restoreTextHighlights(){await loadTextHighlightRecords();}
    ${loader}
    window.loadNormalNotes=loadTextHighlightRecords;
    window.normalState=()=>({loaded:textHighlightRecordsLoaded,memo:textHighlightRecords.get('saved')?.m,writes:normalWrites});
  })();`});
  assert.equal(await page.evaluate(async()=>{try{await loadNormalNotes();return true;}catch{return false;}}),false);
  assert.equal(await page.evaluate(()=>normalState().loaded),false);
  assert.equal(await page.getByRole('button',{name:'再試行',exact:true}).count(),0);
  await page.evaluate(()=>{normalReadFailures=0;});
  await page.evaluate(()=>loadNormalNotes());
  await page.waitForFunction(()=>normalState().loaded);
  assert.deepEqual(await page.evaluate(()=>normalState()),{loaded:true,memo:'元のメモ',writes:0});
});

test('late paragraph text restores automatically without a manual retry button',async t=>{
  const page=await open(t,'<p id="p1">まだ本文がありません。</p>');await createLite(page);
  await page.waitForSelector('#egov-ext-text-highlight-restore-notice .egov-ext-text-highlight-restore-actions');
  assert.deepEqual(await page.locator('.egov-ext-text-highlight-restore-actions button').allTextContents(),['テキスト保存','削除','無視']);
  await page.evaluate(()=>{document.querySelector('.law-paragraph p').textContent='本文が到着。復元する文言。';});
  await page.waitForFunction(()=>CSS.highlights.get('egov-ext-text-highlight-yellow')?.size===1);
  assert.equal(await page.evaluate(async()=>!!(await notes.getEntries())[0].range),true);
  assert.equal(await page.evaluate(()=>writes),0);
});
