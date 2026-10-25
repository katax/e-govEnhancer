const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function cacheEnvironment() {
  const stores = new Map(), settings = { normalResponseCacheFrequency: 'manual', normalResponseCacheCapacityMiB: 4 };
  let now = Date.now(), matches = 0, writes = 0, lock = Promise.resolve();
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const data = stores.get(name), keyOf = key => typeof key === 'string' ? key : key.url;
      return {
        keys: async () => [...data.keys()].map(url => ({ url })),
        match: async key => { matches++; return data.get(keyOf(key))?.clone(); },
        put: async (key, value) => { writes++; data.set(keyOf(key), value.clone()); },
        delete: async key => data.delete(keyOf(key)),
      };
    },
  };
  function context() {
    class Clock extends Date { static now() { return now; } }
    const realm = vm.createContext({
      Date: Clock, crypto: webcrypto, URL, TextEncoder, Response, Headers, caches,
      chrome: { storage: { local: { get: async () => ({ ...settings }), set: async values => Object.assign(settings, values) } } },
      navigator: { locks: { request: (_, task) => { const next = lock.then(task, task); lock = next.catch(() => {}); return next; } } },
    });
    vm.runInContext(read('shared/egov-shared.js'), realm);
    return realm.EgovShared;
  }
  return { context, caches, stores, settings, matches: () => matches, writes: () => writes, advance: ms => { now += ms; } };
}

test('repeated cache writes reuse metadata instead of reading every saved response', async () => {
  const env = cacheEnvironment(), shared = env.context();
  for (let i = 0; i < 100; i++) await shared.cacheLiteLawXml(`law-${i}`, '<Law>test</Law>');
  assert.equal(env.matches(), 0);
  const restarted = env.context();
  await restarted.cacheLiteLawXml('after-restart', '<Law>test</Law>');
  assert.equal(env.matches(), 100); // One reconstruction after restart.
  await restarted.cacheLiteLawXml('another', '<Law>test</Law>');
  assert.equal(env.matches(), 100);
});

test('warm reads avoid body writes within a minute and retain the download date', async () => {
  const env = cacheEnvironment(), shared = env.context();
  await shared.cacheLiteLawXml('law', '<Law>test</Law>');
  const original = await shared.readCachedLiteLaw('law');
  for (let i = 0; i < 20; i++) { env.advance(1000); await shared.readCachedLiteLaw('law'); }
  assert.equal(env.writes(), 1);
  env.advance(40000);
  assert.equal((await shared.readCachedLiteLaw('law')).downloadedAt, original.downloadedAt);
  assert.equal(env.writes(), 2);
});

test('another context replacing an existing key invalidates sizes before eviction', async () => {
  const env = cacheEnvironment(), worker = env.context(), viewer = env.context();
  await worker.cacheLiteLawXml('A', 'x'.repeat(100000));
  await worker.cacheLiteLawXml('B', 'x'.repeat(100000));
  env.advance(1);
  await viewer.cacheLiteLawXml('A', 'x'.repeat(800000));
  env.settings.normalResponseCacheCapacityMiB = 1;
  await worker.cacheLiteLawXml('C', 'x'.repeat(400000));
  const total = [...env.stores.values()].flatMap(entries => [...entries.values()])
    .reduce((sum, response) => sum + Number(response.headers.get('x-bytes')), 0);
  assert.ok(total <= 1024 * 1024);
  assert.ok(await worker.readCachedLiteLaw('C'));
});

test('search shares an in-flight query and rejects stale results even if transport ignores abort', async () => {
  const calls = [];
  const realm = vm.createContext({ AbortController, setTimeout, clearTimeout,
    fetch: (url, options) => new Promise(resolve => calls.push({ url, options, resolve })),
  });
  vm.runInContext(read('shared/egov-shared.js'), realm);
  const search = realm.EgovShared.createLawSearch();
  const first = search.start('old');
  assert.equal(search.start('old'), first);
  assert.equal(calls.length, 1);
  const next = search.start('new');
  assert.equal(calls[0].options.signal.aborted, true);
  calls[1].resolve(new Response('{"laws":[{"law_id":"new"}]}'));
  await next.promise;
  calls[0].resolve(new Response('{"laws":[{"law_id":"old"}]}'));
  await first.promise;
  assert.equal(first.isCurrent(), false);
  assert.equal(next.isCurrent(), true);
  search.cancel();
  assert.equal(next.isCurrent(), false);
});

test('reference shards preserve every source record and the export reconstructs all laws', async () => {
  const source = fs.readFileSync(path.join(root, 'data/references.json'));
  const original = JSON.parse(source.toString('utf8').replace(/^\uFEFF/, ''));
  const manifest = JSON.parse(read('data/reference-shards/manifest.json'));
  assert.equal(createHash('sha256').update(source).digest('hex'), manifest.sourceSha256);
  assert.equal(Object.keys(manifest.shards).length, 256);
  for (const [name, hash] of Object.entries(manifest.shards)) {
    const buffer = fs.readFileSync(path.join(root, `data/reference-shards/${name}.json`));
    assert.equal(createHash('sha256').update(buffer).digest('hex'), hash);
    for (const [lawId, references] of Object.entries(JSON.parse(buffer))) {
      assert.deepEqual(references, original[lawId]);
    }
  }
  const realm = vm.createContext({
    chrome: { runtime: { getURL: file => file } },
    fetch: async file => new Response(read(file)),
  });
  const sourceCode = read('options.js');
  vm.runInContext(sourceCode.slice(sourceCode.indexOf('  async function readBundledReferencesForExport()'),
    sourceCode.indexOf('  async function exportReferences()')), realm);
  const exported = await realm.readBundledReferencesForExport();
  assert.deepEqual(Object.keys(exported).sort(), Object.keys(original).sort());
  for (const lawId of Object.keys(original)) assert.deepEqual(exported[lawId], original[lawId]);
});

