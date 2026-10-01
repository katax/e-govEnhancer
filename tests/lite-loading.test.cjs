const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function loader(fetch) {
  const cached = [], stored = [];
  const context = vm.createContext({
    fetch, AbortController, setTimeout, clearTimeout,
    EGOV_API_V2_BASE: 'https://example.test', liteLawLoadPromises: new Map(),
    getLiteLawDataUrl: (target, date = '') => `xml/${target}?asof=${date}`,
    getJapanDateString: () => '2026-09-27',
    findCurrentLawRevisionId: revisions => revisions[0]?.law_revision_id || '',
    cacheLiteLawXml: async (...args) => cached.push(args),
    chrome: { storage: { local: { set: async value => stored.push(value) } } },
  });
  const source = read('background.js');
  vm.runInContext(source.slice(source.indexOf('function getLiteLawRevisionStorageKey('),
    source.indexOf('async function clearReferencesCache(')), context);
  return { context, cached, stored };
}
const response = value => ({ ok: true, json: async () => value, text: async () => value });

test('current law fetches only the resolved revision; concurrent callers share work', async () => {
  const urls = [];
  const { context, cached } = loader(async url => {
    urls.push(url);
    return response(url.startsWith('xml/') ? '<Law/>' : { revisions: [{ law_revision_id: 'rev' }] });
  });
  await Promise.all([context.loadAndCacheLiteLaw('law'), context.loadAndCacheLiteLaw('law')]);
  assert.equal(urls.length, 2);
  assert.equal(urls[1], 'xml/rev?asof=');
  assert.equal(cached.length, 1);
});

test('revision failure falls back to dated law request', async () => {
  const urls = [];
  const { context } = loader(async url => {
    urls.push(url);
    if (!url.startsWith('xml/')) throw new Error('offline');
    return response('<Law/>');
  });
  const result = await context.loadAndCacheLiteLaw('law');
  assert.equal(urls[1], 'xml/law?asof=2026-09-27');
  assert.equal(result.cacheTarget, 'law');
});

test('explicit revision starts fetching before revision history completes', async () => {
  let release;
  const urls = [];
  const { context } = loader(async url => {
    urls.push(url);
    if (!url.startsWith('xml/')) return new Promise(resolve => { release = () => resolve(response({ revisions: [] })); });
    return response('<Law/>');
  });
  const pending = context.loadAndCacheLiteLaw('law', 'old');
  assert.equal(urls[1], 'xml/old?asof=');
  release();
  assert.equal((await pending).cacheTarget, 'old');
});

test('timeout covers stalled response body', async () => {
  const { context } = loader(async (_url, { signal }) => ({
    ok: true,
    text: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  }));
  await assert.rejects(context.fetchLiteLawResponse('slow', 'text', {}, 5), /aborted/);
});

test('failed loads are released so a later request can retry', async () => {
  let failing = true;
  const { context } = loader(async url => {
    if (!url.startsWith('xml/')) return response({ revisions: [] });
    if (failing) throw new Error('offline');
    return response('<Law/>');
  });
  await assert.rejects(context.loadAndCacheLiteLaw('law'), /offline/);
  failing = false;
  assert.equal((await context.loadAndCacheLiteLaw('law')).cacheTarget, 'law');
});

async function loadViewer(fresh, cacheTarget = 'rev') {
  let reads = 0, renders = 0, finishes = 0;
  const context = vm.createContext({
    lawId: 'law', localRule: null, articleElementsCache: [], contentEl: {}, revisionIdParam: '',
    revisions: [], currentRevisionId: '',
    chrome: { runtime: { sendMessage: async () => ({ ok: true, cacheTarget, currentRevisionId: 'rev', revisions: [] }) },
      storage: { local: { get: async () => ({ revision: 'rev' }) } } },
    getLiteLawRevisionStorageKey: () => 'revision',
    readCachedLiteLawXml: async () => ++reads === 1 ? 'original' : fresh,
    renderLawXml: text => { renders++; return text; },
    parseLawXmlForRender: text => ({ signature: text }),
    renderParsedLawXml: data => { renders++; return data.signature; },
    jumpToInitialHash() {}, renderRevisionSelect() {},
    finishLawLoad: async () => { finishes++; },
  });
  const source = read('viewer.js');
  vm.runInContext(source.slice(source.indexOf('  async function loadLaw()'), source.indexOf('  function isInputActive()')), context);
  await context.loadLaw();
  return { reads, renders, finishes };
}

test('same cache key with changed content refreshes the visible law', async () => {
  assert.deepEqual(await loadViewer('corrected'), { reads: 2, renders: 2, finishes: 1 });
});

test('unchanged content keeps existing DOM, even when the key changes', async () => {
  for (const key of ['rev', 'new-rev']) {
    assert.deepEqual(await loadViewer('original', key), { reads: 2, renders: 1, finishes: 1 });
  }
});
