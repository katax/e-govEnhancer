const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const context=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../shared/transfer-data.js'),'utf8'),context);
const {mergeFavoritesImport,mergeTextHighlightsImport}=context.EgovTransferData;
const clone=value=>JSON.parse(JSON.stringify(value));
const favorite=(lawId,folderId=null)=>({lawId,lawName:lawId,lawNum:'',lawType:'',folderId});
const favorites=(rows=[],folders=[],collapsed={})=>({type:'egov-extension-favorites',version:1,favorites:rows,favFolders:folders,folderCollapsed:collapsed});
const note=(id,t,m=id)=>({id,t,m,c:'yellow',a:'a',h:'',k:'',s:0,e:1,l:1,q:'字',z:'',p:'',n:'',u:'1.1',v:'1.1',x:0,y:1,f:2});
const notes=laws=>({type:'egov-extension-text-highlights',version:1,laws});
const law='417AC0000000086',other='129AC0000000089';

test('favorites merge keeps local duplicate settings and unrelated favorites',()=>{
  const local=favorites([{...favorite('A'),lastScrollTop:42},favorite('B')]);
  const imported=favorites([{...favorite('A'),lawName:'imported'},favorite('C')]);
  const original=JSON.stringify([local,imported]);
  const result=mergeFavoritesImport(local,imported);
  assert.deepEqual(clone(result.favorites.map(row=>row.lawId)),['A','B','C']);
  assert.equal(result.favorites[0].lastScrollTop,42);
  assert.equal(result.favorites[0].lawName,'A');
  assert.equal(JSON.stringify([local,imported]),original);
  assert.deepEqual(clone(mergeFavoritesImport(result,imported)),clone(result));
});

test('folder ID collisions remap new favorites, while equal names reuse local folders',()=>{
  const local=favorites([favorite('A','folder')],[{id:'folder',name:'Local'}],{folder:true});
  const incoming=favorites([favorite('B','folder'),favorite('C','different')],
    [{id:'folder',name:'Remote'},{id:'different',name:'Local'}],{folder:false,different:false});
  const result=mergeFavoritesImport(local,incoming);
  const remote=result.favFolders.find(row=>row.name==='Remote');
  assert.notEqual(remote.id,'folder');
  assert.equal(result.favorites.find(row=>row.lawId==='B').folderId,remote.id);
  assert.equal(result.favorites.find(row=>row.lawId==='C').folderId,'folder');
  assert.equal(result.folderCollapsed.folder,true);
  assert.equal(result.folderCollapsed[remote.id],false);
  assert.deepEqual(clone(mergeFavoritesImport(result,incoming)),clone(result));
});

test('favorites above the combined limit fail without truncating or mutating inputs',()=>{
  const local=favorites(Array.from({length:50},(_,i)=>favorite('law'+i)));
  const original=JSON.stringify(local);
  assert.throws(()=>mergeFavoritesImport(local,favorites([favorite('extra')])),/上限は50/);
  assert.equal(JSON.stringify(local),original);
});

test('memo merge retains other laws and resolves identical IDs by modification time',()=>{
  const local=notes({[law]:[note('newer',20,'local'),note('older',10),note('equal',10,'local')],[other]:[note('untouched',5)]});
  const incoming=notes({[law]:[note('newer',10,'old'),note('older',20,'imported'),note('equal',10,'remote'),note('added',1)]});
  const original=JSON.stringify([local,incoming]);
  const result=mergeTextHighlightsImport(local,incoming);
  const byId=new Map(result.laws[law].map(row=>[row.id,row]));
  assert.equal(byId.get('newer').m,'local');assert.equal(byId.get('older').m,'imported');
  assert.equal(byId.get('equal').m,'local');assert.ok(byId.has('added'));
  assert.equal(result.laws[other][0].m,'untouched');
  assert.equal(JSON.stringify([local,incoming]),original);
  assert.deepEqual(clone(mergeTextHighlightsImport(result,incoming)),clone(result));
});

test('empty imports are no-ops for merge, and invalid data is rejected',()=>{
  const local=notes({[law]:[note('one',1)]});
  assert.deepEqual(clone(mergeTextHighlightsImport(local,notes({})).laws),clone(local.laws));
  assert.equal(mergeFavoritesImport(favorites([favorite('A')]),favorites()).favorites.length,1);
  assert.throws(()=>mergeTextHighlightsImport(local,notes({[law]:[note('bad',1),note('bad',2)]})),/重複/);
});

test('combined memo count is checked without dropping any records',()=>{
  const local=notes({[law]:Array.from({length:10000},(_,i)=>note('n'+i,1))});
  assert.throws(()=>mergeTextHighlightsImport(local,notes({[law]:[note('extra',2)]})),/最大 10000/);
  assert.equal(local.laws[law].length,10000);
});

test('retired external file modules and options are no longer wired into the extension',()=>{
  const root=path.join(__dirname,'..');
  for(const file of ['shared/external-files.js','shared/external-files-background.js','shared/external-files-options.js']) assert.equal(fs.existsSync(path.join(root,file)),false);
  assert.doesNotMatch(fs.readFileSync(path.join(root,'options.html'),'utf8'),/ExternalFileSettings|external-files/);
  assert.doesNotMatch(fs.readFileSync(path.join(root,'background.js'),'utf8').split('\n')[0],/external-files/);
});
