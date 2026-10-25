const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();});
const law='417AC0000000086',other='129AC0000000089';
const prefix='textHighlights:v1:';
const favorite=(lawId,folderId=null)=>({lawId,lawName:lawId,lawNum:'',lawType:'',folderId});
const favorites=(rows,folders=[])=>({type:'egov-extension-favorites',version:1,favorites:rows,favFolders:folders,folderCollapsed:{}});
const note=(id,t,m=id)=>({id,t,m,c:'yellow',a:'a',h:'',k:'',s:0,e:1,l:1,q:'字',z:'',p:'',n:'',u:'1.1',v:'1.1',x:0,y:1,f:2});
const notes=laws=>({type:'egov-extension-text-highlights',version:1,laws});

async function open(t,initial={}) {
  const context=await browser.newContext();t.after(()=>context.close());
  await context.route('https://extension.test/**',route=>{
    const file=path.resolve(root,'.'+new URL(route.request().url()).pathname);
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.abort();
    const contentType={'.js':'application/javascript','.html':'text/html','.css':'text/css','.json':'application/json'}[path.extname(file)]||'application/octet-stream';
    return route.fulfill({contentType,body:fs.readFileSync(file)});
  });
  await context.addInitScript(initial=>{
    if(!localStorage.getItem('initialized')){localStorage.setItem('settings',JSON.stringify(initial));localStorage.setItem('initialized','yes');}
    window.failWrites=false;window.writeCount=0;
    window.chrome={storage:{onChanged:{addListener(){}},local:{
      get:async()=>JSON.parse(localStorage.getItem('settings')),
      set:async items=>{if(failWrites)throw new Error('test write failure');writeCount++;localStorage.setItem('settings',JSON.stringify({...JSON.parse(localStorage.getItem('settings')),...items}));},
      remove:async keys=>{if(failWrites)throw new Error('test write failure');writeCount++;const value=JSON.parse(localStorage.getItem('settings'));for(const key of keys)value[key]&&delete value[key];localStorage.setItem('settings',JSON.stringify(value));},
    }},runtime:{getURL:file=>location.origin+'/'+file,sendMessage:async()=>({})},tabs:{query:async()=>[],create:async()=>{},reload(){}},commands:{getAll:async()=>[]}};
  },initial);
  const page=await context.newPage();const errors=[],dialogs=[];
  page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
  let cancel=false;
  page.on('dialog',async dialog=>{dialogs.push(dialog.message());if(cancel){cancel=false;await dialog.dismiss();}else await dialog.accept();});
  await page.goto('https://extension.test/options.html');
  return {page,dialogs,cancelNext:()=>{cancel=true;}};
}
const stored=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('settings')));
async function upload(page,id,data) {
  await page.locator('#'+id).setInputFiles({name:'import.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
}
async function status(page,id,text){await page.waitForFunction(({id,text})=>document.getElementById(id).textContent.includes(text),{id,text});}

test('favorites merge and replace use the actual options file-import flow',async t=>{
  const s=await open(t,{favorites:[favorite('A','folder')],favFolders:[{id:'folder',name:'Local'}],folderCollapsed:{folder:true},unrelated:'keep'});
  const {page}=s;const incoming=favorites([favorite('A','folder'),favorite('B','folder')],[{id:'folder',name:'Remote'}]);
  assert.equal(await page.locator('#favoritesImportMode').inputValue(),'merge');
  assert.equal(await page.getByText('外部ファイルで自動保存・同期（任意）',{exact:true}).count(),0);
  await upload(page,'importFavoritesInput',incoming);await status(page,'favoritesTransferStatus','マージしました');
  let result=await stored(page);
  assert.equal(result.favorites.length,2);assert.equal(result.favorites[0].folderId,'folder');
  assert.equal(result.favFolders.find(folder=>folder.id===result.favorites[1].folderId).name,'Remote');
  assert.equal(result.folderCollapsed.folder,true);assert.equal(result.unrelated,'keep');
  await upload(page,'importFavoritesInput',incoming);await status(page,'favoritesTransferStatus','マージしました');
  assert.equal((await stored(page)).favorites.length,2);
  fs.mkdirSync(path.join(root,'tmp'),{recursive:true});
  await page.locator('section.card').filter({has:page.getByRole('heading',{name:'お気に入りの保存と読み込み',exact:true})})
    .screenshot({path:path.join(root,'tmp/options-import-merge.png')});
  await page.locator('#favoritesImportMode').selectOption('replace');
  await upload(page,'importFavoritesInput',incoming);await status(page,'favoritesTransferStatus','置き換えました');
  result=await stored(page);
  assert.deepEqual(result.favFolders,[{id:'folder',name:'Remote'}]);
  assert.equal(result.favorites[0].folderId,'folder');assert.equal(result.unrelated,'keep');
  assert.match(s.dialogs[0],/マージ/);assert.match(s.dialogs.at(-1),/置き換え/);
});

test('memo merge keeps untouched laws, updates newer IDs, and replacement removes missing laws',async t=>{
  const {page}=await open(t,{favorites:[favorite('keep')],[prefix+law]:[note('same',10,'local'),note('local-only',1)],[prefix+other]:[note('other-law',1)]});
  const incoming=notes({[law]:[note('same',20,'newer'),note('added',2)]});
  await upload(page,'importTextHighlightsInput',incoming);await status(page,'textHighlightsTransferStatus','マージしました');
  let result=await stored(page);
  assert.equal(result[prefix+law].length,3);assert.equal(result[prefix+law].find(row=>row.id==='same').m,'newer');
  assert.equal(result[prefix+other][0].id,'other-law');assert.equal(result.favorites[0].lawId,'keep');
  await upload(page,'importTextHighlightsInput',incoming);await status(page,'textHighlightsTransferStatus','マージしました');
  assert.equal((await stored(page))[prefix+law].length,3);
  await page.locator('#textHighlightsImportMode').selectOption('replace');
  await upload(page,'importTextHighlightsInput',incoming);await status(page,'textHighlightsTransferStatus','置き換えました');
  result=await stored(page);
  assert.equal(result[prefix+law].length,2);assert.equal(result[prefix+other],undefined);
  assert.equal(result.favorites[0].lawId,'keep');
  await page.locator('#textHighlightsImportMode').selectOption('merge');
  await upload(page,'importTextHighlightsInput',notes({}));await status(page,'textHighlightsTransferStatus','マージしました');
  assert.deepEqual(await stored(page),result);
  await page.locator('#textHighlightsImportMode').selectOption('replace');
  await upload(page,'importTextHighlightsInput',notes({}));await status(page,'textHighlightsTransferStatus','置き換えました');
  const empty=await stored(page);
  assert.equal(Object.keys(empty).filter(key=>key.startsWith(prefix)).length,0);
  assert.equal(empty.favorites[0].lawId,'keep');
});

test('cancel, malformed input, combined capacity and storage failures do not overwrite data',async t=>{
  const initial={favorites:Array.from({length:50},(_,i)=>favorite('law'+i)),favFolders:[],folderCollapsed:{},[prefix+law]:[note('keep',1)]};
  const s=await open(t,initial);const {page}=s;
  s.cancelNext();await upload(page,'importFavoritesInput',favorites([favorite('extra')]));
  await status(page,'favoritesTransferStatus','キャンセル');assert.deepEqual(await stored(page),initial);
  await upload(page,'importFavoritesInput',favorites([favorite('extra')]));
  await status(page,'favoritesTransferStatus','上限は50');assert.deepEqual(await stored(page),initial);
  await upload(page,'importTextHighlightsInput',{type:'wrong'});
  await status(page,'textHighlightsTransferStatus','読み込めません');assert.deepEqual(await stored(page),initial);
  await page.evaluate(()=>{failWrites=true;});
  await page.locator('#textHighlightsImportMode').selectOption('replace');
  await upload(page,'importTextHighlightsInput',notes({[other]:[note('new',1)]}));
  await status(page,'textHighlightsTransferStatus','読み込みに失敗');assert.deepEqual(await stored(page),initial);
});
