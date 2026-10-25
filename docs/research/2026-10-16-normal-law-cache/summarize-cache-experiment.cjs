const fs = require('node:fs');
const path = require('node:path');
const quantile = (values, p) => {
  const v = [...values].sort((a,b)=>a-b);
  return p===0.5 && v.length%2===0 ? (v[v.length/2-1]+v[v.length/2])/2 : v[Math.ceil(v.length*p)-1];
};
const round = n => Math.round(n*100)/100;
const rows=[];
for(const filename of ['normal-cache-experiment-results.json','normal-cache-observer-results.json']) {
  const result=JSON.parse(fs.readFileSync(path.join(__dirname,filename),'utf8'));
  for(const bench of result.benchmarks)for(const feature of bench.results) {
    const modes={};
    for(const mode of ['off','miss','hit']) {
      const samples=feature.samples.filter(s=>s.mode===mode);
      const field=feature.kind==='definitions'?'totalMs':'analysisMs';
      modes[mode]={analysisMedianMs:round(quantile(samples.map(s=>s.analysisMs),0.5)),
        medianMs:round(quantile(samples.map(s=>s[field]),0.5)),
        p95Ms:round(quantile(samples.map(s=>s[field]),0.95))};
    }
    const saved=modes.off.medianMs-modes.hit.medianMs;
    const penalty=modes.miss.medianMs-modes.off.medianMs;
    rows.push({guard:result.guard||'recapture',articles:bench.count,modern:bench.modern,
      definitions:bench.definitionCount,kind:feature.kind,
      metric:feature.kind==='definitions'?'analysis+definition DOM mutation':'reference analysis only',
      modes,readLatencyBudgetMs:round(saved),
      minimumHitFractionWithoutNativeIO:saved>0&&penalty>0?round(penalty/(penalty+saved)):null,
      recordBytes:feature.samples.find(s=>s.mode==='hit').recordBytes});
  }
}
const summary={note:'Synthetic fixed DOM, native browser algorithms and DOM operations. No native storage or real-site total-load timing. Read-latency budgets and hit-rate estimates are exploratory, not shipping criteria.',rows};
fs.writeFileSync(path.join(__dirname,'normal-cache-summary.json'),JSON.stringify(summary,null,2)+'\n');
for(const row of rows) console.log(JSON.stringify(row));
