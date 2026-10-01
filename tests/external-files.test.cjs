const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const fav = name => ({ type: 'egov-extension-favorites', version: 1, favorites: name ? [
  { lawId: '123456789012', lawName: name, lawNum: '', lawType: '', folderId: null },
] : [], favFolders: [], folderCollapsed: {} });
const memo = text => ({ type: 'egov-extension-text-highlights', version: 1, laws: text ? {
  '123456789012': [{ id: 'one', c: 'yellow', a: 'a', h: '', k: '', s: 0, e: 1, l: 1,
    q: '字', z: '', p: '', n: '', m: text, t: 1, u: 'p', v: 'p', x: 0, y: 1, f: 2 }],
} : {} });

async function harness(category = 'favorites', initial = fav('original')) {
  const records = new Map();
  const stored = category === 'favorites'
    ? { favorites: initial.favorites, favFolders: [], folderCollapsed: {} }
    : { 'textHighlights:v1:123456789012': initial.laws['123456789012'] };
  let text = JSON.stringify(initial), missing = false, permission = 'granted', writes = 0;
  let onRead, onWrite;
  const handle = {
    name: category + '.json',
    queryPermission: async () => permission,
    isSameEntry: async other => other === handle,
    getFile: async () => {
      if (missing) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      if (onRead) { const callback = onRead; onRead = null; callback(); }
      const current = text;
      return { size: Buffer.byteLength(current), text: async () => current };
    },
    createWritable: async () => {
      let pending;
      return {
        write: async value => { if (onWrite) throw new Error('disk full'); pending = value; },
        close: async () => { writes++; text = pending; }, abort: async () => {},
      };
    },
  };
  records.set(category, { handle, enabled: true, base: clone(initial) });
  let listeners, message, alarm, context;
  function boot() {
    listeners = [];
    const chrome = {
      storage: {
        local: {
          get: async keys => clone(keys === null ? stored : Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(stored, key)).map(key => [key, stored[key]]))),
          set: async updates => {
            const changes = {};
            for (const [key, value] of Object.entries(updates)) {
              if (JSON.stringify(stored[key]) === JSON.stringify(value)) continue;
              changes[key] = { oldValue: clone(stored[key]), newValue: clone(value) };
              stored[key] = clone(value);
            }
            if (Object.keys(changes).length) listeners.forEach(listener => listener(changes, 'local'));
          },
        }, onChanged: { addListener: listener => listeners.push(listener) },
      },
      alarms: { get: async () => alarm, create: async () => { alarm = {}; }, clear: async () => { alarm = null; }, onAlarm: { addListener() {} } },
      runtime: { getURL: value => 'chrome-extension://test/' + value, onMessage: { addListener: listener => { message = listener; } } },
    };
    const copyEntry = value => value?.handle ? { ...value, base: clone(value.base) } : clone(value);
    const indexedDB = { open() {
      const request = {};
      setImmediate(() => {
        request.result = {
          close() {},
          transaction() {
            const tx = { objectStore: () => ({
              get(key) { const result = { result: copyEntry(records.get(key)) }; setImmediate(() => tx.oncomplete()); return result; },
              put(value, key) { records.set(key, copyEntry(value)); setImmediate(() => tx.oncomplete()); return { result: key }; },
            }) };
            return tx;
          },
        };
        request.onsuccess();
      });
      return request;
    } };
    context = vm.createContext({ chrome, console, indexedDB });
    for (const file of ['transfer-data.js', 'external-files.js']) vm.runInContext(fs.readFileSync(path.join(root, 'shared', file), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(root, 'shared/external-files-background.js'), 'utf8'), context);
  }
  const send = (action = 'sync') => new Promise(resolve => message(
    { type: 'egov-external-file', category, action }, { url: 'chrome-extension://test/options.html' }, resolve));
  boot();
  await send();
  return {
    send, records, stored, handle, boot,
    local: async data => {
      if (category === 'favorites') await context.chrome.storage.local.set({ favorites: data.favorites });
      else await context.chrome.storage.local.set({ 'textHighlights:v1:123456789012': data.laws['123456789012'] || [] });
    },
    remote: data => { text = typeof data === 'string' ? data : JSON.stringify(data); },
    missing: value => { missing = value; }, permission: value => { permission = value; },
    failWrite: value => { onWrite = value; }, nextRead: callback => { onRead = callback; },
    disk: () => JSON.parse(text), writes: () => writes,
  };
}

