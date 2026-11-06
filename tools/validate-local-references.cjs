const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
const rules=read('data/court-rules/catalog.json').rules;
const byId=new Map(rules.map(r=>[r.id,r]));
const data=read('data/local-references/references.json');
const report=read('data/local-references/build-report.json');
assert.equal(report.documents.length,rules.length);
assert.deepEqual(new Set(report.documents.map(x=>x.id)),new Set(byId.keys()));
let count=0;
for(const [target,provisions] of Object.entries(data))for(const [key,entry]of Object.entries(provisions)){
  assert.match(key,/^(?:Sp(?:_\d+)?::)?\d+(?:-\d+)*(?:\.\d+(?:-\d+)*){0,2}$/);
  assert.deepEqual(Object.keys(entry),['externalLawSources']);
  const seen=new Set();
  for(const source of entry.externalLawSources){
    assert.deepEqual(Object.keys(source).sort(),['sourceLawId','sourceLawTitle','sourceUrl']);
    const rule=byId.get(source.sourceLawId);assert.ok(rule);
    assert.notEqual(target,source.sourceLawId);assert.equal(source.sourceLawTitle,rule.title);
    const url=new URL(source.sourceUrl,'https://extension.invalid/');
    assert.equal(url.pathname,'/viewer.html');assert.equal(url.searchParams.get('localRule'),rule.slug);assert.ok(url.hash);
    assert.ok(!seen.has(source.sourceUrl));seen.add(source.sourceUrl);count++;
  }
}
assert.equal(count,report.stats.references);
for(const key of ['2.3','2.9','2.9.2','2.9.3','2.9.4'])
  assert.ok(data['322AC0000000054'][key].externalLawSources.some(x=>x.sourceLawId==='LOCALDOC80320A680A7A'));
console.log('Validated:',JSON.stringify(report.stats));
