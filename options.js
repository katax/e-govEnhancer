document.addEventListener('DOMContentLoaded', async () => {
  const smoothToggle = document.getElementById('smoothScrollToggle');
  const pinToastToggle = document.getElementById('pinToastToggle');
  const lawRefClickToggle = document.getElementById('lawRefClickToggle');
  const lawRefHoverPopupToggle = document.getElementById('lawRefHoverPopupToggle');
  const lawRefHoverPopupRow = document.getElementById('lawRefHoverPopupRow');
  const exportFavoritesBtn = document.getElementById('exportFavoritesBtn');
  const importFavoritesBtn = document.getElementById('importFavoritesBtn');
  const importFavoritesInput = document.getElementById('importFavoritesInput');
  const favoritesTransferStatus = document.getElementById('favoritesTransferStatus');
  const favoritesTransferSummary = document.getElementById('favoritesTransferSummary');

  const FAVORITES_EXPORT_TYPE = 'egov-extension-favorites';
  const FAVORITES_EXPORT_VERSION = 1;
  const FAVORITES_MAX = 50;

  const {
    scrollBehavior,
    pinToastDefaultVisible,
    lawRefClickEnabled,
    lawRefHoverPopup,
  } = await chrome.storage.local.get([
    'scrollBehavior',
    'pinToastDefaultVisible',
    'lawRefClickEnabled',
    'lawRefHoverPopup',
  ]);

  smoothToggle.checked = (scrollBehavior === 'smooth');
  pinToastToggle.checked = (typeof pinToastDefaultVisible === 'boolean') ? pinToastDefaultVisible : true;
  lawRefClickToggle.checked = (typeof lawRefClickEnabled === 'boolean') ? lawRefClickEnabled : true;
  lawRefHoverPopupToggle.checked = (typeof lawRefHoverPopup === 'boolean') ? lawRefHoverPopup : false;

  function updateLawRefHoverPopupRow() {
    lawRefHoverPopupRow.classList.toggle('is-disabled', !lawRefClickToggle.checked);
  }

  function setTransferStatus(message, tone = 'info') {
    favoritesTransferStatus.textContent = message;
    favoritesTransferStatus.className = `backup-status is-visible is-${tone}`;
  }

  function clearTransferStatus() {
    favoritesTransferStatus.textContent = '';
    favoritesTransferStatus.className = 'backup-status';
  }

  function setTransferSummary(message = '') {
    favoritesTransferSummary.textContent = message;
    favoritesTransferSummary.classList.toggle('is-visible', !!message);
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
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
    const tabs = await chrome.tabs.query({ url: 'https://laws.e-gov.go.jp/law/*' });
    for (const tab of tabs) chrome.tabs.reload(tab.id);
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

    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `e-GovEnhancerFav-${formatDateForFileName()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);

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

  updateLawRefHoverPopupRow();

  smoothToggle.addEventListener('change', () => {
    chrome.storage.local.set({ scrollBehavior: smoothToggle.checked ? 'smooth' : 'instant' });
  });

  pinToastToggle.addEventListener('change', () => {
    chrome.storage.local.set({ pinToastDefaultVisible: pinToastToggle.checked });
  });

  lawRefClickToggle.addEventListener('change', () => {
    chrome.storage.local.set({ lawRefClickEnabled: lawRefClickToggle.checked });
    updateLawRefHoverPopupRow();
    reloadLawTabsIfConfirmed();
  });

  lawRefHoverPopupToggle.addEventListener('change', () => {
    chrome.storage.local.set({ lawRefHoverPopup: lawRefHoverPopupToggle.checked });
    reloadLawTabsIfConfirmed();
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

  try {
    const commands = await chrome.commands.getAll();
    const actionCommand = commands.find((c) => c.name === '_execute_action');
    const favoritesCommand = commands.find((c) => c.name === 'open_favorites_popup');
    const historyCommand = commands.find((c) => c.name === 'open_history_popup');
    const shortcutEl = document.getElementById('currentShortcut');
    const shortcutSummary = [
      actionCommand?.shortcut || 'Ctrl+Shift+E',
      favoritesCommand?.shortcut || 'Ctrl+Shift+F',
      historyCommand?.shortcut || 'Ctrl+Shift+H',
    ].join(' / ');

    if (actionCommand && actionCommand.shortcut) {
      shortcutEl.textContent = shortcutSummary;
    } else {
      shortcutEl.textContent = '未設定です。Chrome の設定から変更してください。';
      shortcutEl.style.background = '#fff3e0';
      shortcutEl.style.color = '#e65100';
    }
  } catch (_) {
    document.getElementById('currentShortcut').textContent = 'Ctrl+Shift+E / Ctrl+Shift+F / Ctrl+Shift+H';
  }

  document.getElementById('openShortcutsPageLink').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
});
