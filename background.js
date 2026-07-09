chrome.runtime.onStartup?.addListener(() => {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
});

chrome.runtime.onInstalled?.addListener((details) => {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
  if (details?.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(() => {});
  }
  if (details?.reason === 'update') {
    clearReferencesCache().catch(() => {});
  }
});

function getLawUrl(lawId) {
  return `https://laws.e-gov.go.jp/law/${encodeURIComponent(lawId)}`;
}

function getLawIdFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/^\/law\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch (_) {
    return '';
  }
}

function getViewerUrl({ lawId, lawName = '', sourceUrl = '' }) {
  const params = new URLSearchParams();
  params.set('lawId', lawId);
  if (lawName) params.set('lawName', lawName);
  if (sourceUrl) params.set('sourceUrl', sourceUrl);
  return chrome.runtime.getURL(`viewer.html?${params.toString()}`);
}

const REFERENCES_DB_NAME = 'egov-extension-references';
const REFERENCES_DB_VERSION = 2;
const REFERENCES_LAWS_STORE = 'laws';
const REFERENCES_META_STORE = 'meta';
const REFERENCES_BUNDLED_CACHE_STORE = 'bundled_cache';
let bundledReferencesParsePromise = null;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function openReferencesDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REFERENCES_DB_NAME, REFERENCES_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(REFERENCES_LAWS_STORE)) {
        db.createObjectStore(REFERENCES_LAWS_STORE, { keyPath: 'lawId' });
      }
      if (!db.objectStoreNames.contains(REFERENCES_META_STORE)) {
        db.createObjectStore(REFERENCES_META_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(REFERENCES_BUNDLED_CACHE_STORE)) {
        db.createObjectStore(REFERENCES_BUNDLED_CACHE_STORE, { keyPath: 'lawId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

async function clearReferencesCache() {
  const db = await openReferencesDb();
  try {
    const tx = db.transaction(REFERENCES_BUNDLED_CACHE_STORE, 'readwrite');
    await idbRequest(tx.objectStore(REFERENCES_BUNDLED_CACHE_STORE).clear());
  } finally {
    db.close();
  }
}

async function getImportedLawReferences(lawId) {
  if (!lawId) return {};
  try {
    const cached = await readCachedLawReferences(lawId);
    if (cached) return cached.references;
  } catch (error) {
    console.warn('[e-Gov Enhancer] 参照キャッシュの読み込みに失敗しました', error);
  }

  const referencesData = await getBundledReferencesData();
  const references = isPlainObject(referencesData?.[lawId]) ? referencesData[lawId] : {};
  try {
    await saveBundledReferencesData(referencesData);
  } catch (error) {
    console.warn('[e-Gov Enhancer] 参照キャッシュの保存に失敗しました', error);
  }
  return references;
}

async function readCachedLawReferences(lawId) {
  const db = await openReferencesDb();
  try {
    const metaTx = db.transaction(REFERENCES_META_STORE, 'readonly');
    const meta = await idbRequest(metaTx.objectStore(REFERENCES_META_STORE).get('current'));
    if (meta) {
      const lawTx = db.transaction(REFERENCES_LAWS_STORE, 'readonly');
      const record = await idbRequest(lawTx.objectStore(REFERENCES_LAWS_STORE).get(lawId));
      return { references: isPlainObject(record?.references) ? record.references : {} };
    }

    const bundledTx = db.transaction(REFERENCES_BUNDLED_CACHE_STORE, 'readonly');
    const record = await idbRequest(bundledTx.objectStore(REFERENCES_BUNDLED_CACHE_STORE).get(lawId));
    return record ? { references: isPlainObject(record.references) ? record.references : {} } : null;
  } finally {
    db.close();
  }
}

function getBundledReferencesData() {
  if (!bundledReferencesParsePromise) {
    bundledReferencesParsePromise = (async () => {
      const response = await fetch(chrome.runtime.getURL('data/references.json'));
      if (!response.ok) throw new Error(`References fetch failed: HTTP ${response.status}`);
      return response.json();
    })().finally(() => {
      bundledReferencesParsePromise = null;
    });
  }
  return bundledReferencesParsePromise;
}

async function saveBundledReferencesData(referencesData) {
  if (!isPlainObject(referencesData)) return;
  const db = await openReferencesDb();
  try {
    const tx = db.transaction(REFERENCES_BUNDLED_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(REFERENCES_BUNDLED_CACHE_STORE);
    for (const [lawId, references] of Object.entries(referencesData)) {
      if (!isPlainObject(references) || !Object.keys(references).length) continue;
      store.put({ lawId, references });
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });
  } finally {
    db.close();
  }
}

async function openActionPopup(mode = '') {
  await chrome.storage.session.set({ requestedPopupMode: mode || '' }).catch(() => {});

  if (typeof chrome.action?.openPopup !== 'function') {
    await chrome.storage.session.remove('requestedPopupMode').catch(() => {});
    return false;
  }

  try {
    await chrome.action.openPopup();
    return true;
  } catch (_) {
    await chrome.storage.session.remove('requestedPopupMode').catch(() => {});
    return false;
  }
}

function sendJumpWhenReady(tabId, pin) {
  let done = false;

  const trySend = async () => {
    if (done) return;
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'egov-perform-color-pin-jump', pin });
      if (response && response.ok) {
        done = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
      }
    } catch (_) {}
  };

  const onUpdated = (updatedTabId, changeInfo) => {
    if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
    trySend();
  };

  chrome.tabs.onUpdated.addListener(onUpdated);
  trySend();
  setTimeout(() => {
    if (!done) chrome.tabs.onUpdated.removeListener(onUpdated);
  }, 15000);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'egov-open-options-page') {
    chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'egov-get-imported-law-references') {
    getImportedLawReferences(message.lawId)
      .then((lawReferences) => sendResponse({ ok: true, lawReferences }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error || '') }));
    return true;
  }
  if (message?.type === 'egov-open-law-reference-tab' && message.url) {
    chrome.tabs.create({ url: message.url, active: true })
      .then((tab) => sendResponse({ ok: true, tabId: tab?.id }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'egov-open-lightweight-viewer' && message.lawId) {
    const url = getViewerUrl({
      lawId: message.lawId,
      lawName: message.lawName || '',
      sourceUrl: message.sourceUrl || sender?.tab?.url || '',
    });
    const openPromise = sender?.tab?.id
      ? chrome.tabs.update(sender.tab.id, { url, active: true })
      : chrome.tabs.create({ url, active: true });
    openPromise
      .then((tab) => sendResponse({ ok: true, tabId: tab?.id }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type !== 'egov-jump-color-pin' || !message.pin?.lawId) return undefined;

  (async () => {
    const targetLawId = message.pin.lawId;
    const tabs = await chrome.tabs.query({ url: 'https://laws.e-gov.go.jp/law/*' });
    let targetTab = tabs.find((tab) => getLawIdFromUrl(tab.url || '') === targetLawId);

    if (targetTab) {
      if (targetTab.windowId) {
        await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
      }
      await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
      sendJumpWhenReady(targetTab.id, message.pin);
      sendResponse({ ok: true, targetTabId: targetTab.id });
      return;
    }

    targetTab = await chrome.tabs.create({ url: getLawUrl(targetLawId), active: true });
    sendJumpWhenReady(targetTab.id, message.pin);
    sendResponse({ ok: true, targetTabId: targetTab.id });
  })().catch(() => sendResponse({ ok: false }));

  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open_favorites_popup') {
    openActionPopup('favorites').catch(() => {});
    return;
  }
  if (command === 'open_history_popup') {
    openActionPopup('law').catch(() => {});
  }
});
