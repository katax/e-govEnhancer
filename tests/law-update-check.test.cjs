const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const lawId = '405AC0000000088';
const oldId = `${lawId}_20250401_507AC0000000001`;
const currentId = `${lawId}_20260401_508AC0000000001`;
const futureId = `${lawId}_20270401_508AC0000000002`;

function setup(fetch, timeout = 10000) {
  let listener;
  class Clock extends Date { static now() { return Date.parse('2026-10-25T00:00:00Z'); } }
  const context = vm.createContext({ URL, Date: Clock, AbortController, fetch,
    setTimeout: (callback, delay) => setTimeout(callback, Math.min(delay, timeout)), clearTimeout,
    chrome: { runtime: { id: 'extension', getURL: file => `chrome-extension://extension/${file}`,
      onMessage: { addListener: fn => { listener = fn; } } } },
  });
  vm.runInContext(read('shared/law-update-check.js'), context);
  vm.runInContext(read('shared/law-update-check-background.js'), context);
  const sender = { id: 'extension', tab: { id: 1 }, frameId: 0, url: `https://laws.e-gov.go.jp/law/${lawId}` };
  const message = { type: 'egov-check-law-update', mode: 'normal', lawId, displayedRevision: '100_1' };
  return { helper: context.EgovLawUpdates, sender, message,
    call: (changes = {}, from = sender) => new Promise(resolve => listener({ ...message, ...changes }, from, resolve)),
    lite: revision => new Promise(resolve => listener({ ...message, mode: 'lite', displayedRevision: revision },
      { ...sender, url: `chrome-extension://extension/viewer.html?lawId=${lawId}` }, resolve)),
  };
}

test('only enacted versions count; scheduled dates and future amendments do not warn', () => {
  const { helper } = setup(() => { throw Error('unexpected'); });
  const revisions = [
    { law_revision_id: futureId, current_revision_status: 'UnEnforced', amendment_scheduled_enforcement_date: '2027-04-01' },
    { law_revision_id: currentId, current_revision_status: 'CurrentEnforced', amendment_enforcement_date: '2026-04-01' },
    { law_revision_id: oldId, current_revision_status: 'PreviousEnforced', amendment_enforcement_date: '2025-04-01' },
  ];
  assert.equal(helper.latestEnforcedRevision(revisions, 'lite', lawId, '2026-10-25'), currentId);
  assert.equal(helper.latestEnforcedRevision(revisions.slice(0, 1), 'lite', lawId, '2026-10-25'), '');
  assert.equal(helper.latestEnforcedRevision([{ ...revisions[0], current_revision_status: 'CurrentEnforced', amendment_enforcement_date: '2027-04-01' }], 'lite', lawId, '2026-10-25'), '');
  assert.equal(helper.latestEnforcedRevision([{ LawDataId: 101, SubRevision: '1', ScheduledEnforcementDate: '2025-01-01', IsCurrentEnforcement: false }], 'normal', lawId, '2026-10-25'), '');
});

test('normal mode compares the exact body revision including subrevision', async () => {
  const calls = [];
  const s = setup(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ result: { success: true, Amendment_History: [
      { LawDataId: 102, SubRevision: '1', EnforcementDate: '2027-01-01', IsCurrentEnforcement: false },
      { LawDataId: 100, SubRevision: '2', EnforcementDate: '2026-04-01', IsCurrentEnforcement: true },
    ] } }));
  });
  assert.equal((await s.call()).updated, true);
  assert.equal((await s.call({ displayedRevision: '100_2' })).updated, false);
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.headers['Cache-Control'], 'no-cache');
  assert.match(calls[0].url, /SelectLawRevisionData\.json$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { law_id: lawId });
  const request = { method: 'POST', url: 'https://laws.e-gov.go.jp/internal-api/SelectLawTextData.json', body: JSON.stringify({ law_id: lawId, law_data_id: 100, subRevision: '2' }) };
  assert.equal(s.helper.normalBodyRevision(request, lawId), '100_2');
  assert.equal(s.helper.normalBodyRevision({ method: 'GET', url: `https://laws.e-gov.go.jp/data/Act/${lawId}/100_2/${currentId}_law.html` }, lawId), '100_2');
  assert.equal(s.helper.normalBodyRevision({ ...request, url: 'https://other.test/internal-api/SelectLawTextData.json' }, lawId), '');
});

test('Lite compares displayed revision with latest enacted revision without downloading law text', async () => {
  const urls = [];
  const s = setup(async url => {
    urls.push(url);
    return new Response(JSON.stringify({ revisions: [
      { law_revision_id: futureId, current_revision_status: 'UnEnforced', amendment_enforcement_date: '2027-04-01' },
      { law_revision_id: currentId, current_revision_status: 'CurrentEnforced', amendment_enforcement_date: '2026-04-01' },
    ] }));
  });
  assert.equal((await s.lite(oldId)).updated, true);
  assert.equal((await s.lite(currentId)).updated, false);
  assert.ok(urls.every(url => url.includes('/law_revisions/')));
});

test('dated/explicit versions and invalid callers do not initiate update checks', async () => {
  let calls = 0;
  const s = setup(async () => { calls++; return new Response('{}'); });
  for (const url of [s.sender.url + '?occasion_date=2025-01-01', s.sender.url + '/20250401',
    `chrome-extension://extension/viewer.html?lawId=${lawId}&revisionId=${oldId}`]) {
    const lite = url.startsWith('chrome-extension:');
    assert.equal((await s.call(lite ? { mode: 'lite', displayedRevision: oldId } : {}, { ...s.sender, url })).ok, false);
  }
  assert.equal((await s.call({}, { ...s.sender, id: 'other' })).ok, false);
  assert.equal((await s.call({}, { ...s.sender, frameId: 1 })).ok, false);
  assert.equal((await s.call({ displayedRevision: 'unknown' })).ok, false);
  assert.equal(calls, 0);
});

test('concurrent checks share metadata; errors and stalled bodies stay unknown and can retry', async () => {
  let calls = 0;
  const s = setup(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); throw Error('offline'); });
  const results = await Promise.all([s.call(), s.call()]);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.ok === false && result.updated === undefined));
  await s.call(); assert.equal(calls, 2);
  const stalled = setup(async (_, { signal }) => ({ ok: true, json: () => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Error('timeout')), { once: true });
  }) }), 5);
  assert.equal((await stalled.call()).ok, false);
});
