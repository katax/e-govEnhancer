const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({});
for (const file of ['shared/egov-app.js', 'shared/transfer-data.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
}
const { normalizeLawShortcut, isShortcutQuery, findShortcutFavorite, saveLawShortcut } = context.EgovApp;
const { validateFavoritesImport, mergeFavoritesImport } = context.EgovTransferData;
const record = (lawId, shortcut) => ({ lawId, lawName: lawId, lawNum: '', lawType: '', folderId: null, ...(shortcut ? { shortcut } : {}) });
const pack = favorites => ({ type: 'egov-extension-favorites', version: 1, favorites, favFolders: [], folderCollapsed: {} });

test('ASCII-only queries never need a search, even beyond the five-character setting limit', () => {
  for (const value of ['a', 'Z9', '12345', 'abcdef']) assert.equal(isShortcutQuery(value), true);
  for (const value of ['', '民法', 'ＡＢ', 'ab-c', 'ab c']) assert.equal(isShortcutQuery(value), false);
  assert.equal(normalizeLawShortcut('mIn12'), 'MIN12');
  assert.equal(normalizeLawShortcut(''), '');
  for (const value of ['abcdef', '民法', 'ab-c', ' x ', 'Ａ']) assert.throws(() => normalizeLawShortcut(value));
  const law = record('A', 'MIN');
  assert.equal(findShortcutFavorite([law], 'min'), law);
  assert.equal(findShortcutFavorite([law], 'm'), null);
  assert.equal(findShortcutFavorite([law, record('B', 'min')], 'MIN'), null);
  assert.equal(findShortcutFavorite([record('A', 1)], '1'), null);
});

test('saving validates current favorites, preserves metadata, and removes cleared codes', async () => {
  let data = { favorites: [{ ...record('A'), lastScrollTop: 42 }, record('B', 'B')] };
  const storage = { get: async () => data, set: async items => { data = items; } };
  await saveLawShortcut('A', 'ab12z', storage);
  assert.equal(data.favorites[0].shortcut, 'AB12Z');
  assert.equal(data.favorites[0].lastScrollTop, 42);
  const before = JSON.stringify(data);
  await assert.rejects(saveLawShortcut('A', 'b', storage), /使用/);
  await assert.rejects(saveLawShortcut('missing', 'C', storage), /お気に入り/);
  assert.equal(JSON.stringify(data), before);
  await saveLawShortcut('A', '', storage);
  assert.equal('shortcut' in data.favorites[0], false);
  await assert.rejects(saveLawShortcut('A', 'C', { ...storage, set: async () => { throw new Error('write failed'); } }), /write failed/);
});

test('backup round trip normalizes codes and rejects duplicates including merge collisions', () => {
  const result = validateFavoritesImport(pack([record('A', 'min12'), record('B')]));
  assert.equal(result.favorites[0].shortcut, 'MIN12');
  assert.equal(validateFavoritesImport(JSON.parse(JSON.stringify(result))).favorites[0].shortcut, 'MIN12');
  assert.throws(() => validateFavoritesImport(pack([record('A', 'x'), record('B', 'X')])), /重複/);
  assert.throws(() => validateFavoritesImport(pack([record('A', 'abcdef')])), /1〜5/);
  assert.throws(() => mergeFavoritesImport(pack([record('A', 'x')]), pack([record('B', 'X')])) , /重複/);
  assert.equal(mergeFavoritesImport(pack([record('A', 'x')]), pack([record('A', 'Y')])).favorites[0].shortcut, 'X');
});

test('confirmed overwrite transfers a code while preserving both favorite records and checks new conflicts', async () => {
  let data = { favorites: [record('A', 'OLD'), { ...record('B', 'abc'), lawName: '民法', lastScrollTop: 42 }] };
  const storage = { get: async () => data, set: async items => { data = items; } };
  await assert.rejects(saveLawShortcut('A', 'ABC', storage), error => {
    assert.match(error.message, /民法/);
    assert.equal(error.code, 'SHORTCUT_CONFLICT');
    assert.equal(error.conflicts[0].lawId, 'B');
    return true;
  });
  await saveLawShortcut('A', 'ABC', storage, { overwriteLawIds: ['B'] });
  assert.equal(data.favorites[0].shortcut, 'ABC');
  assert.equal('shortcut' in data.favorites[1], false);
  assert.equal(data.favorites[1].lawName, '民法');
  assert.equal(data.favorites[1].lastScrollTop, 42);
  data.favorites.push(record('C', 'ABC'));
  const before = JSON.stringify(data);
  await assert.rejects(saveLawShortcut('A', 'ABC', storage, { overwriteLawIds: ['B'] }), /使用/);
  assert.equal(JSON.stringify(data), before);
});
