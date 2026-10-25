// Native Storage API probe in a fresh, isolated test profile, never the user's profile.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../..');
async function main() {
  const directory = fs.mkdtempSync(path.join(root, 'tmp', 'normal-cache-storage-'));
  const extension = path.join(directory, 'extension');
  fs.mkdirSync(extension);
  const key = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8').replace(/^\uFEFF/, '')).key;
  const id = crypto.createHash('sha256').update(Buffer.from(key,'base64')).digest('hex').slice(0,32)
    .replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
  fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,
    name:'Temporary local cache experiment',version:'0.0.1',key,permissions:['storage'],
    background:{service_worker:'worker.js'}}));
  fs.writeFileSync(path.join(extension,'worker.js'),"chrome.runtime.onMessage.addListener((m,s,reply)=>{if(m.type==='put'){chrome.storage.local.set({[m.key]:m.value}).then(()=>reply({ok:true}));return true;}});");
  fs.writeFileSync(path.join(extension,'test.html'),'<!doctype html><meta charset="utf-8"><title>Isolated storage test</title>');
  let context;
  let result={available:false,browser:null,environment:'Fresh local test profile; no user data or existing extensions.',samples:[]};
  try {
    context=await chromium.launchPersistentContext(path.join(directory,'profile'),{
      channel:'chrome',headless:true,
      args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
    });
    const page=await context.newPage();
    await page.goto(`chrome-extension://${id}/test.html`,{timeout:10000});
    const available=await page.evaluate(()=>!!chrome.storage?.local);
    if(!available)throw new Error('Native storage is unavailable in this Chrome test extension.');
    const source=JSON.parse(fs.readFileSync(path.join(__dirname,'normal-cache-experiment-results.json'),'utf8'));
    const shapes=source.benchmarks.filter(b=>!b.modern).flatMap(b=>b.results.map(k=>({
      count:b.count,dense:b.dense,kind:k.kind,bytes:k.samples.find(s=>s.mode==='hit').recordBytes,
    })));
    const samples=await page.evaluate(async shapes=>{
      const rows=[];
      for(const shape of shapes){
        const key='normalAnalysis:probe';
        // Comparable byte volume, not the exact experiment record's object structure.
        const value={data:'あ'.repeat(Math.max(1,Math.floor((shape.bytes-100)/3)))};
        const timings=[];
        for(let i=-2;i<20;i++){
          const p=performance.now();await chrome.runtime.sendMessage({type:'put',key,value});const w=performance.now();
          const read=await chrome.storage.local.get(key);const end=performance.now();
          if(read[key].data!==value.data)throw new Error('Native storage round trip mismatch');
          if(i>=0)timings.push({writeViaWorkerMs:w-p,readDirectMs:end-w});
        }
        rows.push({...shape,actualBytes:await chrome.storage.local.getBytesInUse(key),timings});
      }
      await chrome.storage.local.remove('normalAnalysis:probe');
      return rows;
    },shapes);
    result={...result,available:true,samples,
      method:'Native chrome.storage.local read and service-worker message write; byte-matched string payloads, not exact records. 2 warmups + 20 measurements.'};
  } catch(error){result={...result,error:error.message};}
  finally{await context?.close();}
  fs.writeFileSync(path.join(__dirname,'native-storage-experiment-results.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({available:result.available,error:result.error,samples:result.samples.length}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
