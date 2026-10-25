// Node/V8 microbenchmark, not a Chrome end-to-end memory or latency measurement.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import '../../../shared/egov-shared.js';
const dir=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(dir,'../../..');
const shardDir=path.join(root,'data/reference-shards');
function shard(id){let h=2166136261;for(let i=0;i<id.length;i++)h=Math.imul(h^id.charCodeAt(i),16777619);return ((h>>>0)&255).toString(16).padStart(2,'0');}
function normalize(data,lawId){
  const result={},seen=new Map();let skipped=0;
  for(const entry of data.result.inyo_data){
    const key=globalThis.EgovShared.getReferenceTargetKeyFromEgovUrl(`https://laws.e-gov.go.jp/law/${lawId}#${entry.selText}`);
    if(!key){skipped+=entry.inyo_list.length;continue;}
    for(const row of entry.inyo_list){
      const identity=`${row.law_id}\n${row.url}`;
      if(!seen.has(key))seen.set(key,new Set());
      if(seen.get(key).has(identity))continue;
      seen.get(key).add(identity);
      (result[key]??={externalLawSources:[]}).externalLawSources.push({sourceLawId:row.law_id,sourceLawTitle:row.law_name,sourceUrl:new URL(row.url,'https://laws.e-gov.go.jp').href});
    }
  }
  return {result,skipped};
}
if(process.argv[2]==='worker'){
  const [mode,lawId]=process.argv.slice(3);
  const file= mode==='full'?path.join(root,'data/references.json'): mode==='shard'?path.join(shardDir,shard(lawId)+'.json'):path.join(dir,lawId+(mode==='toc'?'-toc.json':'-inyo.json'));
  global.gc();const base=process.memoryUsage().heapUsed;
  const start=performance.now();let raw=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');const readMs=performance.now()-start;
  const p=performance.now();let object=JSON.parse(raw);const parseMs=performance.now()-p;
  const parsedLiveHeapDelta=process.memoryUsage().heapUsed-base;
  global.gc();const parsedRetainedHeapDelta=process.memoryUsage().heapUsed-base;
  const c=performance.now();let retained,skipped=0;
  if(mode==='toc'){
    retained=[];function walk(o){if(!o||typeof o!=='object')return;if(o['-ObjectId'])retained.push(o['-ObjectId'].replace(/^#/,''));for(const v of Object.values(o))walk(v);}walk(object.result.Toc_Data.TocBody);
  }
  else if(mode==='api'){({result:retained,skipped}=normalize(object,lawId));}
  else retained=object[lawId]||{};
  const convertMs=performance.now()-c;
  const conversionLiveHeapDelta=process.memoryUsage().heapUsed-base;
  object=null;raw=null;global.gc();
  const lawRetainedHeapDelta=process.memoryUsage().heapUsed-base;
  const serial=JSON.stringify(retained);
  const t=performance.now();let clone=structuredClone(retained);const cloneMs=performance.now()-t;
  console.log(JSON.stringify({mode,lawId,bytes:fs.statSync(file).size,readMs,parseMs,convertMs,cloneMs,parsedLiveHeapDelta,parsedRetainedHeapDelta,conversionLiveHeapDelta,lawRetainedHeapDelta,lawJsonBytes:Buffer.byteLength(serial),targets:Object.keys(retained).length,sources:Object.values(retained).reduce((s,x)=>s+(x.externalLawSources?.length||0),0),skipped}));
}else{
  const net=JSON.parse(fs.readFileSync(path.join(dir,'network-results.json'),'utf8'));
  const cases=net.records.filter(x=>!x.error).flatMap(x=>[['shard',x.lawId],['api',x.lawId],['toc',x.lawId]]);
  cases.push(['full','322AC0000000054']);
  const measurements=[];
  for(const [mode,id] of cases){
    const samples=[];
    for(let i=0;i<7;i++){
      const child=spawnSync(process.execPath,['--expose-gc',fileURLToPath(import.meta.url),'worker',mode,id],{encoding:'utf8'});
      if(child.status!==0)throw new Error(child.stderr);
      samples.push(JSON.parse(child.stdout));
    }
    const medians={};
    for(const k of Object.keys(samples[0]))if(typeof samples[0][k]==='number')medians[k]=samples.map(s=>s[k]).sort((a,b)=>a-b)[3];
    measurements.push({mode,lawId:id,medians,samples});
    console.log(JSON.stringify({mode,lawId:id,...medians}));
  }
  const sizes=fs.readdirSync(shardDir).filter(x=>/^[0-9a-f]{2}\.json$/.test(x)).map(x=>({file:x,bytes:fs.statSync(path.join(shardDir,x)).size})).sort((a,b)=>a.bytes-b.bytes);
  fs.writeFileSync(path.join(dir,'benchmark-results.json'),JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,runs:7,sourceBytes:fs.statSync(path.join(root,'data/references.json')).size,shards:{totalBytes:sizes.reduce((s,x)=>s+x.bytes,0),min:sizes[0],median:sizes[128],p95:sizes[Math.ceil(sizes.length*.95)-1],max:sizes.at(-1)},measurements},null,2));
}
