const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const ORIGIN='https://laws.e-gov.go.jp',LAW='129AC0000000089',URL_LAW=ORIGIN+'/law/'+LAW;
function setup(){
 const stores=new Map(),session={},listeners=[],events={},updates=[],opened=[];let tabUrl=URL_LAW,textReads=0;
 const caches={open:async name=>{opened.push(name);if(!stores.has(name))stores.set(name,new Map());const data=stores.get(name);
  const key=k=>typeof k==='string'?k:k.url;return {keys:async()=>[...data.keys()].map(url=>({url})),match:async k=>{
    const result=data.get(key(k))?.clone();if(result){const original=result.text.bind(result);result.text=()=>{textReads++;return original();};}return result;
  },put:async(k,v)=>data.set(key(k),v.clone()),delete:async k=>data.delete(key(k))};},keys:async()=>[...stores.keys()]};
 const chrome={runtime:{id:'test',getURL:f=>'chrome-extension://test/'+f,getManifest:()=>({version:'2.7.0'}),onMessage:{addListener:f=>listeners.push(f)}},
  storage:{local:{get:async()=>({normalResponseCacheFrequency:'daily'}),set:async()=>{}},session:{set:async value=>Object.assign(session,value),get:async key=>({[key]:session[key]}),remove:async key=>delete session[key]}},
  tabs:{get:async()=>({url:tabUrl}),update:async(id,update)=>updates.push({id,...update}),onRemoved:{addListener(){}}},
  webNavigation:Object.fromEntries(['onBeforeNavigate','onCommitted','onErrorOccurred'].map(name=>[name,{addListener:f=>events[name]=f}]))};
 const context=vm.createContext({URL,Headers,Response,TextEncoder,crypto:webcrypto,chrome,caches,setTimeout,clearTimeout,fetch:()=>{throw Error('Unexpected network');}});
 for(const f of ['shared/egov-shared.js','shared/normal-cache-fallback-background.js','shared/normal-response-cache-background.js'])vm.runInContext(read(f),context);
 const sender={id:'test',tab:{id:7},frameId:0,url:URL_LAW};
 const message={type:'egov-normal-response-cache',page:'p',build:'build',action:'put',request:{method:'GET',url:ORIGIN+'/data/Act/'+LAW+'/637374_1/'+LAW+'_20260624_508AC0000000045_law.html',body:'',headers:[]},
  value:{text:'<section class="Article" id="Mp-At_1">本文</section>',contentType:'text/html'}};
 const call=(message,from=sender)=>new Promise(resolve=>{for(const fn of listeners)if(fn(message,from,resolve)===true)return;resolve(null);});
 return {context,helper:context.EgovNormalCacheFallback,stores,opened,events,updates,message,call,session,textReads:()=>textReads,tab:value=>{tabUrl=value;},sender};
}
test('normal HTML is found by law/view without Lite data or network, even when expired',async()=>{
 const s=setup();await s.call({...s.message,value:{...s.message.value,downloadedAt:Date.now()-1000}});
 const record=await s.helper.read(URL_LAW);assert.equal(record.kind,'html');assert.equal(record.lawId,LAW);
 assert.ok(s.opened.every(name=>name==='egov-normal-responses-v1'));
 assert.equal(await s.helper.read(URL_LAW+'?occasion_date=20200101'),null);
});
test('offline lookup reads one newest valid body instead of decoding all old snapshots',async()=>{
 const s=setup();await s.call(s.message);
 const data=s.stores.get('egov-normal-responses-v1'),saved=[...data.values()][0];
 for(let i=1;i<=20;i++){
   const headers=new Headers(saved.headers);headers.set('x-saved',String(Date.now()-i*10000));
   data.set('https://laws.e-gov.go.jp/older-'+i,new Response('older',{headers}));
 }
 const before=s.textReads();assert.ok(await s.helper.read(URL_LAW));
 assert.equal(s.textReads()-before,1);
});
test('mixed law IDs, dated views, corrupt bytes and partial text are never substituted',async()=>{
 const s=setup();await s.call(s.message);
 assert.equal(await s.helper.read(ORIGIN+'/law/405AC0000000088'),null);
 const partial=s.helper.binding(URL_LAW,{method:'POST',url:ORIGIN+'/internal-api/SelectLawTextData.json',body:JSON.stringify({law_id:LAW,selTextList:['#Mp-At_1']})});
 assert.deepEqual(Object.keys(partial),[]);
 const data=s.stores.get('egov-normal-responses-v1'),key=[...data.keys()][0],saved=data.get(key);
 data.set(key,new Response('corrupt',{headers:saved.headers}));assert.equal(await s.helper.read(URL_LAW),null);
});
test('a warm legacy cache hit gains identity metadata without changing its saved date',async()=>{
 const s=setup();await s.call(s.message);const data=s.stores.get('egov-normal-responses-v1'),key=[...data.keys()][0],old=data.get(key),headers=new Headers(old.headers);
 for(const name of [...headers.keys()])if(name.startsWith('x-normal-'))headers.delete(name);
 data.set(key,new Response(await old.text(),{headers}));
 assert.equal(await s.helper.read(URL_LAW),null);
 await s.call({...s.message,action:'get'});
 assert.ok(await s.helper.read(URL_LAW));assert.equal(data.get(key).headers.get('x-saved'),headers.get('x-saved'));
});
test('concentration and network errors switch only the failed tab; cancelled/unrelated/no-cache visits stay put',async()=>{
 const s=setup();await s.call(s.message);
 s.events.onBeforeNavigate({tabId:7,frameId:0,url:URL_LAW+'#Mp-At_1'});
 s.tab(ORIGIN+'/concentration');s.events.onCommitted({tabId:7,frameId:0,url:ORIGIN+'/concentration'});
 for(let i=0;i<100&&!s.updates.length;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(s.updates.length,1);const target=new URL(s.updates[0].url);
 assert.equal(target.searchParams.get('normalCache'),URL_LAW+'#Mp-At_1');assert.equal(target.hash,'#Mp-At_1');
 const cancelled=setup();await cancelled.call(cancelled.message);cancelled.events.onBeforeNavigate({tabId:7,frameId:0,url:URL_LAW});
 cancelled.events.onErrorOccurred({tabId:7,frameId:0,url:URL_LAW,error:'net::ERR_ABORTED'});
 await new Promise(r=>setTimeout(r,20));assert.equal(cancelled.updates.length,0);
 cancelled.tab(URL_LAW);cancelled.events.onErrorOccurred({tabId:7,frameId:0,url:URL_LAW,error:'net::ERR_INTERNET_DISCONNECTED'});
 for(let i=0;i<100&&!cancelled.updates.length;i++)await new Promise(r=>setTimeout(r,5));assert.equal(cancelled.updates.length,1);
});
test('viewer-only read messages and body failures use the normal cache with sender checks',async()=>{
 const s=setup();await s.call(s.message);
 assert.equal((await s.call({type:'egov-read-normal-offline',url:URL_LAW})).ok,false);
 const result=await s.call({type:'egov-read-normal-offline',url:URL_LAW},{id:'test',url:'chrome-extension://test/viewer.html?normalCache=x'});
 assert.equal(result.ok,true);
});
test('background reference preparation stops polling when the law body never appears',async()=>{
 let now=1000;const timers=[];class Clock extends Date{static now(){return now;}}
 const realm=vm.createContext({Date:Clock,URLSearchParams,referencePrepareTimer:0,referenceBody:null,
   label:{},location:{search:'',pathname:'/law/'+LAW},isBody:()=>true,ensureUI(){},lawId:()=>LAW,
   referenceView:()=>'/law/'+LAW,updates:{normalBodyRevision:()=> '1_1'},displayedRevision:'',
   chrome:{runtime:{sendMessage:async()=>({ok:true})}},EgovNormalLawContext:{get:()=>null},
   clearTimeout(){},setTimeout:fn=>{timers.push(fn);return timers.length;},scheduleRevisionBadge(){},scheduleUpdateCheck(){}});
 const source=read('shared/normal-response-cache-bridge.js'),start=source.indexOf('  function showDate('),end=source.indexOf("  if (document.readyState",start);
 vm.runInContext(source.slice(start,end),realm);realm.showDate({},1000,true);
 let turns=0;while(timers.length&&turns<200){now+=250;await timers.shift()();turns++;}
 assert.equal(timers.length,0);assert.ok(turns<=121);assert.ok(now>=31000);
});
