document.addEventListener('DOMContentLoaded', async () => {
  const googleDriveSyncCard = document.getElementById('googleDriveSyncCard');
  // 一般公開版ではGoogle Drive同期を停止し、manifestからidentity / alarms / OAuth関連設定も外している。
  // APIクォータ、プライバシー説明、認証運用を整えて再公開する場合は、background.jsの機能フラグと
  // manifestの権限・OAuth設定・Google APIホスト権限も併せて戻すこと。
  const GOOGLE_DRIVE_SYNC_OPTIONS_VISIBLE = false;
  googleDriveSyncCard.hidden = !GOOGLE_DRIVE_SYNC_OPTIONS_VISIBLE;

  const smoothToggle = document.getElementById('smoothScrollToggle');
  const liteModeDefaultToggle = document.getElementById('liteModeDefaultToggle');
  const hideLawSidebarDefaultToggle = document.getElementById('hideLawSidebarDefaultToggle');
  const textHighlightsEnabledToggle = document.getElementById('textHighlightsEnabledToggle');
  const lawRefClickToggle = document.getElementById('lawRefClickToggle');
  const lawRefHoverPopupToggle = document.getElementById('lawRefHoverPopupToggle');
  const lawRefHoverPopupRow = document.getElementById('lawRefHoverPopupRow');
  const lawRefOtherLawPopupToggle = document.getElementById('lawRefOtherLawPopupToggle');
  const lawRefOtherLawPopupRow = document.getElementById('lawRefOtherLawPopupRow');
  const liteDefTooltipToggle = document.getElementById('liteDefTooltipToggle');
  const defTooltipClickOnlyToggle = document.getElementById('defTooltipClickOnlyToggle');
  const defTooltipClickOnlyRow = document.getElementById('defTooltipClickOnlyRow');
  const externalReferencesAutoEnableToggle = document.getElementById('externalReferencesAutoEnableToggle');
  const reverseReferenceScopeSelect = document.getElementById('reverseReferenceScopeSelect');
  const googleDriveFavoritesSyncToggle = document.getElementById('googleDriveFavoritesSyncToggle');
  const googleDriveFavoritesSyncDetails = document.getElementById('googleDriveFavoritesSyncDetails');
  const googleDriveSyncFavoritesToggle = document.getElementById('googleDriveSyncFavoritesToggle');
  const googleDriveSyncHighlightsToggle = document.getElementById('googleDriveSyncHighlightsToggle');
  const googleDriveFavoritesAccount = document.getElementById('googleDriveFavoritesAccount');
  const googleDriveFavoritesSyncNowBtn = document.getElementById('googleDriveFavoritesSyncNowBtn');
  const googleDriveFavoritesDisconnectBtn = document.getElementById('googleDriveFavoritesDisconnectBtn');
  const googleDriveFavoritesSyncStatus = document.getElementById('googleDriveFavoritesSyncStatus');
  const googleDriveFavoritesSyncSummary = document.getElementById('googleDriveFavoritesSyncSummary');
  const exportFavoritesBtn = document.getElementById('exportFavoritesBtn');
  const importFavoritesBtn = document.getElementById('importFavoritesBtn');
  const importFavoritesInput = document.getElementById('importFavoritesInput');
  const favoritesTransferStatus = document.getElementById('favoritesTransferStatus');
  const favoritesTransferSummary = document.getElementById('favoritesTransferSummary');
  const exportTextHighlightsBtn = document.getElementById('exportTextHighlightsBtn');
  const importTextHighlightsBtn = document.getElementById('importTextHighlightsBtn');
  const importTextHighlightsInput = document.getElementById('importTextHighlightsInput');
  const textHighlightsTransferStatus = document.getElementById('textHighlightsTransferStatus');
  const textHighlightsTransferSummary = document.getElementById('textHighlightsTransferSummary');
  const exportReferencesBtn = document.getElementById('exportReferencesBtn');
  const importReferencesBtn = document.getElementById('importReferencesBtn');
  const importReferencesInput = document.getElementById('importReferencesInput');
  const referencesTransferStatus = document.getElementById('referencesTransferStatus');
  const referencesTransferSummary = document.getElementById('referencesTransferSummary');

  const FAVORITES_EXPORT_TYPE = 'egov-extension-favorites';
  const FAVORITES_EXPORT_VERSION = 1;
  const GOOGLE_DRIVE_SYNC_KEYS = Object.freeze({
    enabled: 'googleDriveFavoritesSyncEnabled',
    accountEmail: 'googleDriveFavoritesAccountEmail',
    lastSyncAt: 'googleDriveFavoritesLastSyncAt',
    lastError: 'googleDriveFavoritesLastError',
    syncFavorites: 'googleDriveSyncFavoritesEnabled',
    syncHighlights: 'googleDriveSyncHighlightsEnabled',
  });
  const TEXT_HIGHLIGHTS_EXPORT_TYPE = 'egov-extension-text-highlights';
  const TEXT_HIGHLIGHTS_EXPORT_VERSION = 1;
  const TEXT_HIGHLIGHTS_STORAGE_PREFIX = 'textHighlights:v1:';
  const TEXT_HIGHLIGHTS_RECORD_LIMIT = 10000;
  const TEXT_HIGHLIGHTS_FILE_SIZE_LIMIT = 25 * 1024 * 1024;
  const TEXT_HIGHLIGHTS_COLORS = new Set(['yellow', 'pink', 'green']);
  const { FAVORITES_MAX, persistLocal: persistSharedLocal } = globalThis.EgovApp;
  const persistLocal = (items) => persistSharedLocal(items, { errorLabel: '設定の保存' });
  const {
    REFERENCES_CURRENT_META_KEY,
    REFERENCES_LAWS_STORE,
    REFERENCES_META_STORE,
    REVERSE_REFERENCE_SCOPE_KEY,
    formatProvisionSourcePathFromEgovUrl = () => '',
    idbRequest,
    isPlainObject,
    normalizeReverseReferenceScope,
    openReferencesDb,
    waitForTransaction,
  } = globalThis.EgovShared || {};

  smoothToggle.checked = false;
  liteModeDefaultToggle.checked = false;
  hideLawSidebarDefaultToggle.checked = false;
  textHighlightsEnabledToggle.checked = true;
  lawRefClickToggle.checked = true;
  lawRefHoverPopupToggle.checked = false;
  lawRefOtherLawPopupToggle.checked = true;
  liteDefTooltipToggle.checked = true;
  defTooltipClickOnlyToggle.checked = true;
  externalReferencesAutoEnableToggle.checked = false;
  reverseReferenceScopeSelect.value = 'both';

  chrome.storage.local.get([
    'scrollBehavior',
    'liteModeDefault',
    'hideLawSidebarDefault',
    'textHighlightsEnabled',
    'lawRefClickEnabled',
    'lawRefHoverPopup',
    'lawRefOtherLawPopup',
    'liteDefTooltipEnabled',
    'defTooltipClickOnly',
    'externalReferencesAutoEnable',
    REVERSE_REFERENCE_SCOPE_KEY,
    ...Object.values(GOOGLE_DRIVE_SYNC_KEYS),
  ]).then(({
    scrollBehavior,
    liteModeDefault,
    hideLawSidebarDefault,
    textHighlightsEnabled,
    lawRefClickEnabled,
    lawRefHoverPopup,
    lawRefOtherLawPopup,
    liteDefTooltipEnabled,
    defTooltipClickOnly,
    externalReferencesAutoEnable,
    reverseReferenceScope,
    googleDriveFavoritesSyncEnabled,
    googleDriveFavoritesAccountEmail,
    googleDriveFavoritesLastSyncAt,
    googleDriveFavoritesLastError,
    googleDriveSyncFavoritesEnabled,
    googleDriveSyncHighlightsEnabled,
  }) => {
    smoothToggle.checked = (scrollBehavior === 'smooth');
    liteModeDefaultToggle.checked = (typeof liteModeDefault === 'boolean') ? liteModeDefault : false;
    hideLawSidebarDefaultToggle.checked = (typeof hideLawSidebarDefault === 'boolean') ? hideLawSidebarDefault : false;
    textHighlightsEnabledToggle.checked = textHighlightsEnabled !== false;
    lawRefClickToggle.checked = (typeof lawRefClickEnabled === 'boolean') ? lawRefClickEnabled : true;
    lawRefHoverPopupToggle.checked = (typeof lawRefHoverPopup === 'boolean') ? lawRefHoverPopup : false;
    lawRefOtherLawPopupToggle.checked = (typeof lawRefOtherLawPopup === 'boolean') ? lawRefOtherLawPopup : true;
    liteDefTooltipToggle.checked = (typeof liteDefTooltipEnabled === 'boolean') ? liteDefTooltipEnabled : true;
    defTooltipClickOnlyToggle.checked = (typeof defTooltipClickOnly === 'boolean') ? defTooltipClickOnly : true;
    externalReferencesAutoEnableToggle.checked = (typeof externalReferencesAutoEnable === 'boolean') ? externalReferencesAutoEnable : false;
    reverseReferenceScopeSelect.value = normalizeReverseReferenceScope(reverseReferenceScope);
    renderGoogleDriveSyncState({
      enabled: googleDriveFavoritesSyncEnabled === true,
      accountEmail: googleDriveFavoritesAccountEmail || '',
      lastSyncAt: Number(googleDriveFavoritesLastSyncAt) || 0,
      lastError: googleDriveFavoritesLastError || '',
      syncFavorites: googleDriveSyncFavoritesEnabled !== false,
      syncHighlights: googleDriveSyncHighlightsEnabled !== false,
    });
    updateLawRefHoverPopupRow();
    updateDefTooltipClickOnlyRow();
  }).catch((error) => {
    console.warn('[e-Gov Enhancer] 設定の読み込みに失敗しました', error);
    renderGoogleDriveSyncState({
      enabled: false,
      accountEmail: '',
      lastSyncAt: 0,
      lastError: '',
      syncFavorites: true,
      syncHighlights: true,
    });
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
  const textHighlightsUi = createTransferUi(textHighlightsTransferStatus, textHighlightsTransferSummary);
  const referencesUi = createTransferUi(referencesTransferStatus, referencesTransferSummary);
  const googleDriveSyncUi = createTransferUi(googleDriveFavoritesSyncStatus, googleDriveFavoritesSyncSummary);

  const setTransferStatus = (message, tone) => favoritesUi.setStatus(message, tone);
  const clearTransferStatus = () => favoritesUi.clearStatus();
  const setTransferSummary = (message) => favoritesUi.setSummary(message);
  const setTextHighlightsTransferStatus = (message, tone) => textHighlightsUi.setStatus(message, tone);
  const clearTextHighlightsTransferStatus = () => textHighlightsUi.clearStatus();
  const setTextHighlightsTransferSummary = (message) => textHighlightsUi.setSummary(message);
  const setReferencesTransferStatus = (message, tone) => referencesUi.setStatus(message, tone);
  const clearReferencesTransferStatus = () => referencesUi.clearStatus();
  const setReferencesTransferSummary = (message) => referencesUi.setSummary(message);

  function formatGoogleDriveSyncTime(value) {
    if (!Number.isFinite(value) || value <= 0) return 'まだ同期していません';
    try {
      return `最終同期: ${new Intl.DateTimeFormat('ja-JP', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).format(new Date(value))}`;
    } catch (_) {
      return '同期済み';
    }
  }

  function renderGoogleDriveSyncState({
    enabled,
    accountEmail,
    lastSyncAt,
    lastError,
    syncFavorites = true,
    syncHighlights = true,
  }) {
    googleDriveFavoritesSyncToggle.checked = enabled === true;
    googleDriveFavoritesSyncDetails.classList.toggle('is-disabled', enabled !== true);
    googleDriveSyncFavoritesToggle.checked = syncFavorites !== false;
    googleDriveSyncHighlightsToggle.checked = syncHighlights !== false;
    googleDriveFavoritesAccount.textContent = accountEmail || (enabled ? 'Googleアカウント' : '未連携');
    googleDriveFavoritesSyncNowBtn.disabled = enabled !== true;
    googleDriveFavoritesDisconnectBtn.disabled = enabled !== true;
    googleDriveSyncUi.setSummary(enabled ? formatGoogleDriveSyncTime(Number(lastSyncAt) || 0) : '');
    if (lastError) googleDriveSyncUi.setStatus(lastError, 'error');
    else googleDriveSyncUi.clearStatus();
  }

  async function readGoogleDriveSyncState() {
    const stored = await chrome.storage.local.get(Object.values(GOOGLE_DRIVE_SYNC_KEYS));
    return {
      enabled: stored[GOOGLE_DRIVE_SYNC_KEYS.enabled] === true,
      accountEmail: String(stored[GOOGLE_DRIVE_SYNC_KEYS.accountEmail] || ''),
      lastSyncAt: Number(stored[GOOGLE_DRIVE_SYNC_KEYS.lastSyncAt]) || 0,
      lastError: String(stored[GOOGLE_DRIVE_SYNC_KEYS.lastError] || ''),
      syncFavorites: stored[GOOGLE_DRIVE_SYNC_KEYS.syncFavorites] !== false,
      syncHighlights: stored[GOOGLE_DRIVE_SYNC_KEYS.syncHighlights] !== false,
    };
  }

  async function refreshGoogleDriveSyncState() {
    renderGoogleDriveSyncState(await readGoogleDriveSyncState());
  }

  function setGoogleDriveSyncBusy(busy, message = '') {
    googleDriveFavoritesSyncToggle.disabled = busy;
    googleDriveSyncFavoritesToggle.disabled = busy;
    googleDriveSyncHighlightsToggle.disabled = busy;
    googleDriveFavoritesSyncNowBtn.disabled = busy || !googleDriveFavoritesSyncToggle.checked;
    googleDriveFavoritesDisconnectBtn.disabled = busy || !googleDriveFavoritesSyncToggle.checked;
    if (message) googleDriveSyncUi.setStatus(message, 'info');
  }

  async function sendGoogleDriveSyncMessage(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'Google Drive同期を完了できませんでした。');
    return response;
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

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
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
      await waitForTransaction(tx, {
        abortMessage: 'IndexedDB の処理が中断されました。',
        errorMessage: 'IndexedDB の処理に失敗しました。',
      });
    } finally {
      db.close();
    }
  }

  async function readImportedReferences() {
    const db = await openReferencesDb();
    try {
      const metaTx = db.transaction(REFERENCES_META_STORE, 'readonly');
      const meta = await idbRequest(
        metaTx.objectStore(REFERENCES_META_STORE).get(REFERENCES_CURRENT_META_KEY),
        'IndexedDB の読み込みに失敗しました。',
      );
      if (!meta) return null;

      const lawTx = db.transaction(REFERENCES_LAWS_STORE, 'readonly');
      const laws = await idbRequest(
        lawTx.objectStore(REFERENCES_LAWS_STORE).getAll(),
        'IndexedDB の読み込みに失敗しました。',
      );
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

  function isTextHighlightLawId(value) {
    return /^[0-9A-Z]{12,20}$/.test(String(value || ''));
  }

  function sanitizeTextHighlightRecord(raw, path) {
    if (!isPlainObject(raw)) throw new Error(`${path} がオブジェクトではありません。`);

    const id = String(raw.id || '');
    const color = String(raw.c || '');
    const anchorId = String(raw.a || '');
    const start = Number(raw.s);
    const end = Number(raw.e);
    const length = Number(raw.l);
    if (!id || id.length > 80) throw new Error(`${path}.id が不正です。`);
    if (!TEXT_HIGHLIGHTS_COLORS.has(color)) throw new Error(`${path}.c が不正です。`);
    if (!anchorId || anchorId.length > 500) throw new Error(`${path}.a が不正です。`);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(length) ||
        start < 0 || end <= start || length <= 0) {
      throw new Error(`${path} の範囲情報が不正です。`);
    }
    const stringFields = [
      ['h', 120, false], ['k', 100, false], ['q', 256, true], ['z', 128, false],
      ['p', 32, false], ['n', 32, false], ['m', 2000, false],
    ];
    for (const [field, maxLength, required] of stringFields) {
      if (typeof raw[field] !== 'string' || (required && !raw[field]) || raw[field].length > maxLength) {
        throw new Error(`${path}.${field} が不正です。`);
      }
    }
    if (!Number.isFinite(raw.t) || raw.t < 0) throw new Error(`${path}.t が不正です。`);
    const hasPortableRange = raw.u !== undefined || raw.v !== undefined || raw.x !== undefined ||
      raw.y !== undefined || raw.f !== undefined;
    if (!hasPortableRange ||
        typeof raw.u !== 'string' || !raw.u || raw.u.length > 120 ||
         typeof raw.v !== 'string' || !raw.v || raw.v.length > 120 ||
         !Number.isSafeInteger(raw.x) || raw.x < 0 ||
         !Number.isSafeInteger(raw.y) || raw.y <= 0 ||
         raw.f !== 2 ||
         !(raw.w === undefined || (typeof raw.w === 'string' && raw.w.length <= 32))) {
      throw new Error(`${path} のモード共有用範囲情報が不正です。`);
    }

    const sanitized = {
      id,
      c: color,
      a: anchorId,
      h: raw.h,
      k: raw.k,
      s: start,
      e: end,
      l: length,
      q: raw.q,
      z: raw.z,
      p: raw.p,
      n: raw.n,
      m: raw.m,
      t: raw.t,
    };
    if (hasPortableRange) {
      sanitized.u = raw.u;
      sanitized.v = raw.v;
      sanitized.x = raw.x;
      sanitized.y = raw.y;
      sanitized.f = 2;
      if (raw.w) sanitized.w = raw.w;
    }
    return sanitized;
  }

  function validateTextHighlightsImport(raw) {
    if (!isPlainObject(raw)) throw new Error('JSON のトップレベルがオブジェクトではありません。');
    if (raw.type !== TEXT_HIGHLIGHTS_EXPORT_TYPE) {
      throw new Error('メモとハイライトのエクスポートファイルではありません。');
    }
    if (raw.version !== TEXT_HIGHLIGHTS_EXPORT_VERSION) {
      throw new Error(`対応していないバージョンです: ${String(raw.version)}`);
    }
    if (!isPlainObject(raw.laws)) throw new Error('laws がオブジェクトではありません。');

    const laws = {};
    let highlightCount = 0;
    let memoCount = 0;
    for (const [lawId, rawRecords] of Object.entries(raw.laws)) {
      if (!isTextHighlightLawId(lawId)) throw new Error(`法令IDが不正です: ${lawId}`);
      if (!Array.isArray(rawRecords)) throw new Error(`laws.${lawId} が配列ではありません。`);
      if (rawRecords.length > TEXT_HIGHLIGHTS_RECORD_LIMIT) {
        throw new Error(`${lawId} のハイライトは最大 ${TEXT_HIGHLIGHTS_RECORD_LIMIT} 件までです。`);
      }
      const ids = new Set();
      const records = rawRecords.map((record, index) => {
        const sanitized = sanitizeTextHighlightRecord(record, `laws.${lawId}[${index}]`);
        if (ids.has(sanitized.id)) throw new Error(`${lawId} に重複したハイライトIDがあります。`);
        ids.add(sanitized.id);
        if (sanitized.m) memoCount += 1;
        return sanitized;
      });
      if (records.length) laws[lawId] = records;
      highlightCount += records.length;
    }

    return {
      type: TEXT_HIGHLIGHTS_EXPORT_TYPE,
      version: TEXT_HIGHLIGHTS_EXPORT_VERSION,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      laws,
      summary: { lawCount: Object.keys(laws).length, highlightCount, memoCount },
    };
  }

  function buildTextHighlightsSummary(summary = {}) {
    return [
      `法令 ${summary.lawCount || 0} 件`,
      `ハイライト ${summary.highlightCount || 0} 件`,
      `メモ ${summary.memoCount || 0} 件`,
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
    if (!(raw.lastArticleKey === undefined || isNonEmptyString(raw.lastArticleKey))) {
      throw new Error(`favorites[${index}].lastArticleKey が不正です。`);
    }
    if (!(raw.lastArticleOffset === undefined ||
      (Number.isFinite(raw.lastArticleOffset) && raw.lastArticleOffset >= 0 && raw.lastArticleOffset <= 1))) {
      throw new Error(`favorites[${index}].lastArticleOffset が不正です。`);
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
    if (raw.lastArticleKey !== undefined) {
      favorite.lastArticleKey = raw.lastArticleKey.trim();
      favorite.lastArticleOffset = raw.lastArticleOffset === undefined ? 0 : raw.lastArticleOffset;
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

  async function exportTextHighlights() {
    clearTextHighlightsTransferStatus();
    setTextHighlightsTransferSummary('');

    const stored = await chrome.storage.local.get(null);
    const laws = {};
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(TEXT_HIGHLIGHTS_STORAGE_PREFIX) || !Array.isArray(value) || !value.length) continue;
      const lawId = key.slice(TEXT_HIGHLIGHTS_STORAGE_PREFIX.length);
      if (isTextHighlightLawId(lawId)) laws[lawId] = value;
    }
    const payload = validateTextHighlightsImport({
      type: TEXT_HIGHLIGHTS_EXPORT_TYPE,
      version: TEXT_HIGHLIGHTS_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      laws,
    });
    const exportPayload = {
      type: payload.type,
      version: payload.version,
      exportedAt: payload.exportedAt,
      laws: payload.laws,
    };

    downloadJson(
      `e-GovEnhancerHighlightsMemos-${formatDateForFileName()}.json`,
      `${JSON.stringify(exportPayload, null, 2)}\n`,
    );
    setTextHighlightsTransferStatus('メモとハイライトを JSON で保存しました。', 'success');
    setTextHighlightsTransferSummary(buildTextHighlightsSummary(payload.summary));
  }

  async function importTextHighlights(file) {
    if (!file) return;

    clearTextHighlightsTransferStatus();
    setTextHighlightsTransferSummary('');
    if (file.size > TEXT_HIGHLIGHTS_FILE_SIZE_LIMIT) {
      setTextHighlightsTransferStatus('読み込めません: ファイルサイズは25MBまでです。', 'error');
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (_) {
      setTextHighlightsTransferStatus('JSON の読み込みに失敗しました。ファイルが壊れている可能性があります。', 'error');
      return;
    }

    let validated;
    try {
      validated = validateTextHighlightsImport(parsed);
    } catch (error) {
      setTextHighlightsTransferStatus(`読み込めません: ${error.message}`, 'error');
      return;
    }

    const summary = buildTextHighlightsSummary(validated.summary);
    const ok = window.confirm(`現在のメモとハイライトを、読み込んだ内容に置き換えますか？\n\n${summary}`);
    if (!ok) {
      setTextHighlightsTransferStatus('読み込みをキャンセルしました。', 'info');
      return;
    }

    const current = await chrome.storage.local.get(null);
    const currentKeys = Object.keys(current).filter((key) => key.startsWith(TEXT_HIGHLIGHTS_STORAGE_PREFIX));
    const importedItems = {};
    for (const [lawId, records] of Object.entries(validated.laws)) {
      importedItems[`${TEXT_HIGHLIGHTS_STORAGE_PREFIX}${lawId}`] = records;
    }
    const importedKeys = new Set(Object.keys(importedItems));
    if (importedKeys.size) await chrome.storage.local.set(importedItems);
    const obsoleteKeys = currentKeys.filter((key) => !importedKeys.has(key));
    if (obsoleteKeys.length) await chrome.storage.local.remove(obsoleteKeys);

    setTextHighlightsTransferStatus('メモとハイライトを読み込みました。', 'success');
    setTextHighlightsTransferSummary(summary);
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

  textHighlightsEnabledToggle.addEventListener('change', async () => {
    const saved = await persistLocal({ textHighlightsEnabled: textHighlightsEnabledToggle.checked });
    if (saved) runReloadLawTabs();
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

  reverseReferenceScopeSelect.addEventListener('change', async () => {
    const saved = await persistLocal({
      [REVERSE_REFERENCE_SCOPE_KEY]: normalizeReverseReferenceScope(reverseReferenceScopeSelect.value),
    });
    if (saved) runReloadLawTabs();
  });

  googleDriveFavoritesSyncToggle.addEventListener('change', async () => {
    const enabling = googleDriveFavoritesSyncToggle.checked;
    setGoogleDriveSyncBusy(true, enabling
      ? 'Googleアカウントを選択して、Driveへのアクセスを許可してください。'
      : 'Google Drive同期を停止しています。');
    try {
      await sendGoogleDriveSyncMessage({
        type: enabling
          ? 'egov-google-drive-favorites-enable'
          : 'egov-google-drive-favorites-disable',
      });
      await refreshGoogleDriveSyncState();
      if (enabling) googleDriveSyncUi.setStatus('Google Drive同期を有効にしました。', 'success');
    } catch (error) {
      googleDriveFavoritesSyncToggle.checked = !enabling;
      googleDriveSyncUi.setStatus(error.message, 'error');
      await refreshGoogleDriveSyncState().catch(() => {});
    } finally {
      setGoogleDriveSyncBusy(false);
    }
  });

  async function updateGoogleDriveCategory(toggle, storageKey, label) {
    const enabled = toggle.checked;
    setGoogleDriveSyncBusy(true, `${label}の同期設定を更新しています。`);
    try {
      await chrome.storage.local.set({ [storageKey]: enabled });
      if (enabled) {
        await sendGoogleDriveSyncMessage({ type: 'egov-google-drive-favorites-sync-now' });
      }
      await refreshGoogleDriveSyncState();
      googleDriveSyncUi.setStatus(`${label}の同期を${enabled ? '有効' : '無効'}にしました。`, 'success');
    } catch (error) {
      toggle.checked = !enabled;
      googleDriveSyncUi.setStatus(error.message, 'error');
      await refreshGoogleDriveSyncState().catch(() => {});
    } finally {
      setGoogleDriveSyncBusy(false);
    }
  }

  googleDriveSyncFavoritesToggle.addEventListener('change', () => {
    updateGoogleDriveCategory(
      googleDriveSyncFavoritesToggle,
      GOOGLE_DRIVE_SYNC_KEYS.syncFavorites,
      'お気に入り／条文ブックマーク',
    );
  });

  googleDriveSyncHighlightsToggle.addEventListener('change', () => {
    updateGoogleDriveCategory(
      googleDriveSyncHighlightsToggle,
      GOOGLE_DRIVE_SYNC_KEYS.syncHighlights,
      'ハイライト／メモ',
    );
  });

  googleDriveFavoritesSyncNowBtn.addEventListener('click', async () => {
    setGoogleDriveSyncBusy(true, 'Google Driveと同期しています。');
    try {
      const result = await sendGoogleDriveSyncMessage({ type: 'egov-google-drive-favorites-sync-now' });
      await refreshGoogleDriveSyncState();
      const summary = [];
      if (googleDriveSyncFavoritesToggle.checked) {
        summary.push(`お気に入り ${result.favoriteCount || 0} 件`, `条文ブックマーク ${result.bookmarkCount || 0} 件`);
      }
      if (googleDriveSyncHighlightsToggle.checked) {
        summary.push(`ハイライト ${result.highlightCount || 0} 件`, `メモ ${result.memoCount || 0} 件`);
      }
      googleDriveSyncUi.setStatus(`同期しました${summary.length ? `（${summary.join(' / ')}）` : ''}。`, 'success');
    } catch (error) {
      googleDriveSyncUi.setStatus(error.message, 'error');
    } finally {
      setGoogleDriveSyncBusy(false);
    }
  });

  googleDriveFavoritesDisconnectBtn.addEventListener('click', async () => {
    const confirmed = window.confirm(
      'Google Driveとの認証を解除しますか？\n\n端末上とGoogle Drive上のお気に入り、条文ブックマーク、ハイライト、メモは削除されません。',
    );
    if (!confirmed) return;
    setGoogleDriveSyncBusy(true, 'Google Driveとの認証を解除しています。');
    try {
      await sendGoogleDriveSyncMessage({ type: 'egov-google-drive-favorites-disable' });
      await refreshGoogleDriveSyncState();
    } catch (error) {
      googleDriveSyncUi.setStatus(error.message, 'error');
      await refreshGoogleDriveSyncState().catch(() => {});
    } finally {
      setGoogleDriveSyncBusy(false);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.values(GOOGLE_DRIVE_SYNC_KEYS).some((key) => changes[key])) return;
    refreshGoogleDriveSyncState().catch(() => {});
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

  exportTextHighlightsBtn.addEventListener('click', () => {
    exportTextHighlights().catch((error) => {
      setTextHighlightsTransferStatus(`保存に失敗しました: ${error.message}`, 'error');
    });
  });

  importTextHighlightsBtn.addEventListener('click', () => {
    importTextHighlightsInput.value = '';
    importTextHighlightsInput.click();
  });

  importTextHighlightsInput.addEventListener('change', () => {
    const file = importTextHighlightsInput.files?.[0];
    importTextHighlights(file).catch((error) => {
      setTextHighlightsTransferStatus(`読み込みに失敗しました: ${error.message}`, 'error');
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
  const manualLink = document.getElementById('openManualPageLink');
  if (manualLink) {
    manualLink.href = chrome.runtime.getURL('docs/user-manual.html');
    manualLink.addEventListener('click', (event) => {
      event.preventDefault();
      chrome.tabs.create({ url: manualLink.href });
    });
    document.addEventListener('keydown', (event) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'm' || event.key === 'M')) {
        event.preventDefault();
        chrome.tabs.create({ url: manualLink.href });
      }
    });
  }
});
