const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const lawId = '322AC0000000054';
function setup({ frequency = 'daily', quota = false, fail = false } = {}) {
  let now = Date.UTC(2026, 9, 30), calls = [], failure = fail;
  const entries = new Map(), stores = [];
  const cache = { delete: async key => entries.delete(key), match: async key => entries.get(key)?.clone(), put: async (key, value) => {
    if (quota) throw Error('quota'); entries.set(key, value.clone());
  } };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ URL, Response, Date: Clock, AbortSignal, setTimeout, clearTimeout,
    caches: { open: async name => { stores.push(name); return cache; } },
    chrome: { storage: { local: { get: async () => ({ normalResponseCacheFrequency: frequency }) } } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (failure) return new Response('<html>Error</html>');
      let result;
      if (url.includes('SelectLawRevisionData')) result = { success: true, Amendment_History: [
        { LawDataId: 2, SubRevision: '1', EnforcementDate: '2027-01-01', AmendmentId: '505AC0000000063' },
        { LawDataId: 610982, SubRevision: '4', EnforcementDate: '2026-05-21', EnforcementEndDate: '2026-12-31', AmendmentId: '505AC0000000063' },
      ] };
      else if (url.includes('SelectLawTocData')) result = { success: true, Toc_Data: { TocBody: [{ '-ObjectId': '#Mp-Ch_1-At_2' }] } };
      else result = { success: true, inyo_data: [{ selText: 'Mp-Ch_1-At_2', inyo_list: [{
        law_id: '327CO0000000373', law_name: '組織令', url: '/law/327CO0000000373/20260408_508CO0000000120/#Mp-At_16',
      }] }] };
      return new Response(JSON.stringify({ result }));
    },
  });
  vm.runInContext(read('shared/egov-shared.js'), context);
  vm.runInContext(read('shared/inyo-api-background.js'), context);
  const request = { lawId, mode: 'normal', view: `/law/${lawId}`, downloadedAt: now - 1000,
    normalRevision: '610982_4', occasion: '20261030', ids: ['Mp-Ch_1-At_2'] };
  return { api: context.EgovInyoApi, shared: context.EgovShared, context, request, calls, stores, entries, cache,
    advance: ms => now += ms, fail: value => failure = value };
}
test('loading the module makes no request; complete page metadata needs one batch request', async () => {
  const s = setup(); assert.equal(s.calls.length, 0);
  const result = await s.api.get(s.request);
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].url, /SelectInyoLawData/);
  assert.equal(s.calls[0].body.occasion, '2026-10-30');
  assert.equal(result['2'].externalLawSources.length, 1);
  assert.ok(s.stores.every(name => name === 'egov-inyo-api-v1'));
});
test('persistent cache and concurrent callers avoid all network calls on reuse', async () => {
  const s = setup();
  await Promise.all([s.api.get(s.request), s.api.get(s.request)]);
  await s.api.get(s.request);
  assert.equal(s.calls.length, 1);
});
test('reacquiring the same law and revision invalidates the old reverse references', async () => {
  const s = setup(); await s.api.get(s.request);
  s.advance(1000);
  await s.api.get({ ...s.request, downloadedAt: s.request.downloadedAt + 1000 });
  assert.equal(s.calls.length, 2); assert.equal(s.entries.size, 1);
});
test('reacquisition physically deletes the old cache before a failed prefetch, then retries on demand', async () => {
  const s = setup(); await s.api.get(s.request);
  assert.equal(s.entries.size,1);
  s.fail(true);
  await s.api.invalidate(s.request);
  assert.equal(s.entries.size,0);
  await assert.rejects(s.api.prepare(s.request), /JSON/);
  assert.equal(s.entries.size,0);
  s.fail(false);
  await s.api.get(s.request);
  assert.equal(s.entries.size,1);
});
test('OFF-state prefetch prepares data and an ON request shares the same network operation', async () => {
  const s = setup();
  await Promise.all([s.api.prepare(s.request),s.api.get(s.request)]);
  await s.api.get(s.request);
  assert.equal(s.calls.length,1);
});
test('invalidation during an in-flight prefetch prevents stale cache resurrection', async () => {
  const s=setup(); let release;
  const original=s.context.fetch;
  s.context.fetch=async(...args)=>{await new Promise(resolve=>{release=resolve;});return original(...args);};
  const old=s.api.prepare(s.request);
  while(!release) await new Promise(resolve=>setTimeout(resolve,0));
  await s.api.invalidate(s.request);
  release(); await old;
  assert.equal(s.entries.size,0);
});
test('TTL starts at law acquisition, not reverse-reference acquisition; all frequencies match', async () => {
  for (const [frequency, days] of [['daily', 1], ['weekly', 7], ['monthly', 30]]) {
    const s = setup({ frequency });
    s.advance(days * 86400000 - 2000);
    await s.api.get(s.request); await s.api.get(s.request);
    assert.equal(s.calls.length, 1);
    s.advance(2000); await s.api.get(s.request);
    assert.equal(s.calls.length, 2);
  }
  const manual = setup({ frequency: 'manual' });
  await manual.api.get(manual.request); manual.advance(365 * 86400000);
  await manual.api.get(manual.request); assert.equal(manual.calls.length, 1);
  const always = setup({ frequency: 'always' });
  await always.api.get(always.request); await always.api.get(always.request);
  assert.equal(always.calls.length, 2); assert.equal(always.entries.size, 0);
});
test('Lite resolves its displayed revision then batches all IDs, never selecting future history', async () => {
  const s = setup();
  const req = { ...s.request, mode: 'lite', normalRevision: undefined, ids: undefined,
    revisionId: `${lawId}_20260521_505AC0000000063` };
  await s.api.get(req);
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[2].body.law_data_id, 610982);
  assert.deepEqual(s.calls[2].body.selTextList, ['Mp-Ch_1-At_2']);
  await assert.rejects(s.api.get({ ...req, view: 'unknown', revisionId: `${lawId}_20260521_505AC0000000000` }), /改正版/);
});
test('HTML failures are not cached, never fall back to bundled JSON, and can be retried', async () => {
  const s = setup({ fail: true });
  await assert.rejects(s.api.get(s.request), /JSON/); assert.equal(s.entries.size, 0);
  s.fail(false); await s.api.get(s.request); assert.equal(s.calls.length, 2);
  assert.ok(s.calls.every(x => x.url.startsWith('https://laws.e-gov.go.jp/internal-api/')));
});
test('quota failure does not discard usable API data', async () => {
  const s = setup({ quota: true });
  assert.ok((await s.api.get(s.request))['2']);
});
test('prefetch completion waits for cache writing and reports unsaved results honestly', async () => {
  const s=setup();let release,complete=false;
  const put=s.cache.put;
  s.cache.put=async(...args)=>{await new Promise(resolve=>{release=resolve;});return put(...args);};
  const task=s.api.prepare(s.request).then(status=>{complete=true;return status;});
  while(!release) await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(complete,false);assert.equal(s.entries.size,0);
  release();assert.equal(await task,'saved');
  assert.equal(await s.api.prepare(s.request),'hit');
  const quota=setup({quota:true});assert.equal(await quota.api.prepare(quota.request),'not-saved');
});
test('normal and Lite views, historical views and body generations cannot mix results', async () => {
  const s = setup(); await s.api.get(s.request);
  await s.api.get({ ...s.request, view: '/historical', occasion: '2020-01-01' });
  await s.api.get({ ...s.request, mode: 'lite' });
  assert.equal(s.calls.length, 3);
});
test('real recorded API responses convert branches, paragraphs and supplements without duplicate sources', () => {
  const s = setup();
  const raw = JSON.parse(read('docs/research/2026-10-25-inyo-api/322AC0000000054-inyo.json')).result;
  const converted = s.api.convert(raw, lawId);
  assert.equal(Object.keys(converted).length, 49);
  // These entries contain only #Mp / #Sp links, not source provisions.
  for (const key of ['35', '47', '52', '76']) assert.equal(converted[key], undefined);
  for (const entry of Object.values(converted)) {
    const urls = entry.externalLawSources.map(x => x.sourceUrl);
    assert.equal(new Set(urls).size, urls.length);
    assert.ok(urls.every(url => s.shared.getReferenceTargetKeyFromEgovUrl(url)));
  }
});
test('frontend reports API errors rather than showing an empty success result', async () => {
  const s = setup();
  await assert.rejects(s.shared.getLawReferencesData(lawId, { sendMessage: async () => ({ ok: false, error: 'offline' }) }, s.request), /offline/);
});