test('runtime reference lookup loads only the selected shard and shares concurrent reads', async () => {
  let calls = 0;
  const realm = vm.createContext({ bundledReferenceShardPromises: new Map(),
    chrome: { runtime: { getURL: file => file } },
    fetch: async file => { calls++; assert.match(file, /^data\/reference-shards\/[0-9a-f]{2}\.json$/); return new Response(read(file)); },
  });
  const code = read('background.js');
  vm.runInContext(code.slice(code.indexOf('function getBundledReferencesData('), code.indexOf('async function openActionPopup(')), realm);
  const law = Object.keys(JSON.parse(read('data/reference-shards/00.json')))[0];
  const [a, b] = await Promise.all([realm.getBundledReferencesData(law), realm.getBundledReferencesData(law)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.ok(a[law]);
});

test('highlight restoration yields by attempts for all failures and mixed successes in both modes', async () => {
  for (const lite of [false, true]) {
    const code = read(lite ? 'shared/text-highlights.js' : 'content.js');
    const start = code.indexOf(lite ? '    async function restore()' : '  async function restoreTextHighlights()');
    const end = code.indexOf(lite ? '    function scheduleRestore(' : '  function scheduleTextHighlightRestore(', start);
    for (const successes of [0, 25]) {
      let frames = 0, attempts = 0;
      const records = new Map(Array.from({ length: 125 }, (_, id) => [id, { id }]));
      const realm = vm.createContext({
        document: { querySelector: () => ({}) }, root: { isConnected: true },
        enabled: true, textHighlightFeatureEnabled: true, records, textHighlightRecords: records,
        canRestoreTextHighlights: () => true,
        rangesByColor: {}, textHighlightRanges: {},
        loadRecords: async () => {}, loadTextHighlightRecords: async () => {},
        getDisplayRecords: () => [...records.values()], getTextHighlightDisplayRecords: () => [...records.values()],
        buildAnchorIndex: () => new Map(),
        restoreRecord: () => ++attempts <= successes, restoreTextHighlightRecord: () => ++attempts <= successes,
        refreshColor: () => {}, refreshTextHighlightColor: () => {},
        scheduleRestoreNotice: () => {}, scheduleTextHighlightRestoreNotice: () => {},
        requestAnimationFrame: callback => { frames++; callback(); },
      });
      vm.runInContext(code.slice(start, end), realm);
      await (lite ? realm.restore() : realm.restoreTextHighlights());
      assert.equal(attempts, 125);
      assert.equal(frames, 5);
    }
  }
});

test('normal memo restoration skips compare/cite, including a tab change during loading', async () => {
  const code = read('content.js');
  const helper = code.slice(code.indexOf('  function canRestoreTextHighlights('), code.indexOf('  function scheduleTextHighlightRestoreNotice('));
  const restore = code.slice(code.indexOf('  async function restoreTextHighlights('), code.indexOf('  function discardInvalidTextHighlightRanges('));
  for (const tab of ['compare', 'cite', 'cited']) {
    let loads = 0, attempts = 0, timers = 0;
    const location = { search: '?lawId=example&tab=' + tab };
    const records = new Map([['memo', {id:'memo'}]]);
    const realm = vm.createContext({
      URLSearchParams, location, textHighlightFeatureEnabled:true, textHighlightRestoreTimer:0,
      textHighlightRecords:records, textHighlightRanges:{},
      clearTextHighlightRestoreNotice:()=>{}, scheduleTextHighlightRestoreNotice:()=>{},
      loadTextHighlightRecords:async()=>{loads++;},
      document:{querySelector:selector=>selector==='#provisionview'?{}:null}, getTextHighlightDisplayRecords:()=>[...records.values()],
      restoreTextHighlightRecord:()=>{attempts++;return true;},
      refreshTextHighlightColor:()=>{},
      clearTimeout:()=>{}, setTimeout:()=>{timers++;},
    });
    vm.runInContext(helper + restore, realm);
    realm.scheduleTextHighlightRestore();
    await realm.restoreTextHighlights();
    assert.deepEqual([loads,attempts,timers],[0,0,0]);
    location.search='?tab=law';
    await realm.restoreTextHighlights();
    assert.deepEqual([loads,attempts],[1,1]);
    realm.loadTextHighlightRecords=async()=>{loads++;location.search='?tab='+tab;};
    await realm.restoreTextHighlights();
    assert.deepEqual([loads,attempts],[2,1]);
  }
});
