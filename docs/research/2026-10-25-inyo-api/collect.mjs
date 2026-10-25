// Read-only API probe. Run explicitly with network access; requests are sequential.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out = fileURLToPath(new URL('.', import.meta.url));
const date = '2026-10-25';
const laws = [['322AC0000000054','独占禁止法'],['129AC0000000089','民法'],['321CONSTITUTION','日本国憲法']];
const records = [];
async function post(endpoint, body, file) {
  const start = performance.now();
  const response = await fetch(`https://laws.e-gov.go.jp/internal-api/${endpoint}.json`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(60000)
  });
  const headersMs = performance.now()-start;
  const text = await response.text();
  const totalMs = performance.now()-start;
  const parsed = JSON.parse(text);
  if (!response.ok || !parsed.result?.success) throw new Error(`${endpoint}: ${text.slice(0,500)}`);
  await fs.writeFile(out+file, text);
  const metrics = {endpoint,headersMs,totalMs,decodedBytes:Buffer.byteLength(text),contentLength:response.headers.get('content-length'),contentEncoding:response.headers.get('content-encoding')};
  console.log(JSON.stringify(metrics));
  await new Promise(resolve=>setTimeout(resolve,1000));
  return {data:parsed.result,metrics};
}
for (const [lawId,name] of laws) {
  try {
    const history=await post('SelectLawRevisionData',{law_id:lawId},`${lawId}-history.json`);
    const current=history.data.Amendment_History.find(x=>x.IsCurrentEnforcement);
    if (!current) throw new Error('No current revision');
    const params={law_data_id:current.LawDataId,subRevision:current.SubRevision};
    const toc=await post('SelectLawTocData',params,`${lawId}-toc.json`);
    const ids=[];
    function walk(o){if(!o||typeof o!=='object')return;if(o['-ObjectId'])ids.push(o['-ObjectId'].replace(/^#/,''));for(const v of Object.values(o))walk(v);}
    walk(toc.data.Toc_Data.TocBody);
    const samples=[];
    for(let i=0;i<3;i++){
      const res=await post('SelectInyoLawData',{...params,occasion:date,selTextList:ids},`${lawId}-inyo.json`);
      samples.push(res.metrics);
    }
    records.push({lawId,name,date,params,ids:ids.length,uniqueIds:new Set(ids).size,history:history.metrics,toc:toc.metrics,samples});
  } catch(error){records.push({lawId,name,error:String(error)});}
  await fs.writeFile(out+'network-results.json',JSON.stringify({measuredAt:new Date().toISOString(),node:process.version,records},null,2));
}
