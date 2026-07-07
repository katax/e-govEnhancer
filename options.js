document.addEventListener('DOMContentLoaded', async () => {
  const smoothToggle = document.getElementById('smoothScrollToggle');
  const liteModeDefaultToggle = document.getElementById('liteModeDefaultToggle');
  const hideLawSidebarDefaultToggle = document.getElementById('hideLawSidebarDefaultToggle');
  const pinToastToggle = document.getElementById('pinToastToggle');
  const lawRefClickToggle = document.getElementById('lawRefClickToggle');
  const lawRefHoverPopupToggle = document.getElementById('lawRefHoverPopupToggle');
  const lawRefHoverPopupRow = document.getElementById('lawRefHoverPopupRow');
  const lawRefOtherLawPopupToggle = document.getElementById('lawRefOtherLawPopupToggle');
  const lawRefOtherLawPopupRow = document.getElementById('lawRefOtherLawPopupRow');
  const liteDefTooltipToggle = document.getElementById('liteDefTooltipToggle');
  const defTooltipClickOnlyToggle = document.getElementById('defTooltipClickOnlyToggle');
  const defTooltipClickOnlyRow = document.getElementById('defTooltipClickOnlyRow');
  const externalReferencesAutoEnableToggle = document.getElementById('externalReferencesAutoEnableToggle');
  const exportFavoritesBtn = document.getElementById('exportFavoritesBtn');
  const importFavoritesBtn = document.getElementById('importFavoritesBtn');
  const importFavoritesInput = document.getElementById('importFavoritesInput');
  const favoritesTransferStatus = document.getElementById('favoritesTransferStatus');
  const favoritesTransferSummary = document.getElementById('favoritesTransferSummary');
  const exportReferencesBtn = document.getElementById('exportReferencesBtn');
  const importReferencesBtn = document.getElementById('importReferencesBtn');
  const importReferencesInput = document.getElementById('importReferencesInput');
  const referencesTransferStatus = document.getElementById('referencesTransferStatus');
  const referencesTransferSummary = document.getElementById('referencesTransferSummary');

  const FAVORITES_EXPORT_TYPE = 'egov-extension-favorites';
  const FAVORITES_EXPORT_VERSION = 1;
  const FAVORITES_MAX = 50;
  const REFERENCES_DB_NAME = 'egov-extension-references';
  const REFERENCES_DB_VERSION = 1;
  const REFERENCES_LAWS_STORE = 'laws';
  const REFERENCES_META_STORE = 'meta';
  const REFERENCES_CURRENT_META_KEY = 'current';
  const formatProvisionSourcePathFromEgovUrl = globalThis.EgovShared?.formatProvisionSourcePathFromEgovUrl || (() => '');

  smoothToggle.checked = false;
  liteModeDefaultToggle.checked = false;
  hideLawSidebarDefaultToggle.checked = false;
  pinToastToggle.checked = true;
  lawRefClickToggle.checked = true;
  lawRefHoverPopupToggle.checked = false;
  lawRefOtherLawPopupToggle.checked = true;
  liteDefTooltipToggle.checked = true;
  defTooltipClickOnlyToggle.checked = true;
  externalReferencesAutoEnableToggle.checked = true;

  chrome.storage.local.get([
    'scrollBehavior',
    'liteModeDefault',
    'hideLawSidebarDefault',
    'pinToastDefaultVisible',
    'lawRefClickEnabled',
    'lawRefHoverPopup',
    'lawRefOtherLawPopup',
    'liteDefTooltipEnabled',
    'defTooltipClickOnly',
    'externalReferencesAutoEnable',
  ]).then(({
    scrollBehavior,
    liteModeDefault,
    hideLawSidebarDefault,
    pinToastDefaultVisible,
    lawRefClickEnabled,
    lawRefHoverPopup,
    lawRefOtherLawPopup,
    liteDefTooltipEnabled,
    defTooltipClickOnly,
    externalReferencesAutoEnable,
  }) => {
    smoothToggle.checked = (scrollBehavior === 'smooth');
    liteModeDefaultToggle.checked = (typeof liteModeDefault === 'boolean') ? liteModeDefault : false;
    hideLawSidebarDefaultToggle.checked = (typeof hideLawSidebarDefault === 'boolean') ? hideLawSidebarDefault : false;
    pinToastToggle.checked = (typeof pinToastDefaultVisible === 'boolean') ? pinToastDefaultVisible : true;
    lawRefClickToggle.checked = (typeof lawRefClickEnabled === 'boolean') ? lawRefClickEnabled : true;
    lawRefHoverPopupToggle.checked = (typeof lawRefHoverPopup === 'boolean') ? lawRefHoverPopup : false;
    lawRefOtherLawPopupToggle.checked = (typeof lawRefOtherLawPopup === 'boolean') ? lawRefOtherLawPopup : true;
    liteDefTooltipToggle.checked = (typeof liteDefTooltipEnabled === 'boolean') ? liteDefTooltipEnabled : true;
    defTooltipClickOnlyToggle.checked = (typeof defTooltipClickOnly === 'boolean') ? defTooltipClickOnly : true;
    externalReferencesAutoEnableToggle.checked = (typeof externalReferencesAutoEnable === 'boolean') ? externalReferencesAutoEnable : true;
    updateLawRefHoverPopupRow();
    updateDefTooltipClickOnlyRow();
  }).catch((error) => {
    console.warn('[e-Gov Enhancer] 設定の読み込みに失敗しました', error);
    updateLawRefHoverPopupRow();
    updateDefTooltipClickOnlyRow();
  });

  function updateLawRefHoverPopupRow() {
    lawRefHoverPopupRow.classList.toggle('is-disabled', !lawRefClickToggle.checked);
    lawRefOtherLawPopupRow.classList.toggle('is-disabled', !lawRefClickToggle.checked);
  }

  function updateDefTooltipClickOnlyRow() {
    const enabled = liteDefTooltipToggle.checked;
    defTooltipClickOnlyRow.classList.toggle('is-disabled', !enabled);
    defTooltipClickOnlyToggle.disabled = !enabled;
  }

  function createTransferUi(statusEl, summaryEl) {
    return {
      setStatus(message, tone = 'info') {
        statusEl.textContent = message;
        statusEl.className = `backup-status is-visible is-${tone}`;
      },
      clearStatus() {
        statusEl.textContent = '';
        statusEl.className = 'backup-status';
      },
      setSummary(message = '') {
        summaryEl.textContent = message;
        summaryEl.classList.toggle('is-visible', !!message);
      },
    };
  }

  const favoritesUi = createTransferUi(favoritesTransferStatus, favoritesTransferSummary);
  const referencesUi = createTransferUi(referencesTransferStatus, referencesTransferSummary);

  const setTransferStatus = (message, tone) => favoritesUi.setStatus(message, tone);
  const clearTransferStatus = () => favoritesUi.clearStatus();
  const setTransferSummary = (message) => favoritesUi.setSummary(message);
  const setReferencesTransferStatus = (message, tone) => referencesUi.setStatus(message, tone);
  const clearReferencesTransferStatus = () => referencesUi.clearStatus();
  const setReferencesTransferSummary = (message) => referencesUi.setSummary(message);

  function persistLocal(items) {
    chrome.storage.local.set(items).catch((error) => {
      console.warn('[e-Gov Enhancer] 設定の保存に失敗しました', error);
    });
  }

  function runReloadLawTabs() {
    reloadLawTabsIfConfirmed().catch((error) => {
      console.warn('[e-Gov Enhancer] タブのリロードに失敗しました', error);
    });
  }

  function downloadJson(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
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
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB を開けませんでした。'));
    });
  }

  function waitForTransaction(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('IndexedDB の処理が中断されました。'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB の処理に失敗しました。'));
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB の読み込みに失敗しました。'));
    });
  }

  function isReferenceLawId(value) {
    return /^[0-9A-Z]{12,20}$/.test(String(value || ''));
  }

  function isReferenceTargetKey(value) {
    return /^\d+(?:-\d+)*(?:\.\d+(?:-\d+)*){0,2}$/.test(String(value || ''));
  }

  function sanitizeReferenceSource(raw, path) {
    if (!isPlainObject(raw)) throw new Error(`${path} がオブジェクトではありません。`);
    if (!isReferenceLawId(raw.sourceLawId)) throw new Error(`${path}.sourceLawId が不正です。`);
    if (!isNonEmptyString(raw.sourceLawTitle)) throw new Error(`${path}.sourceLawTitle が不正です。`);
    if (!isNonEmptyString(raw.sourceUrl)) throw new Error(`${path}.sourceUrl が不正です。`);
    try {
      const parsed = new URL(raw.sourceUrl);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'laws.e-gov.go.jp') {
        throw new Error();
      }
    } catch (_) {
      throw new Error(`${path}.sourceUrl は e-Gov の https URL ではありません。`);
    }
    if (!formatProvisionSourcePathFromEgovUrl(raw.sourceUrl)) {
      throw new Error(`${path}.sourceUrl から条項号を生成できません。`);
    }
    return {
      sourceLawId: raw.sourceLawId.trim(),
      sourceLawTitle: raw.sourceLawTitle.trim(),
      sourceUrl: raw.sourceUrl.trim(),
    };
  }

  function validateReferencesImport(raw) {
    if (!isPlainObject(raw)) {
      throw new Error('JSON のトップレベルがオブジェクトではありません。');
    }

    const lawEntries = Object.entries(raw);
    if (!lawEntries.length) throw new Error('参照データが空です。');

    let targetCount = 0;
    let linkCount = 0;
    const laws = [];

    for (const [lawId, lawReferences] of lawEntries) {
      if (!isReferenceLawId(lawId)) throw new Error(`法令IDが不正です: ${lawId}`);
      if (!isPlainObject(lawReferences)) throw new Error(`${lawId} の値がオブジェクトではありません。`);

      const sanitizedReferences = {};
      for (const [targetKey, value] of Object.entries(lawReferences)) {
        if (!isReferenceTargetKey(targetKey)) throw new Error(`${lawId}.${targetKey} の参照先キーが不正です。`);
        if (!isPlainObject(value)) throw new Error(`${lawId}.${targetKey} の値がオブジェクトではありません。`);
        if (!Array.isArray(value.externalLawSources)) {
          throw new Error(`${lawId}.${targetKey}.externalLawSources が配列ではありません。`);
        }

        const externalLawSources = value.externalLawSources.map((source, index) =>
          sanitizeReferenceSource(source, `${lawId}.${targetKey}.externalLawSources[${index}]`)
        );
        sanitizedReferences[targetKey] = { externalLawSources };
        targetCount += 1;
        linkCount += externalLawSources.length;
      }

      laws.push({ lawId, references: sanitizedReferences });
    }

    return {
      laws,
      summary: {
        lawCount: laws.length,
        targetCount,
        linkCount,
      },
    };
  }

  // 同梱データ（検証済みの信頼できるデータ）の件数のみを軽量に集計する。
  function countReferencesSummary(payload) {
    let targetCount = 0;
    let linkCount = 0;
    const laws = isPlainObject(payload) ? Object.values(payload) : [];
    for (const lawReferences of laws) {
      if (!isPlainObject(lawReferences)) continue;
      for (const value of Object.values(lawReferences)) {
        targetCount += 1;
        linkCount += Array.isArray(value?.externalLawSources) ? value.externalLawSources.length : 0;
      }
    }
    return { lawCount: laws.length, targetCount, linkCount };
  }

  function buildReferencesSummary(summary = {}) {
    return [
      `法令 ${summary.lawCount || 0} 件`,
      `参照先 ${summary.targetCount || 0} 件`,
      `リンク元 ${summary.linkCount || 0} 件`,
    ].join(' / ');
  }

  async function saveReferencesImport(validated, file) {
    const db = await openReferencesDb();
    try {
      const tx = db.transaction([REFERENCES_LAWS_STORE, REFERENCES_META_STORE], 'readwrite');
      const lawsStore = tx.objectStore(REFERENCES_LAWS_STORE);
      const metaStore = tx.objectStore(REFERENCES_META_STORE);
      lawsStore.clear();
      for (const law of validated.laws) lawsStore.put(law);
      metaStore.put({
        key: REFERENCES_CURRENT_META_KEY,
        importedAt: new Date().toISOString(),
        fileName: file?.name || '',
        fileSize: file?.size || 0,
        ...validated.summary,
      });
      await waitForTransaction(tx);
    } finally {
      db.close();
    }
  }

  async function readImportedReferences() {
    const db = await openReferencesDb();
    try {
      const metaTx = db.transaction(REFERENCES_META_STORE, 'readonly');
      const meta = await requestToPromise(metaTx.objectStore(REFERENCES_META_STORE).get(REFERENCES_CURRENT_META_KEY));
      if (!meta) return null;

      const lawTx = db.transaction(REFERENCES_LAWS_STORE, 'readonly');
      const laws = await requestToPromise(lawTx.objectStore(REFERENCES_LAWS_STORE).getAll());
      const references = {};
      for (const law of laws) {
        if (law?.lawId && law.references) references[law.lawId] = law.references;
      }
      return { meta, references };
    } finally {
      db.close();
    }
  }

  function formatDateForFileName(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  }

  function buildExportSummary(data) {
    const collapsedCount = Object.values(data.folderCollapsed).filter(Boolean).length;
    return [
      `お気に入り ${data.favorites.length} 件`,
      `フォルダ ${data.favFolders.length} 件`,
      `閉じたフォルダ ${collapsedCount} 件`,
    ].join(' / ');
  }

  function sanitizeFavoriteRecord(raw, index, folderIds) {
    if (!isPlainObject(raw)) {
      throw new Error(`favorites[${index}] がオブジェクトではありません。`);
    }
    if (!isNonEmptyString(raw.lawId)) {
      throw new Error(`favorites[${index}].lawId が不正です。`);
    }
    if (!isNonEmptyString(raw.lawName)) {
      throw new Error(`favorites[${index}].lawName が不正です。`);
    }
    if (typeof raw.lawNum !== 'string') {
      throw new Error(`favorites[${index}].lawNum が文字列ではありません。`);
    }
    if (typeof raw.lawType !== 'string') {
      throw new Error(`favorites[${index}].lawType が文字列ではありません。`);
    }
    if (!(raw.folderId === null || raw.folderId === undefined || isNonEmptyString(raw.folderId))) {
      throw new Error(`favorites[${index}].folderId が不正です。`);
    }
    if (raw.folderId && !folderIds.has(raw.folderId)) {
      throw new Error(`favorites[${index}].folderId が存在しないフォルダを参照しています。`);
    }
    if (!(raw.lastScrollTop === undefined || (Number.isFinite(raw.lastScrollTop) && raw.lastScrollTop >= 0))) {
      throw new Error(`favorites[${index}].lastScrollTop が不正です。`);
    }

    const favorite = {
      lawId: raw.lawId.trim(),
      lawName: raw.lawName.trim(),
      lawNum: raw.lawNum,
      lawType: raw.lawType,
      folderId: raw.folderId ? raw.folderId.trim() : null,
    };

    if (raw.lastScrollTop !== undefined) {
      favorite.lastScrollTop = Math.round(raw.lastScrollTop);
    }

    return favorite;
  }

  function sanitizeFolderRecord(raw, index) {
    if (!isPlainObject(raw)) {
      throw new Error(`favFolders[${index}] がオブジェクトではありません。`);
    }
    if (!isNonEmptyString(raw.id)) {
      throw new Error(`favFolders[${index}].id が不正です。`);
    }
    if (!isNonEmptyString(raw.name)) {
      throw new Error(`favFolders[${index}].name が不正です。`);
    }
    return {
      id: raw.id.trim(),
      name: raw.name.trim(),
    };
  }

  function sanitizeFolderCollapsed(raw, folderIds) {
    if (raw === undefined) return {};
    if (!isPlainObject(raw)) {
      throw new Error('folderCollapsed がオブジェクトではありません。');
    }

    const normalized = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key !== '__uncat__' && !folderIds.has(key)) {
        throw new Error(`folderCollapsed.${key} が存在しないフォルダを参照しています。`);
      }
      if (typeof value !== 'boolean') {
        throw new Error(`folderCollapsed.${key} が真偽値ではありません。`);
      }
      normalized[key] = value;
    }
    return normalized;
  }

  function validateFavoritesImport(raw) {
    if (!isPlainObject(raw)) {
      throw new Error('JSON のトップレベルがオブジェクトではありません。');
    }
    if (raw.type !== FAVORITES_EXPORT_TYPE) {
      throw new Error('この拡張機能のエクスポートファイルではありません。');
    }
    if (raw.version !== FAVORITES_EXPORT_VERSION) {
      throw new Error(`対応していないバージョンです: ${String(raw.version)}`);
    }
    if (!Array.isArray(raw.favorites)) {
      throw new Error('favorites が配列ではありません。');
    }
    if (!Array.isArray(raw.favFolders)) {
      throw new Error('favFolders が配列ではありません。');
    }
    if (raw.favorites.length > FAVORITES_MAX) {
      throw new Error(`favorites は最大 ${FAVORITES_MAX} 件までです。`);
    }

    const favFolders = raw.favFolders.map((folder, index) => sanitizeFolderRecord(folder, index));
    const folderIds = new Set();
    for (const folder of favFolders) {
      if (folderIds.has(folder.id)) {
        throw new Error(`favFolders に重複した id があります: ${folder.id}`);
      }
      folderIds.add(folder.id);
    }

    const favorites = raw.favorites.map((favorite, index) => sanitizeFavoriteRecord(favorite, index, folderIds));
    const lawIds = new Set();
    for (const favorite of favorites) {
      if (lawIds.has(favorite.lawId)) {
        throw new Error(`favorites に重複した lawId があります: ${favorite.lawId}`);
      }
      lawIds.add(favorite.lawId);
    }

    const folderCollapsed = sanitizeFolderCollapsed(raw.folderCollapsed, folderIds);
    const exportedAt = typeof raw.exportedAt === 'string' ? raw.exportedAt : '';

    return {
      type: FAVORITES_EXPORT_TYPE,
      version: FAVORITES_EXPORT_VERSION,
      exportedAt,
      favorites,
      favFolders,
      folderCollapsed,
    };
  }

  async function reloadLawTabsIfConfirmed() {
    const ok = window.confirm('設定を反映するため、開いている e-Gov 法令ページをリロードしますか？');
    if (!ok) return;
    const lawTabs = await chrome.tabs.query({ url: 'https://laws.e-gov.go.jp/law/*' });
    const allTabs = await chrome.tabs.query({});
    const viewerUrl = chrome.runtime.getURL('viewer.html');
    const viewerTabs = allTabs.filter((tab) => String(tab.url || '').startsWith(viewerUrl));
    const tabs = [...lawTabs, ...viewerTabs];
    const seen = new Set();
    for (const tab of tabs) {
      if (!tab.id || seen.has(tab.id)) continue;
      seen.add(tab.id);
      chrome.tabs.reload(tab.id);
    }
  }

  async function exportFavorites() {
    clearTransferStatus();
    setTransferSummary('');

    const {
      favorites = [],
      favFolders = [],
      folderCollapsed = {},
    } = await chrome.storage.local.get(['favorites', 'favFolders', 'folderCollapsed']);

    const payload = {
      type: FAVORITES_EXPORT_TYPE,
      version: FAVORITES_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      favorites: Array.isArray(favorites) ? favorites : [],
      favFolders: Array.isArray(favFolders) ? favFolders : [],
      folderCollapsed: isPlainObject(folderCollapsed) ? folderCollapsed : {},
    };

    downloadJson(`e-GovEnhancerFav-${formatDateForFileName()}.json`, `${JSON.stringify(payload, null, 2)}\n`);

    setTransferStatus('お気に入りを JSON でエクスポートしました。', 'success');
    setTransferSummary(buildExportSummary(payload));
  }

  async function importFavorites(file) {
    if (!file) return;

    clearTransferStatus();
    setTransferSummary('');

    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch (_) {
      setTransferStatus('JSON の読み込みに失敗しました。ファイルが壊れている可能性があります。', 'error');
      return;
    }

    let validated;
    try {
      validated = validateFavoritesImport(parsed);
    } catch (error) {
      setTransferStatus(`インポートできません: ${error.message}`, 'error');
      return;
    }

    const summary = buildExportSummary(validated);
    const ok = window.confirm(`お気に入りデータを置き換えますか？\n\n${summary}`);
    if (!ok) {
      setTransferStatus('インポートをキャンセルしました。', 'info');
      return;
    }

    await chrome.storage.local.set({
      favorites: validated.favorites,
      favFolders: validated.favFolders,
      folderCollapsed: validated.folderCollapsed,
    });

    setTransferStatus('お気に入りをインポートしました。', 'success');
    setTransferSummary(summary);
  }

  async function exportReferences() {
    clearReferencesTransferStatus();
    setReferencesTransferSummary('');

    const imported = await readImportedReferences();
    let payload;
    let summary;
    let sourceLabel;

    if (imported) {
      payload = imported.references;
      summary = {
        lawCount: imported.meta.lawCount,
        targetCount: imported.meta.targetCount,
        linkCount: imported.meta.linkCount,
      };
      sourceLabel = '読み込み済みデータ';
    } else {
      const response = await fetch(chrome.runtime.getURL('data/references.json'), { cache: 'force-cache' });
      if (!response.ok) throw new Error(`同梱データを読み込めませんでした: HTTP ${response.status}`);
      payload = await response.json();
      summary = countReferencesSummary(payload);
      sourceLabel = '同梱データ';
    }

    downloadJson(`e-GovEnhancerReferences-${formatDateForFileName()}.json`, `${JSON.stringify(payload)}\n`);

    setReferencesTransferStatus(`逆参照リンク用ファイルをエクスポートしました。`, 'success');
    setReferencesTransferSummary(`${sourceLabel} / ${buildReferencesSummary(summary)}`);
  }

  async function importReferences(file) {
    if (!file) return;

    clearReferencesTransferStatus();
    setReferencesTransferSummary('');
    setReferencesTransferStatus('JSON を読み込み、文法チェックを実行しています。', 'info');

    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (_) {
      setReferencesTransferStatus('JSON の読み込みに失敗しました。ファイルが壊れている可能性があります。', 'error');
      return;
    }

    let validated;
    try {
      validated = validateReferencesImport(parsed);
    } catch (error) {
      setReferencesTransferStatus(`読み込めません: ${error.message}`, 'error');
      return;
    }

    const summary = buildReferencesSummary(validated.summary);
    const ok = window.confirm(`逆参照リンク用データを取り込みますか？\n\n${summary}`);
    if (!ok) {
      setReferencesTransferStatus('読み込みをキャンセルしました。', 'info');
      return;
    }

    setReferencesTransferStatus('文法チェックに成功しました。拡張内へ保存しています。', 'info');
    await saveReferencesImport(validated, file);
    setReferencesTransferStatus('逆参照リンク用ファイルを読み込みました。', 'success');
    setReferencesTransferSummary(`${summary} / ${file.name || 'ファイル名なし'}`);
    runReloadLawTabs();
  }

  smoothToggle.addEventListener('change', () => {
    persistLocal({ scrollBehavior: smoothToggle.checked ? 'smooth' : 'instant' });
  });

  liteModeDefaultToggle.addEventListener('change', () => {
    persistLocal({ liteModeDefault: liteModeDefaultToggle.checked });
  });

  hideLawSidebarDefaultToggle.addEventListener('change', () => {
    persistLocal({ hideLawSidebarDefault: hideLawSidebarDefaultToggle.checked });
  });

  pinToastToggle.addEventListener('change', () => {
    persistLocal({ pinToastDefaultVisible: pinToastToggle.checked });
  });

  lawRefClickToggle.addEventListener('change', () => {
    persistLocal({ lawRefClickEnabled: lawRefClickToggle.checked });
    updateLawRefHoverPopupRow();
    runReloadLawTabs();
  });

  lawRefHoverPopupToggle.addEventListener('change', () => {
    persistLocal({ lawRefHoverPopup: lawRefHoverPopupToggle.checked });
    runReloadLawTabs();
  });

  lawRefOtherLawPopupToggle.addEventListener('change', () => {
    persistLocal({ lawRefOtherLawPopup: lawRefOtherLawPopupToggle.checked });
    runReloadLawTabs();
  });

  liteDefTooltipToggle.addEventListener('change', () => {
    persistLocal({ liteDefTooltipEnabled: liteDefTooltipToggle.checked });
    updateDefTooltipClickOnlyRow();
  });

  defTooltipClickOnlyToggle.addEventListener('change', () => {
    persistLocal({ defTooltipClickOnly: defTooltipClickOnlyToggle.checked });
  });

  externalReferencesAutoEnableToggle.addEventListener('change', () => {
    persistLocal({ externalReferencesAutoEnable: externalReferencesAutoEnableToggle.checked });
    runReloadLawTabs();
  });

  exportFavoritesBtn.addEventListener('click', () => {
    exportFavorites().catch((error) => {
      setTransferStatus(`エクスポートに失敗しました: ${error.message}`, 'error');
    });
  });

  importFavoritesBtn.addEventListener('click', () => {
    importFavoritesInput.value = '';
    importFavoritesInput.click();
  });

  importFavoritesInput.addEventListener('change', () => {
    const file = importFavoritesInput.files?.[0];
    importFavorites(file).catch((error) => {
      setTransferStatus(`インポートに失敗しました: ${error.message}`, 'error');
    });
  });

  exportReferencesBtn.addEventListener('click', () => {
    exportReferences().catch((error) => {
      setReferencesTransferStatus(`エクスポートに失敗しました: ${error.message}`, 'error');
    });
  });

  importReferencesBtn.addEventListener('click', () => {
    importReferencesInput.value = '';
    importReferencesInput.click();
  });

  importReferencesInput.addEventListener('change', () => {
    const file = importReferencesInput.files?.[0];
    importReferences(file).catch((error) => {
      setReferencesTransferStatus(`読み込みに失敗しました: ${error.message}`, 'error');
    });
  });

  try {
    const commands = await chrome.commands.getAll();
    const actionCommand = commands.find((c) => c.name === '_execute_action');
    const favoritesCommand = commands.find((c) => c.name === 'open_favorites_popup');
    const historyCommand = commands.find((c) => c.name === 'open_history_popup');
    const shortcutEl = document.getElementById('currentShortcut');
    const shortcutItems = [
      { label: '法令検索', command: actionCommand, fallback: 'Ctrl+Shift+E' },
      { label: 'お気に入り', command: favoritesCommand, fallback: 'Ctrl+Shift+F' },
      { label: '履歴', command: historyCommand, fallback: 'Ctrl+Shift+H' },
    ];

    shortcutEl.textContent = '';
    shortcutItems.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'shortcut-row';

      const label = document.createElement('span');
      label.className = 'shortcut-row-label';
      label.textContent = item.label;

      const key = document.createElement('span');
      key.className = 'shortcut-row-key';
      key.textContent = item.command?.shortcut || `未設定（既定: ${item.fallback}）`;
      if (!item.command?.shortcut) {
        key.classList.add('is-unset');
      }

      row.append(label, key);
      shortcutEl.append(row);
    });
  } catch (_) {
    document.getElementById('currentShortcut').textContent = '法令検索: Ctrl+Shift+E / お気に入り: Ctrl+Shift+F / 履歴: Ctrl+Shift+H';
  }

  document.getElementById('openShortcutsPageLink').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
});
