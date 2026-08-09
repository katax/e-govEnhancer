(function (global) {
  'use strict';

  const STORAGE_KEYS = Object.freeze({
    favorites: 'favorites',
    favoriteFolders: 'favFolders',
    folderCollapsed: 'folderCollapsed',
    queryHistory: 'queryHistory',
    openedLawHistory: 'openedLawHistory',
    scrollBehavior: 'scrollBehavior',
    liteModeDefault: 'liteModeDefault',
  });
  const FAVORITES_MAX = 50;

  function runWhenIdle(callback, timeout = 1500) {
    if (typeof global.requestIdleCallback === 'function') {
      global.requestIdleCallback(callback, { timeout });
      return;
    }
    global.setTimeout(callback, Math.min(timeout, 250));
  }

  function pushHistory(history, value, maxLength) {
    if (!value || !Array.isArray(history)) return;
    const index = history.indexOf(value);
    if (index !== -1) history.splice(index, 1);
    history.unshift(value);
    if (Number.isInteger(maxLength) && maxLength >= 0 && history.length > maxLength) {
      history.length = maxLength;
    }
  }

  function persistLocal(items, {
    storage = global.chrome?.storage?.local,
    errorLabel = '保存',
  } = {}) {
    if (!storage?.set) return Promise.resolve(false);
    return storage.set(items)
      .then(() => true)
      .catch((error) => {
        console.warn(`[e-Gov Enhancer] ${errorLabel}に失敗しました`, error);
        return false;
      });
  }

  async function readFavorites(storage = global.chrome?.storage?.local) {
    if (!storage?.get) return [];
    try {
      const data = await storage.get([STORAGE_KEYS.favorites]);
      return Array.isArray(data?.[STORAGE_KEYS.favorites]) ? data[STORAGE_KEYS.favorites] : [];
    } catch (_) {
      return [];
    }
  }

  function toggleFavoriteRecord(favorites, record, maxLength = FAVORITES_MAX) {
    const list = Array.isArray(favorites) ? favorites : [];
    const lawId = record?.lawId || '';
    if (!lawId) return { favorites: list, isFavorite: false, changed: false };
    const index = list.findIndex((favorite) => favorite?.lawId === lawId);
    if (index !== -1) {
      list.splice(index, 1);
      return { favorites: list, isFavorite: false, changed: true };
    }
    list.unshift(record);
    if (list.length > maxLength) list.length = maxLength;
    return { favorites: list, isFavorite: true, changed: true };
  }

  function createFavoritesStore({ storage = global.chrome?.storage?.local } = {}) {
    let cache = null;
    let pendingRead = null;
    return Object.freeze({
      replace(favorites) {
        cache = Array.isArray(favorites) ? favorites : [];
        return cache;
      },
      async get() {
        if (Array.isArray(cache)) return cache;
        if (!pendingRead) {
          pendingRead = readFavorites(storage)
            .then((favorites) => {
              cache = favorites;
              pendingRead = null;
              return cache;
            })
            .catch(() => {
              cache = [];
              pendingRead = null;
              return cache;
            });
        }
        return pendingRead;
      },
      async save() {
        if (!Array.isArray(cache)) return false;
        return persistLocal(
          { [STORAGE_KEYS.favorites]: cache },
          { storage, errorLabel: 'お気に入りの保存' }
        );
      },
    });
  }

  function formatReferenceBranchLabel(value, unit) {
    const [number, ...branches] = String(value || '').split(/[-_]/).filter(Boolean);
    if (!number) return '';
    return `第${number}${unit}${branches.map((branch) => `の${branch}`).join('')}`;
  }

  function getReferenceTargetLabel(targetKey) {
    const raw = String(targetKey || '');
    const scopeSeparator = raw.indexOf('::');
    const scope = scopeSeparator >= 0 ? raw.slice(0, scopeSeparator) : '';
    const provision = scopeSeparator >= 0 ? raw.slice(scopeSeparator + 2) : raw;
    const [article = '', paragraph = '', item = ''] = provision.split('.');
    if (!article) return String(targetKey || '');
    let label = scope ? '附則' : '';
    label += formatReferenceBranchLabel(article, '条');
    if (paragraph) label += formatReferenceBranchLabel(paragraph, '項');
    if (item) label += formatReferenceBranchLabel(item, '号');
    return label;
  }

  function positionFixedPopup(popup, point, { offset = 10, margin = 10 } = {}) {
    const rect = popup.getBoundingClientRect();
    const x = Math.min(
      Math.max(margin, (point?.x ?? global.innerWidth / 2) + offset),
      Math.max(margin, global.innerWidth - rect.width - margin)
    );
    const y = Math.min(
      Math.max(margin, (point?.y ?? global.innerHeight / 2) + offset),
      Math.max(margin, global.innerHeight - rect.height - margin)
    );
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
  }

  function createReferencePopup({
    targetKey,
    sources,
    currentLawTitle,
    classPrefix,
    point,
    sortSources,
    escapeHtml,
    getSourceLabel,
    getLinkModeText,
    initialCtrlKey = false,
    onOpen,
    onClose,
  }) {
    const list = Array.isArray(sources) ? sources : [];
    if (!list.length) return null;
    const rows = sortSources(list, currentLawTitle, targetKey);
    const popup = global.document.createElement('div');
    popup.className = `${classPrefix}-reference-popup`;
    popup.setAttribute('role', 'dialog');
    popup.innerHTML = `
      <div class="${classPrefix}-reference-popup-head">
        <div class="${classPrefix}-reference-target">
          <span class="${classPrefix}-reference-mode"></span>
          <span class="${classPrefix}-reference-mode-note"></span>
        </div>
        <button type="button" class="${classPrefix}-reference-close" aria-label="閉じる">×</button>
      </div>
      <div class="${classPrefix}-reference-list">
        ${rows.map((row, index) => `
          <button type="button" class="${classPrefix}-reference-link${row.isInternal ? ` ${classPrefix}-reference-link-internal` : row.isRelated ? ` ${classPrefix}-reference-link-related` : ''}" data-index="${index}">
            <span class="${classPrefix}-reference-related-badge">${row.isInternal ? '同一法令' : row.isRelated ? '関連' : ''}</span>
            ${row.isSameArticle ? `<span class="${classPrefix}-reference-related-badge ${classPrefix}-reference-same-article-badge">同一条文</span>` : ''}
            ${row.isInternal ? `
              <span class="${classPrefix}-reference-link-title">
                <span class="${classPrefix}-reference-link-provision">${escapeHtml(row.source?.sourceProvisionLabel || '')}</span>
                <span class="${classPrefix}-reference-link-body">${escapeHtml(row.source?.sourceProvisionText || '')}</span>
              </span>
            ` : `<span class="${classPrefix}-reference-link-title">${escapeHtml(getSourceLabel(row.source))}</span>`}
          </button>
        `).join('')}
      </div>
    `;
    global.document.body.appendChild(popup);
    const mode = popup.querySelector(`.${classPrefix}-reference-mode`);
    const modeNote = popup.querySelector(`.${classPrefix}-reference-mode-note`);
    let ctrlPressed = initialCtrlKey === true;
    const updateMode = () => {
      if (!mode || typeof getLinkModeText !== 'function') return;
      mode.textContent = getLinkModeText(ctrlPressed);
      if (modeNote) {
        modeNote.textContent = ctrlPressed
          ? '（一時的にモード切り替え中）'
          : '（Ctrlで一時切り替え）';
        modeNote.classList.toggle(`${classPrefix}-reference-mode-note-active`, ctrlPressed);
      }
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Control' || ctrlPressed) return;
      ctrlPressed = true;
      updateMode();
    };
    const onKeyUp = (event) => {
      if (event.key !== 'Control' || !ctrlPressed) return;
      ctrlPressed = false;
      updateMode();
    };
    const onWindowBlur = () => {
      if (!ctrlPressed) return;
      ctrlPressed = false;
      updateMode();
    };
    updateMode();
    if (mode) {
      global.addEventListener('keydown', onKeyDown);
      global.addEventListener('keyup', onKeyUp);
      global.addEventListener('blur', onWindowBlur);
      popup.cleanupReferencePopup = () => {
        global.removeEventListener('keydown', onKeyDown);
        global.removeEventListener('keyup', onKeyUp);
        global.removeEventListener('blur', onWindowBlur);
      };
    }
    positionFixedPopup(popup, point);
    popup.addEventListener('click', (event) => event.stopPropagation());
    popup.querySelector(`.${classPrefix}-reference-close`)?.addEventListener('click', onClose);
    popup.querySelectorAll(`.${classPrefix}-reference-link`).forEach((button) => {
      button.addEventListener('click', (event) => {
        onOpen(rows[Number(button.dataset.index)]?.source, event);
      });
    });
    return popup;
  }

  global.EgovApp = Object.freeze({
    FAVORITES_MAX,
    STORAGE_KEYS,
    createFavoritesStore,
    createReferencePopup,
    formatReferenceBranchLabel,
    getReferenceTargetLabel,
    persistLocal,
    positionFixedPopup,
    pushHistory,
    readFavorites,
    runWhenIdle,
    toggleFavoriteRecord,
  });
})(globalThis);
