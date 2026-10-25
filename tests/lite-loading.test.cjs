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
    readCachedLiteLaw: async () => null,
    EGOV_API_V2_BASE: 'https://example.test', liteLawLoadPromises: new Map(),
    getLiteLawDataUrl: (target, date = '') => `xml/${target}?asof=${date}`,
    getJapanDateString: () => '2026-09-27',
    findCurrentLawRevisionId: revisions => revisions[0]?.law_revision_id || '',
    cacheLiteLawXml: async (...args) => cached.push(args),
    chrome: { storage: { local: { set: async value => stored.push(value) } } },
  });
  const source = read('background.js');
  vm.runInContext(source.slice(source.indexOf('async function fetchLiteLawResponse('),
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
  await new Promise(resolve => setImmediate(resolve));
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


async function loadViewer(xmlText, force = false) {
  let renders = 0, finishes = 0, message;
  const label = {};
  const context = vm.createContext({
    lawId: 'law', localRule: null, articleElementsCache: [], contentEl: {}, revisionIdParam: '',
    revisions: [], currentRevisionId: '', forceLiteDownload: force,
    lawLoadGeneration: 0, EgovLawUpdates: { setButtonState() {} }, scheduleLiteLawUpdateCheck() {},
    document: { getElementById: () => label },
    chrome: { runtime: { sendMessage: async value => {
      message = value;
      return { ok: true, cacheTarget: 'law', currentRevisionId: 'rev', revisions: [], xmlText, downloadedAt: 1792857600000 };
    } } },
    renderLawXml: text => { renders++; assert.equal(text, xmlText); return text; },
    jumpToInitialHash() {}, renderRevisionSelect() {},
    finishLawLoad: async () => { finishes++; },
  });
  const source = read('viewer.js');
  vm.runInContext(source.slice(source.indexOf('  async function loadLaw()'), source.indexOf('  function isInputActive()')), context);
  await context.loadLaw();
  return { renders, finishes, message, label };
}

test('Lite renders returned XML without requiring a saved cache entry', async () => {
  const result = await loadViewer('<Law/>');
  assert.equal(result.renders, 1);
  assert.equal(result.finishes, 1);
  assert.match(result.label.textContent, /法令ファイル取得日時：/);
  assert.equal(result.message.force, false);
});

test('Lite manual download explicitly bypasses cached content', async () => {
  const result = await loadViewer('<Law/>', true);
  assert.equal(result.renders, 1);
  assert.equal(result.message.force, true);
});

test('direct manual reacquisition resolves the latest revision even when the viewer previously displayed an old one', async () => {
  let requestedUrl;
  const context = vm.createContext({
    forceLiteDownload: true, revisionIdParam: '', lawId: 'law', currentRevisionId: 'old', revisions: [],
    findCurrentLawRevisionId: entries => entries.find(entry => entry.current_revision_status === 'CurrentEnforced')?.law_revision_id || '',
    getJapanDateString: () => '2026-10-25', getLiteLawDataUrl: target => `https://test/${target}`,
    fetchWithTimeout: async url => { requestedUrl = url; return new Response('<Law/>'); },
    cacheLiteLawXml: async () => {},
    loadRevisions: async () => { context.revisions = [{ law_revision_id: 'latest', current_revision_status: 'CurrentEnforced' }]; },
  });
  const source = read('viewer.js');
  vm.runInContext(source.slice(source.indexOf('  async function loadLiteLawDirectly()'), source.indexOf('  async function finishLawLoad()')), context);
  const result = await context.loadLiteLawDirectly();
  assert.equal(result.currentRevisionId, 'latest');
  assert.equal(requestedUrl, 'https://test/latest');
});