test('API conversion excludes law-wide and heading-only sources while preserving provision links', () => {
  const s = setup();
  const sourceLawId = '327CO0000000373';
  const base = `/law/${sourceLawId}/20260408_508CO0000000120/`;
  const valid = ['#Mp-At_3', '#Mp-At_3-Pr_2-It_1', '#Sp-At_2'];
  const invalid = ['', '#', '#TOC', '#MainProvision', '#Mp-Ch_1', '#Sp', '#%ZZ'];
  const result = s.api.convert({ inyo_data: [{ selText: 'Mp-At_19', inyo_list:
    [...invalid, ...valid].map(hash => ({ law_id: sourceLawId, law_name: '施行令', url: base + hash }))
  }, { selText: 'Mp-At_20', inyo_list: [{ law_id: sourceLawId, url: base }] }] }, lawId);
  assert.deepEqual(Array.from(result['19'].externalLawSources, source => new URL(source.sourceUrl).hash), valid);
  assert.equal(result['20'], undefined);
});

test('existing API caches exclude sources without provisions without refetching in either mode', async () => {
  for (const mode of ['normal', 'lite']) {
    const s = setup();
    const request = { ...s.request, mode };
    const initial = await s.api.get(request);
    const [slot, response] = [...s.entries][0];
    const record = await response.clone().json();
    const lawOnly = { sourceLawId: '327CO0000000373', sourceLawTitle: '施行令',
      sourceUrl: 'https://laws.e-gov.go.jp/law/327CO0000000373/' };
    record.references['2'].externalLawSources.unshift(lawOnly);
    record.references['19'] = { externalLawSources: [lawOnly] };
    await s.cache.put(slot, new Response(JSON.stringify(record), { headers: response.headers }));
    const result = await s.api.get(request);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(initial)));
    assert.equal(s.calls.length, 1);
    assert.equal(await s.api.prepare(request), 'hit');
  }
});
