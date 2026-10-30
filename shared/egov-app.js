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

  function isShortcutQuery(value) {
    return typeof value === 'string' && /^[A-Za-z0-9]+$/.test(value);
  }

  function normalizeLawShortcut(value) {
    if (value === '') return '';
    if (!isShortcutQuery(value) || value.length > 5) {
      throw new Error('ショートカットは半角英数字1〜5文字で入力してください。');
    }
    return value.toUpperCase();
  }

  function findShortcutFavorite(favorites, value) {
    if (!isShortcutQuery(value) || value.length > 5) return null;
    const code = value.toUpperCase();
    const matches = favorites.filter(favorite => typeof favorite.shortcut === 'string' && favorite.shortcut.toUpperCase() === code);
    // Do not open an arbitrary law if corrupt or older imported data contains duplicates.
    return matches.length === 1 ? matches[0] : null;
  }

  async function saveLawShortcut(lawId, value, storage = global.chrome.storage.local, { overwriteLawIds = [] } = {}) {
    const shortcut = normalizeLawShortcut(value);
    const { favorites = [] } = await storage.get(['favorites']);
    const favorite = favorites.find(item => item.lawId === lawId);
    if (!favorite) throw new Error('先にこの法令をお気に入りに追加してください。');
    const conflicts = shortcut ? favorites.filter(item => item.lawId !== lawId && typeof item.shortcut === 'string' && item.shortcut.toUpperCase() === shortcut) : [];
    if (conflicts.some(item => !overwriteLawIds.includes(item.lawId))) {
      const error = new Error(`「${shortcut}」は${conflicts.map(item => `「${item.lawName}」`).join('、')}で使用されています。上書きすると、元の法令の起動コードを解除して「${favorite.lawName}」に割り当てます。`);
      error.code = 'SHORTCUT_CONFLICT';
      error.conflicts = conflicts.map(item => ({ lawId: item.lawId, lawName: item.lawName }));
      throw error;
    }
    const updated = favorites.map(item => {
      if (conflicts.includes(item)) {
        const record = { ...item };
        delete record.shortcut;
        return record;
      }
      if (item.lawId !== lawId) return item;
      const record = { ...item };
      if (shortcut) record.shortcut = shortcut;
      else delete record.shortcut;
      return record;
    });
    await storage.set({ favorites: updated });
    return updated;
  }

  async function editLawShortcut(lawId, { onSaved } = {}) {
    if (document.getElementById('egov-law-shortcut-dialog')) return;
    const { favorites = [] } = await global.chrome.storage.local.get(['favorites']);
    const favorite = favorites.find(item => item.lawId === lawId);
    if (!favorite) throw new Error('先にこの法令をお気に入りに追加してください。');
    if (document.getElementById('egov-law-shortcut-dialog')) return;
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.id = 'egov-law-shortcut-dialog';
    dialog.className = 'shortcut-editor';
    dialog.setAttribute('aria-label', '法令起動ショートカットの設定');
    dialog.style.cssText = 'width:320px;max-width:85vw;padding:20px;border:1px solid #b6c6da;border-radius:10px;background:white;color:#172b45;font:14px/1.6 sans-serif;';
    const form = document.createElement('form');
    const header = document.createElement('div');
    header.className = 'shortcut-editor-header';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'shortcut-editor-eyebrow';
    eyebrow.textContent = 'お気に入り';
    const title = document.createElement('strong');
    title.className = 'shortcut-editor-title';
    title.textContent = '起動ショートカット';
    const lawName = document.createElement('p');
    lawName.className = 'shortcut-editor-law';
    lawName.textContent = favorite.lawName;
    header.append(eyebrow, title, lawName);
    const label = document.createElement('label');
    label.className = 'shortcut-editor-label';
    label.textContent = '起動ショートカット（半角英数字・最大5文字）';
    label.style.display = 'block';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = favorite.shortcut || '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-describedby', 'shortcut-editor-help shortcut-editor-error');
    input.style.cssText = 'box-sizing:border-box;width:100%;padding:8px;font:18px monospace;text-transform:uppercase;';
    const field = document.createElement('span');
    field.className = 'shortcut-editor-field';
    const count = document.createElement('span');
    count.className = 'shortcut-editor-count';
    count.textContent = `${input.value.length} / 5`;
    field.append(input, count);
    label.appendChild(field);
    const help = document.createElement('p');
    help.id = 'shortcut-editor-help';
    help.className = 'shortcut-editor-help';
    help.textContent = '大文字・小文字は区別しません。空欄で保存すると解除します。';
    const error = document.createElement('p');
    error.id = 'shortcut-editor-error';
    error.className = 'shortcut-editor-error';
    error.hidden = true;
    error.setAttribute('role', 'alert');
    error.style.color = '#b42318';
    const overwrite = document.createElement('button');
    overwrite.type = 'button';
    overwrite.className = 'shortcut-editor-overwrite';
    overwrite.textContent = '上書きして保存';
    overwrite.hidden = true;
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'shortcut-editor-save';
    save.textContent = '保存';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'shortcut-editor-cancel';
    cancel.textContent = 'キャンセル';
    for (const button of [save, cancel]) button.style.cssText = 'padding:6px 12px;margin-right:8px;cursor:pointer;';
    const body = document.createElement('div');
    body.className = 'shortcut-editor-body';
    body.append(label, help, error, overwrite);
    const actions = document.createElement('div');
    actions.className = 'shortcut-editor-actions';
    actions.append(cancel, save);
    form.append(header, body, actions);
    dialog.appendChild(form);
    // Keep page-level keyboard shortcuts away from this editor.
    let composing = false;
    let conflictCode = '';
    let conflictIds = [];
    input.addEventListener('input', () => {
      count.textContent = `${input.value.length} / 5`;
      error.hidden = true;
      overwrite.hidden = true;
      conflictCode = '';
      conflictIds = [];
      input.removeAttribute('aria-invalid');
    });
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; });
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter' && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
    });
    dialog.addEventListener('click', event => event.stopPropagation());
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
    });
    async function submitShortcut(replaceConflicts = false) {
      if (composing || save.disabled) return;
      save.disabled = true;
      overwrite.disabled = true;
      try {
        const overwriteLawIds = replaceConflicts && input.value === conflictCode ? conflictIds : [];
        const updated = await saveLawShortcut(lawId, input.value, global.chrome.storage.local, { overwriteLawIds });
        onSaved?.(updated);
        dialog.close();
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        if (failure.code === 'SHORTCUT_CONFLICT') {
          conflictCode = input.value;
          conflictIds = failure.conflicts.map(item => item.lawId);
          overwrite.hidden = false;
        }
        save.disabled = false;
        overwrite.disabled = false;
      }
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      submitShortcut();
    });
    overwrite.addEventListener('click', () => submitShortcut(true));
    document.body.appendChild(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  }

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
    isShortcutQuery,
    normalizeLawShortcut,
    findShortcutFavorite,
    saveLawShortcut,
    editLawShortcut,
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
