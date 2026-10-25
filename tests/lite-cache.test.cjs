const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const LAW = '417AC0000000086';

function setup() {
  let now = Date.now(), frequency = 'daily', capacity = 1, network = 0, fail = false, broken = false, listener;
  const stores = new Map();
  const keyOf = key => typeof key === 'string' ? key : key.url;
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
    open: async name => {
      if (broken) throw Error('storage unavailable');
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        keys: async () => [...entries.keys()].map(key => new Request(key)),
        match: async key => entries.get(keyOf(key))?.clone(),
        put: async (key, response) => entries.set(keyOf(key), response.clone()),
        delete: async key => entries.delete(keyOf(key)),
      };
    },
  };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    URL, TextEncoder, Response, Headers, Date: Clock, crypto: webcrypto, caches,
    AbortController, setTimeout, clearTimeout,
    chrome: { storage: { local: {
      get: async () => ({ normalResponseCacheFrequency: frequency, normalResponseCacheCapacityMiB: capacity }),
      set: async () => {},
    } }, runtime: { id: 'extension', getManifest: () => ({ version: '2.6.2' }),
      onMessage: { addListener: fn => { listener = fn; } } } },
    EGOV_API_V2_BASE: 'https://laws.e-gov.go.jp/api/2', liteLawLoadPromises: new Map(),
    fetch: async url => {
      network++;
      if (fail) throw Error('offline');
      return new Response(url.includes('/law_revisions/')
        ? JSON.stringify({ revisions: [{ law_revision_id: 'revision', current_revision_status: 'CurrentEnforced' }] })
        : '<Law>本文</Law>');
    },
  });
  vm.runInContext(read('shared/egov-shared.js'), context);
  vm.runInContext(`const { cacheLiteLawXml, readCachedLiteLaw, getLiteLawDataUrl,
    findCurrentLawRevisionId, getJapanDateString } = EgovShared;`, context);
  const source = read('background.js');
  vm.runInContext(source.slice(source.indexOf('async function fetchLiteLawResponse('),
    source.indexOf('async function clearReferencesCache(')), context);
  vm.runInContext(read('shared/normal-response-cache-background.js'), context);
  const shared = context.EgovShared;
  const normalMessage = { type: 'egov-normal-response-cache', action: 'put', page: 'page', build: 'build',
    request: { method: 'POST', url: 'https://laws.e-gov.go.jp/internal-api/SelectLawRevisionData.json',
      body: JSON.stringify({ law_id: LAW }), headers: [] },
    value: { text: JSON.stringify({ result: { success: true, data: 'x'.repeat(400000) } }), contentType: 'application/json' } };
  const sender = { id: 'extension', tab: { id: 1 }, frameId: 0, url: `https://laws.e-gov.go.jp/law/${LAW}` };
  return { shared, stores, caches, context,
    load: (revision = '', force = false) => context.loadAndCacheLiteLaw(LAW, revision, force),
    normal: changes => new Promise(resolve => listener({ ...normalMessage, ...changes }, sender, resolve)),
    advance: ms => { now += ms; }, network: () => network, now: () => now,
    frequency: value => { frequency = value; }, capacity: value => { capacity = value; },
    fail: () => { fail = true; }, broken: () => { broken = true; },
  };
}

test('Lite cache hits skip both revision history and XML downloads; download time stays fixed', async () => {
  const s = setup();
  const first = await s.load();
  assert.equal(s.network(), 2);
  s.advance(1000);
  const second = await s.load();
  assert.equal(s.network(), 2);
  assert.equal(second.downloadedAt, first.downloadedAt);
  assert.equal(second.currentRevisionId, 'revision');
  assert.equal(second.revisions.length, 1);
  assert.equal(second.fromCache, true);
});

test('Lite daily, weekly and monthly expire exactly at the selected interval', async () => {
  for (const [frequency, days] of [['daily', 1], ['weekly', 7], ['monthly', 30]]) {
    const s = setup(); s.frequency(frequency);
    const first = await s.load();
    s.advance(days * 86400000 - 1);
    assert.equal((await s.load()).downloadedAt, first.downloadedAt);
    assert.equal(s.network(), 2);
    s.advance(1);
    assert.ok((await s.load()).downloadedAt > first.downloadedAt);
    assert.equal(s.network(), 4);
  }
});