test('default/unconfigured category does not read or write a file; disabling preserves data', async () => {
  const h = await harness();
  await h.send('disable');
  h.missing(true);
  await h.local(fav('offline edit'));
  assert.equal((await h.send()).ok, true);
  assert.equal(h.writes(), 0);
  assert.equal(h.stored.favorites[0].lawName, 'offline edit');
  h.records.delete('favorites');
  assert.equal((await h.send()).ok, true);
});
test('local edits save; remote changes reload; a restarted worker retains the common baseline', async () => {
  const h = await harness();
  await h.local(fav('local'));
  await h.send();
  assert.equal(h.disk().favorites[0].lawName, 'local');
  h.remote(fav('other device'));
  h.boot();
  await h.send();
  assert.equal(h.stored.favorites[0].lawName, 'other device');
  assert.equal(h.writes(), 1);
  assert.equal(h.records.get('backups:favorites')[0].data.favorites[0].lawName, 'local');
});
test('missing, empty, invalid and permission-denied files preserve unsaved local changes', async () => {
  const h = await harness();
  h.missing(true);
  await h.local(fav('unsaved'));
  assert.equal((await h.send()).ok, false);
  assert.match(h.stored['externalFileStatus:favorites'].error, /見つかりません/);
  h.missing(false);
  for (const bad of ['', '{invalid', '{}', JSON.stringify(memo('wrong type'))]) {
    h.remote(bad);
    assert.equal((await h.send()).ok, false);
    assert.equal(h.stored.favorites[0].lawName, 'unsaved');
  }
  h.remote(fav('original'));
  h.permission('prompt');
  assert.equal((await h.send()).ok, false);
  assert.equal(h.writes(), 0);
  h.permission('granted');
  await h.send();
  assert.equal(h.disk().favorites[0].lawName, 'unsaved');
});
test('conflicting edits stop; explicit remote adoption keeps a local backup', async () => {
  const h = await harness();
  h.remote(fav('remote'));
  await h.local(fav('local'));
  assert.equal((await h.send()).ok, false);
  assert.equal(h.disk().favorites[0].lawName, 'remote');
  assert.equal(h.stored.favorites[0].lawName, 'local');
  assert.equal((await h.send('read')).ok, true);
  assert.equal(h.stored.favorites[0].lawName, 'remote');
  assert.equal(h.records.get('backups:favorites')[0].data.favorites[0].lawName, 'local');
});
test('empty valid remote data requires explicit adoption', async () => {
  const h = await harness();
  h.remote(fav(''));
  assert.equal((await h.send()).ok, false);
  assert.equal(h.stored.favorites.length, 1);
  assert.equal((await h.send('read')).ok, true);
  assert.equal(h.stored.favorites.length, 0);
});
test('write failures do not advance the baseline and retry saves local data', async () => {
  const h = await harness();
  h.failWrite(true);
  await h.local(fav('new'));
  assert.equal((await h.send()).ok, false);
  assert.equal(h.records.get('favorites').base.favorites[0].lawName, 'original');
  h.failWrite(false);
  assert.equal((await h.send()).ok, true);
  assert.equal(h.disk().favorites[0].lawName, 'new');
});
test('memos are independent and deleted remote records clear the local copy after confirmation', async () => {
  const h = await harness('memos', memo('original memo'));
  await h.local(memo('edited memo'));
  await h.send();
  assert.equal(h.disk().laws['123456789012'][0].m, 'edited memo');
  h.remote(memo('remote memo'));
  await h.send();
  assert.equal(h.stored['textHighlights:v1:123456789012'][0].m, 'remote memo');
  h.remote(memo(''));
  assert.equal((await h.send()).ok, false);
  assert.equal((await h.send('read')).ok, true);
  assert.deepEqual(h.stored['textHighlights:v1:123456789012'], []);
  assert.equal(h.records.has('favorites'), false);
});
test('new file connection initializes an empty file and refuses to overwrite existing files', async () => {
  const h = await harness();
  await h.send('disable');
  h.records.set('pending:favorites', { handle: h.handle, create: true });
  assert.equal((await h.send('connect')).ok, false);
  assert.equal(h.writes(), 0);
  h.remote('');
  assert.equal((await h.send('connect')).ok, true);
  assert.equal(h.disk().favorites[0].lawName, 'original');
  assert.equal(h.records.get('favorites').enabled, true);
});
test('existing file connection backs up the local data; categories cannot share a file', async () => {
  const h = await harness();
  await h.send('disable');
  h.remote(fav('imported'));
  h.records.set('pending:favorites', { handle: h.handle, create: false });
  assert.equal((await h.send('connect')).ok, true);
  assert.equal(h.stored.favorites[0].lawName, 'imported');
  assert.equal(h.records.get('backups:favorites')[0].data.favorites[0].lawName, 'original');
  h.records.set('memos', { handle: h.handle, enabled: true });
  h.records.set('pending:favorites', { handle: h.handle, create: false });
  assert.equal((await h.send('connect')).ok, false);
});
test('explicit local adoption preserves the replaced remote data as backup', async () => {
  const h = await harness();
  h.remote(fav('remote'));
  await h.local(fav('local'));
  assert.equal((await h.send('write')).ok, true);
  assert.equal(h.disk().favorites[0].lawName, 'local');
  assert.equal(h.records.get('backups:favorites')[0].data.favorites[0].lawName, 'remote');
});
