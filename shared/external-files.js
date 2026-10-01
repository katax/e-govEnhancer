(function (global) {
  'use strict';
  const PREFIX = 'textHighlights:v1:';
  const categories = ['favorites', 'memos'];
  const favoriteKeys = ['favorites', 'favFolders', 'folderCollapsed'];
  const matches = (category, key) => category === 'favorites' ? favoriteKeys.includes(key) : key.startsWith(PREFIX);
  // Handles and the last common snapshot survive service-worker restarts.
  async function entry(key, value) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('egov-external-files', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('files', value === undefined ? 'readonly' : 'readwrite');
        const request = value === undefined ? tx.objectStore('files').get(key) : tx.objectStore('files').put(value, key);
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('ファイル設定の保存に失敗しました。'));
      });
    } finally { db.close(); }
  }
  function normalize(category, raw) {
    if (category === 'favorites') {
      const { favorites, favFolders, folderCollapsed } = global.EgovTransferData.validateFavoritesImport(raw);
      return { type: 'egov-extension-favorites', version: 1, favorites, favFolders, folderCollapsed };
    }
    const { laws } = global.EgovTransferData.validateTextHighlightsImport(raw);
    return { type: 'egov-extension-text-highlights', version: 1, laws };
  }
  async function snapshot(category) {
    const stored = await chrome.storage.local.get(category === 'favorites' ? favoriteKeys : null);
    if (category === 'favorites') return normalize(category, {
      type: 'egov-extension-favorites', version: 1,
      favorites: stored.favorites || [], favFolders: stored.favFolders || [], folderCollapsed: stored.folderCollapsed || {},
    });
    const laws = {};
    for (const [key, records] of Object.entries(stored)) {
      if (key.startsWith(PREFIX) && Array.isArray(records) && records.length) laws[key.slice(PREFIX.length)] = records;
    }
    return normalize(category, { type: 'egov-extension-text-highlights', version: 1, laws });
  }
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
  }
  const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  async function read(category, handle) {
    const file = await handle.getFile();
    if (file.size > 25 * 1024 * 1024) throw new Error('ファイルサイズは25MBまでです。');
    return normalize(category, JSON.parse(await file.text()));
  }
  async function write(handle, data) {
    const stream = await handle.createWritable();
    try {
      await stream.write(JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2) + '\n');
      await stream.close();
    } catch (error) { await stream.abort().catch(() => {}); throw error; }
  }
  async function apply(category, data) {
    if (category === 'favorites') {
      const { favorites, favFolders, folderCollapsed } = data;
      await chrome.storage.local.set({ favorites, favFolders, folderCollapsed });
    } else {
      const stored = await chrome.storage.local.get(null);
      const updates = Object.fromEntries(Object.entries(data.laws).map(([lawId, records]) => [PREFIX + lawId, records]));
      // One storage operation also clears deleted laws, avoiding intermediate snapshots.
      for (const key of Object.keys(stored)) if (key.startsWith(PREFIX) && !Object.hasOwn(updates, key)) updates[key] = [];
      await chrome.storage.local.set(updates);
    }
  }
  async function backup(category, data) {
    const history = await entry('backups:' + category) || [];
    if (!equal(history[0]?.data, data)) {
      history.unshift({ savedAt: new Date().toISOString(), data });
      await entry('backups:' + category, history.slice(0, 3));
    }
  }
  global.EgovExternalFiles = { categories, matches, entry, normalize, snapshot, equal, read, write, apply, backup };
})(globalThis);