test('manual keeps old data, explicit revision keys are separate, force refresh replaces download time', async () => {
  const s = setup(); s.frequency('manual');
  const first = await s.load();
  s.advance(365 * 86400000);
  assert.equal((await s.load()).downloadedAt, first.downloadedAt);
  await s.load('old');
  assert.equal(s.network(), 4);
  const fresh = await s.load('', true);
  assert.equal(s.network(), 6);
  assert.equal(fresh.downloadedAt, s.now());
  assert.equal((await s.load()).downloadedAt, fresh.downloadedAt);
});

test('always downloads without saving, and storage failures still return displayable XML', async () => {
  const s = setup(); s.frequency('always');
  assert.match((await s.load()).xmlText, /本文/);
  await s.load();
  assert.equal(s.network(), 4);
  assert.equal(s.stores.size, 0);
  const broken = setup(); broken.broken();
  assert.match((await broken.load()).xmlText, /本文/);
});

test('failed force refresh preserves the previous saved law and its date', async () => {
  const s = setup(); s.frequency('manual');
  const saved = await s.load();
  s.fail();
  await assert.rejects(s.load('', true), /offline/);
  assert.equal((await s.load()).downloadedAt, saved.downloadedAt);
});

test('normal and Lite share one budget and evict the least recently accessed across modes', async () => {
  const s = setup(); s.frequency('manual');
  const xml = '<Law>' + 'x'.repeat(400000) + '</Law>';
  await s.shared.cacheLiteLawXml('A', xml);
  s.advance(10);
  await s.normal();
  s.advance(10);
  await s.shared.readCachedLiteLaw('A'); // A is now newer than the normal entry.
  s.advance(10);
  await s.shared.cacheLiteLawXml('B', xml);
  assert.ok(await s.shared.readCachedLiteLaw('A'));
  assert.ok(await s.shared.readCachedLiteLaw('B'));
  assert.equal(await s.normal({ action: 'get' }), null);
  s.advance(10);
  await s.normal(); // A is older than B after the checks above.
  assert.equal(await s.shared.readCachedLiteLaw('A'), null);
  assert.ok(await s.shared.readCachedLiteLaw('B'));
  assert.ok(await s.normal({ action: 'get' }));
});

test('replacement is not double counted, oversized XML is not stored, corrupt records are not reused', async () => {
  const s = setup(); s.frequency('manual');
  const xml = '<Law>' + 'x'.repeat(600000) + '</Law>';
  await s.shared.cacheLiteLawXml('A', xml);
  await s.shared.cacheLiteLawXml('A', xml);
  assert.ok(await s.shared.readCachedLiteLaw('A'));
  await s.shared.cacheLiteLawXml('B', 'x'.repeat(1100000));
  assert.equal(await s.shared.readCachedLiteLaw('B'), null);
  assert.ok(await s.shared.readCachedLiteLaw('A'));
  const cache = await s.caches.open('egov-lite-law-xml-v4');
  const key = s.shared.getLiteLawDataUrl('A');
  const response = await cache.match(key);
  await cache.put(key, new Response('{"xmlText":"corrupted"}', { headers: response.headers }));
  assert.equal(await s.shared.readCachedLiteLaw('A'), null);
});

test('mixed concurrent writes and a reduced limit stay within the shared budget', async () => {
  const s = setup(); s.frequency('manual'); s.capacity(2);
  const xml = '<Law>' + 'x'.repeat(600000) + '</Law>';
  await Promise.all([s.shared.cacheLiteLawXml('A', xml), s.shared.cacheLiteLawXml('B', xml), s.normal()]);
  assert.ok(await s.shared.readCachedLiteLaw('A'));
  assert.ok(await s.shared.readCachedLiteLaw('B'));
  s.capacity(1);
  await Promise.all([s.shared.cacheLiteLawXml('C', xml), s.normal()]);
  let bytes = 0;
  for (const entries of s.stores.values()) {
    for (const response of entries.values()) bytes += Number(response.headers.get('x-bytes'));
  }
  assert.ok(bytes <= 1024 * 1024);
  assert.ok(await s.normal({ action: 'get' }));
});
