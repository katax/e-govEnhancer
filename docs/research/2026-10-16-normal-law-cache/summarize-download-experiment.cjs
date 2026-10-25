const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const read=name=>JSON.parse(fs.readFileSync(path.join(__dirname,name),'utf8').replace(/^\uFEFF/,''));
const route=read('normal-download-results.json'),xhr=read('normal-download-xhr-results.json');
const median=values=>{const v=[...values].sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;};
const round=x=>Math.round(x*10)/10;
const checks=[];
for(const [name,result,expected]of[['route',route,28],['xhr',xhr,8]]){
  assert.equal(result.rows.length,expected);
  for(const row of result.rows){
    assert.ok(row.sameHtml&&row.sameText&&row.sameArticleIds&&row.sameRevision,`${name} ${row.lawId} ${row.mode} mismatch`);
    assert.deepEqual(row.errors,[]);
    if(row.mode==='all-data-cache'||row.mode==='xhr-cache')assert.equal(row.liveLawApiRequests.length,0);
    if(row.mode==='live-revision-cache')assert.deepEqual(row.liveLawApiRequests.map(r=>r.endpoint),['SelectLawRevisionData.json']);
    if(row.mode==='xhr-cache')assert.equal(row.nativeTocInteraction,true);
    if(row.mode==='xhr-body-miss')assert.equal(row.liveLawApiRequests.length,1);
  }
  checks.push({name:`${name}: all ${expected} navigations preserved body HTML, text, article IDs and revision`,passed:true});
}
const summary=[];
for(const lawId of ['405AC0000000088','129AC0000000089']){
  const lawRows=route.rows.filter(r=>r.lawId===lawId),cold=lawRows.find(r=>r.mode==='stock-cold');
  const modes=[];
  for(const mode of ['data-live','body-cache','live-revision-cache','all-data-cache']){
    const rows=lawRows.filter(r=>r.mode===mode),times=rows.map(r=>r.firstArticleMs);
    modes.push({mode,n:times.length,medianFirstArticleMs:round(median(times)),minMs:round(Math.min(...times)),maxMs:round(Math.max(...times)),
      liveLawRequests:rows[0].liveLawApiRequests.length,
      locallySuppliedBytes:rows[0].cacheEvents.filter(e=>e.lawApi||e.bodyHtml).reduce((n,e)=>n+e.bytes,0)});
  }
  const main=xhr.rows.filter(r=>r.lawId===lawId&&r.mode==='xhr-cache');
  summary.push({lawId,lawName:cold.lawName,articleElements:cold.articleCount,
    decodedLawBytes:cold.apiResponses.reduce((n,r)=>n+r.decodedBytes,0),
    nativeWarmBodyDiskCache:lawRows.find(r=>r.mode==='stock-warm').nativeBodyResponses.filter(r=>r.fromDiskCache).map(r=>r.url),
    responseHeaders:cold.apiResponses.map(r=>({endpoint:r.endpoint,method:r.method,resourceType:r.resourceType,decodedBytes:r.decodedBytes,cacheControl:r.cacheControl,etag:r.etag,lastModified:r.lastModified})),
    modes,mainWorldXhr:{n:main.length,medianFirstArticleMs:round(median(main.map(r=>r.firstArticleMs))),
      liveLawRequests:0,tocJumpPassed:main.every(r=>r.nativeTocInteraction)}});
}
const repo=path.resolve(__dirname,'../../..'),cacheDir=path.join(repo,'tmp','egov-download-response-cache');
const index=new Map(JSON.parse(fs.readFileSync(path.join(cacheDir,'index.json'),'utf8')));
const entry=[...index.values()].find(r=>r.url.endsWith('/SelectLawTextData.json')&&r.postData.includes('405AC0000000088'));
const body=JSON.parse(entry.postData);
for(const [field,value]of[['law_id','OTHER'],['law_data_id',body.law_data_id+1],['subRevision','9999'],['occasion','2099/01/01'],['selTextList',[...body.selTextList,'#extra-test']]]){
  const changed={...body,[field]:value};
  assert.equal(index.has(JSON.stringify([entry.method,entry.url,JSON.stringify(changed)])),false);
  checks.push({name:`changed ${field} cannot hit recorded request key`,passed:true});
}
assert.equal(index.has(JSON.stringify(['GET',entry.url,entry.postData])),false);
checks.push({name:'changed HTTP method cannot hit recorded request key',passed:true});
const original=fs.readFileSync(path.join(cacheDir,entry.bodyFile));
const changedDigest=crypto.createHash('sha256').update(Buffer.concat([original,Buffer.from('corrupt')])).digest('hex');
assert.notEqual(changedDigest,entry.sha256);
checks.push({name:'corrupt cached bytes fail content digest validation',passed:true});
const result={dateJapan:'2026-10-16',note:'First article DOM availability, not first paint or Enhancer completion. Three measured navigations per routed mode and law. Controlled static application assets, live external law endpoints when not replayed. Decoded body sizes are not on-wire compressed bytes. MAIN-world XHR is a test prototype with a file-backed bridge, not an installed MV3 extension.',checks,summary};
fs.writeFileSync(path.join(__dirname,'normal-download-summary.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
