importScripts('shared/egov-shared.js');

chrome.runtime.onStartup?.addListener(() => {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
});

chrome.runtime.onInstalled?.addListener((details) => {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
  if (details?.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(() => {});
  }
  // 未パッケージ拡張の「再読み込み」でも update が発火するため、実際にバージョンが変わったときだけクリアする
  if (details?.reason === 'update' && details.previousVersion !== chrome.runtime.getManifest().version) {
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

async function openManualPage() {
  return chrome.tabs.create({
    url: chrome.runtime.getURL('docs/user-manual.html'),
    active: true,
  });
}

const {
  REFERENCES_BUNDLED_CACHE_STORE,
  REFERENCES_CURRENT_META_KEY,
  REFERENCES_LAWS_STORE,
  REFERENCES_META_STORE,
  cacheLiteLawXml,
  getLiteLawDataUrl,
  idbRequest,
  isPlainObject,
  openReferencesDb,
  waitForTransaction,
} = globalThis.EgovShared;
let bundledReferencesParsePromise = null;
let bundledReferencesReaderCount = 0;
const EGOV_API_V2_BASE = 'https://laws.e-gov.go.jp/api/2';
const liteLawLoadPromises = new Map();

function getLiteLawRevisionStorageKey(lawId) {
  return `liteLawCurrentRevision:${lawId}`;
}

async function fetchLiteLawRevisions(lawId) {
  const response = await fetch(`${EGOV_API_V2_BASE}/law_revisions/${encodeURIComponent(lawId)}?response_format=json`);
  if (!response.ok) throw new Error(`Revision fetch failed: HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.revisions) ? data.revisions : [];
}

function findCurrentLiteLawRevisionId(revisions) {
  const current = revisions.find((revision) => revision.current_revision_status === 'CurrentEnforced') || revisions[0];
  return current?.law_revision_id || '';
}

async function fetchLiteLawXml(target) {
  const response = await fetch(getLiteLawDataUrl(target), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Law fetch failed: HTTP ${response.status}`);
  const xmlText = await response.text();
  if (!xmlText.trim()) throw new Error('Law fetch returned an empty response');
  return xmlText;
}

async function loadAndCacheLiteLaw(lawId, revisionId = '') {
  const promiseKey = `${lawId}:${revisionId || 'current'}`;
  if (liteLawLoadPromises.has(promiseKey)) return liteLawLoadPromises.get(promiseKey);

  const loadPromise = (async () => {
    const revisionStorageKey = getLiteLawRevisionStorageKey(lawId);
    const stored = await chrome.storage.local.get([revisionStorageKey]).catch(() => ({}));
    const storedRevisionId = typeof stored[revisionStorageKey] === 'string' ? stored[revisionStorageKey] : '';
    const initialTarget = revisionId || storedRevisionId || lawId;

    // 改正履歴と本文を同時に開始し、従来の直列待ちをなくす。
    const revisionsPromise = fetchLiteLawRevisions(lawId).catch(() => []);
    const initialXmlPromise = fetchLiteLawXml(initialTarget)
      .then((xmlText) => ({ xmlText, error: null }))
      .catch((error) => ({ xmlText: '', error }));
    const [revisions, initialResult] = await Promise.all([revisionsPromise, initialXmlPromise]);
    const currentRevisionId = findCurrentLiteLawRevisionId(revisions) || storedRevisionId;
    const resolvedTarget = revisionId || currentRevisionId || initialTarget;

    let xmlText = initialResult.xmlText;
    // 保存済みの現行改正IDが古くなっていた場合と、法令IDでの取得に失敗した場合だけ再取得する。
    if ((!xmlText || (initialTarget !== lawId && initialTarget !== resolvedTarget)) && resolvedTarget !== initialTarget) {
      xmlText = await fetchLiteLawXml(resolvedTarget);
    } else if (!xmlText) {
      throw initialResult.error || new Error('Law XML could not be loaded');
    }

    const cacheTarget = resolvedTarget || initialTarget;
    await cacheLiteLawXml(cacheTarget, xmlText);
    if (!revisionId && currentRevisionId) {
      await chrome.storage.local.set({ [revisionStorageKey]: currentRevisionId }).catch(() => {});
    }
    return { cacheTarget, currentRevisionId, revisions };
  })().finally(() => {
    liteLawLoadPromises.delete(promiseKey);
  });

  liteLawLoadPromises.set(promiseKey, loadPromise);
  return loadPromise;
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

  bundledReferencesReaderCount += 1;
  try {
    const referencesData = await getBundledReferencesData();
    const references = isPlainObject(referencesData?.[lawId]) ? referencesData[lawId] : {};
    // 要求された法令は参照ゼロ（空オブジェクト）でも保存し、次回以降の再パースを防ぐ
    try {
      await saveBundledCacheRecord(lawId, references);
    } catch (error) {
      console.warn('[e-Gov Enhancer] 参照キャッシュの保存に失敗しました', error);
    }
    return references;
  } finally {
    bundledReferencesReaderCount -= 1;
    if (bundledReferencesReaderCount === 0) bundledReferencesParsePromise = null;
  }
}

async function saveBundledCacheRecord(lawId, references) {
  const db = await openReferencesDb();
  try {
    const tx = db.transaction(REFERENCES_BUNDLED_CACHE_STORE, 'readwrite');
    tx.objectStore(REFERENCES_BUNDLED_CACHE_STORE).put({
      lawId,
      references: isPlainObject(references) ? references : {},
    });
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

async function readCachedLawReferences(lawId) {
  const db = await openReferencesDb();
  try {
    const metaTx = db.transaction(REFERENCES_META_STORE, 'readonly');
    const meta = await idbRequest(metaTx.objectStore(REFERENCES_META_STORE).get(REFERENCES_CURRENT_META_KEY));
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
    })();
  }
  return bundledReferencesParsePromise;
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'egov-open-options-page') {
    chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'egov-open-manual-page') {
    openManualPage().then((tab) => sendResponse({ ok: true, tabId: tab?.id })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'egov-get-imported-law-references') {
    getImportedLawReferences(message.lawId)
      .then((lawReferences) => sendResponse({ ok: true, lawReferences }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error || '') }));
    return true;
  }
  if ((message?.type === 'egov-prefetch-lite-law' || message?.type === 'egov-load-lite-law') && message.lawId) {
    loadAndCacheLiteLaw(message.lawId, message.revisionId || '')
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error || '') }));
    return true;
  }
  if (message?.type === 'egov-open-law-reference-tab' && message.url) {
    chrome.tabs.create({ url: message.url, active: true })
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
    return;
  }
});
