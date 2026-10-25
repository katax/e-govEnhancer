const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../shared/normal-response-cache-background.js'), 'utf8');
const LAW = '405AC0000000088';
const ORIGIN = 'https://laws.e-gov.go.jp';

function setup() {
  let listener, time = Date.now(), checks = 0, broken = false, capacity, frequency;
  const entries = new Map();
  const keyOf = key => typeof key === 'string' ? key : key.url;
  const cache = {
    match: async key => entries.get(keyOf(key))?.clone(),
    put: async (key, response) => { if (broken) throw new Error('quota'); entries.set(keyOf(key), response.clone()); },
    keys: async () => [...entries.keys()].map(key => new Request(key)), delete: async key => entries.delete(keyOf(key)),
  };
  class Clock extends Date { static now() { return time; } }
  const context = vm.createContext({
    URL, TextEncoder, Response, Headers, crypto: webcrypto, AbortController, setTimeout, clearTimeout, Date: Clock,
    chrome: { storage: { local: { get: async () => ({ normalResponseCacheCapacityMiB: capacity, normalResponseCacheFrequency: frequency }) } },
      runtime: { id: 'extension', getManifest: () => ({ version: '2.6.2' }),
      onMessage: { addListener: fn => { listener = fn; } } } },
    caches: { open: async () => cache },
    fetch: async () => { checks++; throw new Error('Unexpected network access'); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/egov-shared.js'), 'utf8'), context);
  vm.runInContext(source, context);
  const sender = { id: 'extension', tab: { id: 1 }, frameId: 0, documentId: 'doc', url: `${ORIGIN}/law/${LAW}` };
  const message = { type: 'egov-normal-response-cache', action: 'get', page: 'page', build: 'app-build',
    request: { method: 'POST', url: `${ORIGIN}/internal-api/SelectLawRevisionData.json`,
      body: JSON.stringify({ law_id: LAW }), headers: [] } };
  const call = (changes = {}, from = sender) => new Promise(resolve => listener({ ...message, ...changes }, from, resolve));
  const value = { text: JSON.stringify({ result: { success: true, Amendment_History: [] } }), contentType: 'application/json' };
  return { call, message, value, entries, sender, checks: () => checks,
    capacity: value => { capacity = value; },
    frequency: value => { frequency = value; }, now: () => time,
    advance: ms => { time += ms; }, quota: () => { broken = true; } };
}

test('stores and returns exact public responses without background downloads', async () => {
  const s = setup();
  assert.deepEqual(await Promise.all([s.call(), s.call()]), [null, null]);
  assert.equal(s.checks(), 0);
  await s.call({ action: 'put', value: s.value });
  assert.equal((await s.call()).text, s.value.text);
  assert.equal(s.entries.size, 1);
});

test('download time is preserved even if persistence finishes in a later second', async () => {
  const s=setup();
  const downloadedAt=s.now()-1500;
  await s.call({action:'put',value:{...s.value,downloadedAt}});
  s.advance(2000);
  assert.equal((await s.call()).downloadedAt,downloadedAt);
});

test('daily, weekly and monthly expire at 1, 7 and 30 elapsed days', async () => {
  for (const [frequency, days] of [['daily', 1], ['weekly', 7], ['monthly', 30], ['unknown', 1]]) {
    const s = setup();
    s.frequency(frequency);
    await s.call({ action: 'put', value: s.value });
    const saved = (await s.call()).downloadedAt;
    s.advance(days * 86400000 - 1);
    assert.equal((await s.call()).downloadedAt, saved);
    s.advance(1);
    assert.equal((await s.call()).bypass, true);
  }
});

test('manual retains old responses, always bypasses storage, and force refresh does not delete good data', async () => {
  const s = setup();
  s.frequency('manual');
  await s.call({ action: 'put', value: s.value });
  s.advance(365 * 86400000);
  assert.equal((await s.call()).text, s.value.text);
  assert.equal((await s.call({force:true})).bypass, true);
  assert.ok(await s.call());
  s.frequency('always');
  assert.equal((await s.call()).bypass, true);
  await s.call({action:'put', build:'not-stored', value:s.value});
  assert.equal(s.entries.size, 1);
  assert.equal(s.checks(), 0);
});

test('current text requests survive a day change; dated views remain separate', async () => {
  const s = setup();
  s.frequency('manual');
  const body = date => JSON.stringify({law_id:LAW, law_data_id:1, occasion:date});
  const day = () => new Date(s.now() + 9 * 3600000).toISOString().slice(0,10).replaceAll('-', '/');
  const request = {...s.message.request, url:ORIGIN+'/internal-api/SelectLawTextData.json', body:body(day())};
  await s.call({action:'put', request, value:s.value});
  s.advance(86400000);
  assert.equal((await s.call({request:{...request,body:body(day())}})).text, s.value.text);
  assert.equal(await s.call({request:{...request,body:body(day())}}, {...s.sender,url:s.sender.url+'?occasion_date=20261024'}), null);
});

test('app build, request body, headers and URL are distinct cache identities', async () => {
  const s = setup();
  await s.call({ action: 'put', value: s.value });
  for (const changes of [
    { build: 'new-app' },
    { request: { ...s.message.request, body: JSON.stringify({ law_id: LAW, occasion: '2026/10/17' }) } },
    { request: { ...s.message.request, headers: [['accept', 'application/json']] } },
    { request: { ...s.message.request, url: `${ORIGIN}/internal-api/SelectLawData.json` } },
  ]) assert.equal(await s.call(changes), null);
});

test('rejects untrusted senders, frames, non-law pages and unsupported requests before network', async () => {
  const s = setup();
  for (const sender of [{ ...s.sender, id: 'other' }, { ...s.sender, frameId: 1 },
    { ...s.sender, url: 'https://example.org/law/' + LAW }, { ...s.sender, url: ORIGIN + '/search' }]) {
    assert.equal(await s.call({}, sender), null);
  }
  for (const request of [
    { ...s.message.request, url: 'https://example.org/internal-api/SelectLawRevisionData.json' },
    { ...s.message.request, method: 'DELETE' },
    { ...s.message.request, url: ORIGIN + '/internal-api/SaveUserData.json' },
    { ...s.message.request, body: '{broken' },
    { ...s.message.request, body: JSON.stringify({ law_id: '129AC0000000089' }) },
    { ...s.message.request, headers: [['authorization', 'secret']] },
  ]) assert.equal(await s.call({ request }), null);
  assert.equal(s.checks(), 0);
});

test('corrupt bytes are deleted; server errors and quota failures stay recoverable', async () => {
  const s = setup();
  await s.call({ action: 'put', value: s.value });
  const [key, response] = [...s.entries][0];
  s.entries.set(key, new Response('corrupt', { headers: response.headers }));
  assert.equal(await s.call(), null);
  assert.equal(s.entries.size, 0);
  await s.call({ action: 'put', value: { ...s.value, text: '{broken' } });
  await s.call({ action: 'put', value: { ...s.value, text: '{"result":{"success":false}}' } });
  assert.equal(s.entries.size, 0);
  s.quota();
  assert.equal(await s.call({ action: 'put', value: s.value }), null);
});

test('static law HTML is limited to the same law and revision-shaped paths', async () => {
  const s = setup();
  const request = { method: 'GET', body: '', headers: [],
    url: `${ORIGIN}/data/Act/${LAW}/641200_1/${LAW}_20260724_508AC0000000066_law.html` };
  const value = { text: '<article>law</article>', contentType: 'text/html; charset=utf-8' };
  await s.call({ action: 'put', request, value });
  assert.equal((await s.call({ request })).text, value.text);
  assert.equal(await s.call({ request: { ...request, url: request.url.replaceAll(LAW, '129AC0000000089') } }), null);
});

test('capacity replaces the old fixed entry limit', async () => {
  const s = setup();
  for (let index = 0; index < 201; index++) {
    s.advance(1);
    await s.call({ action: 'put', build: `build-${index}`, value: s.value });
  }
  assert.equal(s.entries.size, 201);
  assert.ok(await s.call({ build: 'build-0' }));
  assert.ok(await s.call({ build: 'build-200' }));
});

const sizedValue = bytes => {
  const base = { result: { success: true, data: '' } };
  base.result.data = 'x'.repeat(bytes - JSON.stringify(base).length);
  return { text: JSON.stringify(base), contentType: 'application/json' };
};

test('capacity pressure evicts least recently used, not earliest saved, before insertion', async () => {
  const s = setup();
  s.capacity(1);
  const value = sizedValue(400000);
  await s.call({ action: 'put', build: 'A', value });
  s.advance(1);
  await s.call({ action: 'put', build: 'B', value });
  s.advance(1);
  assert.ok(await s.call({ build: 'A' }));
  s.advance(1);
  await s.call({ action: 'put', build: 'C', value });
  assert.ok(await s.call({ build: 'A' }));
  assert.equal(await s.call({ build: 'B' }), null);
  assert.ok(await s.call({ build: 'C' }));
  assert.equal(s.entries.size, 2);
});

test('lowered capacity, replacements and concurrent writes stay within the byte budget', async () => {
  const s = setup();
  s.capacity(4);
  const value = sizedValue(600000);
  await s.call({ action: 'put', build: 'A', value });
  s.advance(1);
  await s.call({ action: 'put', build: 'B', value });
  s.capacity(1);
  await Promise.all(['C', 'D', 'E'].map(build => s.call({ action: 'put', build, value: sizedValue(200000) })));
  const bytes = [...s.entries.values()].reduce((sum, response) => sum + Number(response.headers.get('x-bytes')), 0);
  assert.ok(bytes <= 1024 * 1024);
  // Replacing the same key should not count its old bytes twice or delete another entry.
  const count = s.entries.size;
  await s.call({ action: 'put', build: 'E', value: sizedValue(200000) });
  assert.equal(s.entries.size, count);
});

test('oversized downloads are not stored and still apply a reduced capacity', async () => {
  const s = setup();
  s.capacity(4);
  await s.call({ action: 'put', build: 'A', value: sizedValue(600000) });
  s.advance(1);
  await s.call({ action: 'put', build: 'B', value: sizedValue(600000) });
  s.capacity(1);
  await s.call({ action: 'put', build: 'large', value: sizedValue(1100000) });
  assert.equal(await s.call({ build: 'large' }), null);
  assert.equal(await s.call({ build: 'A' }), null);
  assert.ok(await s.call({ build: 'B' }));
});

test('invalid settings use the default and legacy entries gain persistent access timestamps', async () => {
  const s = setup();
  for (const capacity of [undefined, '1', 0, -1, 1.5, 4097]) {
    s.capacity(capacity);
    await s.call({ action: 'put', value: sizedValue(1100000) });
    assert.ok(await s.call());
  }
  const [key, response] = [...s.entries][0];
  const headers = new Headers(response.headers);
  headers.delete('x-accessed');
  s.entries.set(key, new Response(await response.text(), { headers }));
  s.advance(100);
  assert.ok(await s.call());
  assert.ok(Number(s.entries.get(key).headers.get('x-accessed')) > Number(headers.get('x-saved')));
});
