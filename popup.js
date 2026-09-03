document.addEventListener('DOMContentLoaded', () => {
  function syncPopupHeight() {
    const screenHeight = window.screen?.availHeight || window.screen?.height;
    if (!screenHeight) return;
    // Chrome extension popups have a practical max height around 600px.
    // Keep a little headroom so the browser itself does not add a scrollbar.
    const popupHeight = Math.max(240, Math.min(Math.floor(screenHeight * 0.8), 580));
    document.documentElement.style.setProperty('--popup-height', `${popupHeight}px`);
  }

  syncPopupHeight();
  window.addEventListener('resize', syncPopupHeight);

  const shared = globalThis.EgovShared;
  const app = globalThis.EgovApp;
  const {
    buildLawUrl,
    escapeHtml,
    formatLawNameHtml,
    getLawFields,
    searchLawsByTitle,
  } = shared;
  const {
    FAVORITES_MAX,
    persistLocal,
    toggleFavoriteRecord,
  } = app;
  const searchForm    = document.getElementById('searchForm');
  const searchInput   = document.getElementById('searchInput');
  const resultsEl     = document.getElementById('searchResults');
  const histPanelEl   = document.getElementById('historyPanel');
  const histListEl    = document.getElementById('historyList');
  const searchHintEl  = document.getElementById('searchHint');
  const liteModeTitleBadge = document.getElementById('liteModeTitleBadge');
  const favFolderBtn  = document.getElementById('favFolderBtn');
  const mode0NavLeft  = document.getElementById('mode0NavLeft');
  const mode0NavRight = document.getElementById('mode0NavRight');
  const modeLeftLabel = document.getElementById('modeLeftLabel');
  const modeCurrentLabel = document.getElementById('modeCurrentLabel');
  const modeRightLabel = document.getElementById('modeRightLabel');

  let debounceTimer      = null;
  let isComposing        = false;
  let currentResults     = [];
  let currentSearchQuery = '';
  let currentSearchHasMore = false;
  let focusedResultIndex = -1;
  let mainHoverEnabled   = true;
  let liteModeDefault    = false;
  let ctrlPressed        = false;

  const LOCAL_COURT_RULES = (globalThis.EgovCourtRuleCatalog?.rules || []).map((rule) => ({
    lawId: rule.id,
    lawName: rule.title,
    lawNum: rule.lawNum,
    lawType: rule.lawType || 'Rule',
    localRule: rule.slug,
    aliases: Array.isArray(rule.aliases) ? rule.aliases : [rule.title],
  }));
  const LOCAL_COURT_RULE_BY_ID = new Map(LOCAL_COURT_RULES.map((rule) => [rule.lawId, rule]));

  // 履歴・お気に入りデータ
  let queryHistory     = [];   // 検索クエリ履歴（文字列）
  let openedLawHistory = [];   // 開いた法令履歴（{lawId,lawName,lawNum,lawType}）
  let favorites        = [];   // お気に入り法令（{lawId,lawName,lawNum,lawType,folderId?}）
  let favFolders       = [];   // お気に入りフォルダ（{id,name}）
  const HIST_MAX = 30;
  const FAV_MAX  = FAVORITES_MAX;

  // パネル状態: null=Mode0, 'law'=Mode2, 'favorites'=Mode3
  let historyMode    = null;
  let histFocusedIdx = -1;
  let isEmptyState   = false; // 入力が空のとき検索履歴をインライン表示中

  // ツールチップ
  let tooltipTimer = null;
  const TOOLTIP_DELAY_MS = 2000;
  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'hist-item-tooltip';
  tooltipEl.style.display = 'none';
  document.body.appendChild(tooltipEl);
  let toastTimer = null;
  const toastEl = document.createElement('div');
  toastEl.className = 'popup-toast';
  toastEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastEl);

  function buildLiteViewerUrl(law) {
    const fields = getLawFields(law);
    const lawId = fields.lawId || law?.lawId || '';
    const lawName = fields.lawName || law?.lawName || '';
    if (!lawId) return '';
    const params = new URLSearchParams();
    const localRule = law?.localRule || LOCAL_COURT_RULE_BY_ID.get(lawId)?.localRule || '';
    if (localRule) {
      params.set('localRule', localRule);
      return chrome.runtime.getURL(`viewer.html?${params.toString()}`);
    }
    params.set('lawId', lawId);
    params.set('lawName', lawName || '');
    params.set('sourceUrl', buildLawUrl(lawId));
    return chrome.runtime.getURL(`viewer.html?${params.toString()}`);
  }

  function updateLiteModeTitleBadge() {
    if (!liteModeTitleBadge) return;
    liteModeTitleBadge.hidden = !shouldOpenLite(ctrlPressed);
  }

  function setCtrlPressed(value) {
    const next = value === true;
    if (ctrlPressed === next) return;
    ctrlPressed = next;
    updateLiteModeTitleBadge();
  }

  chrome.storage.local.get(['liteModeDefault'])
    .then(({ liteModeDefault: stored }) => {
      liteModeDefault = stored === true;
      updateLiteModeTitleBadge();
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.liteModeDefault) {
      liteModeDefault = changes.liteModeDefault.newValue === true;
      updateLiteModeTitleBadge();
    }
  });

  function shouldOpenLite(forceAlternate = false) {
    return forceAlternate ? !liteModeDefault : liteModeDefault;
  }

  function openLaw(law, { alternate = false } = {}) {
    const { lawId, lawName, lawNum, lawType } = getLawFields(law);
    if (!lawId) return false;
    pushOpenedLaw({ lawId, lawName, lawNum, lawType });
    const useLite = LOCAL_COURT_RULE_BY_ID.has(lawId) || shouldOpenLite(alternate);
    const url = useLite ? buildLiteViewerUrl(law) : buildLawUrl(lawId);
    if (!url) return false;
    chrome.tabs.create({ url });
    window.close();
    return true;
  }

  function showTooltip(el, name, num) {
    clearTimeout(tooltipTimer);
    tooltipEl.style.display = 'none';
    if (!name && !num) return;
    tooltipTimer = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      tooltipEl.innerHTML =
        (name ? `<div class="hist-tooltip-name">${formatLawNameHtml(name)}</div>` : '') +
        (num  ? `<div class="hist-tooltip-num">${escapeHtml(num)}</div>`  : '');
      tooltipEl.style.display = 'block';
      const th = tooltipEl.offsetHeight;
      let top = rect.bottom + 4;
      if (top + th > window.innerHeight - 4) top = rect.top - th - 4;
      tooltipEl.style.top  = Math.max(2, top) + 'px';
      tooltipEl.style.left = Math.max(2, Math.min(rect.left, window.innerWidth - 260)) + 'px';
    }, TOOLTIP_DELAY_MS);
  }

  function hideTooltip() {
    clearTimeout(tooltipTimer);
    tooltipEl.style.display = 'none';
  }

  function getModeMeta(mode) {
    const labels = {
      search: '検索',
      law: '法令履歴',
      favorites: 'お気に入り',
    };

    if (mode === 'law') {
      return { current: labels.law, left: null, right: labels.search };
    }
    if (mode === 'favorites') {
      return { current: labels.favorites, left: labels.search, right: null };
    }
    return { current: labels.search, left: labels.law, right: labels.favorites };
  }

  function syncModeHint(mode) {
    const meta = getModeMeta(mode);

    modeCurrentLabel.textContent = meta.current;

    modeLeftLabel.textContent = meta.left || '';
    modeLeftLabel.hidden = !meta.left;
    mode0NavLeft.hidden = !meta.left;
    mode0NavLeft.title = meta.left ? `${meta.left}へ` : '';

    modeRightLabel.textContent = meta.right || '';
    modeRightLabel.hidden = !meta.right;
    mode0NavRight.hidden = !meta.right;
    mode0NavRight.title = meta.right ? `${meta.right}へ` : '';
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.add('is-visible');
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('is-visible');
    }, 1800);
  }

  // 描画直後に検索入力へフォーカスを戻す（一覧再描画後の共通処理）
  function refocusSearchInput() {
    setTimeout(() => { searchInput.focus(); }, 0);
  }

  // 「e-Govで直接検索する」フォールバックリンクの共通配線
  function wireFallbackLink() {
    resultsEl.querySelector('.fallback-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: e.currentTarget.dataset.url });
      window.close();
    });
  }

  // ★／☆ お気に入りボタンの表示状態を更新する共通処理
  function applyFavButtonState(btn, isFav, activeClass, { shortcut = false } = {}) {
    if (!btn) return;
    btn.textContent = isFav ? '★' : '☆';
    btn.classList.toggle(activeClass, isFav);
    const suffix = shortcut ? ' (Shift+Enter)' : '';
    btn.title = (isFav ? 'お気に入りから削除' : 'お気に入りに追加') + suffix;
  }

  function isMainModeArrowKey(e) {
    return !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
      && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
  }

  function isEditableForModeSwitch(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function canSwitchModeFromSearch() {
    if (historyMode !== null) return true;

    const query = searchInput.value.trim();
    if (query.length === 0) return true;

    return focusedResultIndex >= 0;
  }

  function handleModeArrowNavigation(e) {
    if (!isMainModeArrowKey(e)) return false;

    const activeEl = document.activeElement;
    if (isEditableForModeSwitch(activeEl) && activeEl !== searchInput) return false;
    if (activeEl === searchInput) {
      const start = searchInput.selectionStart ?? 0;
      const end = searchInput.selectionEnd ?? start;
      if (start !== end) return false;
      if (e.key === 'ArrowLeft' && start !== 0) return false;
      if (e.key === 'ArrowRight' && end !== searchInput.value.length) return false;
    }

    if (historyMode === null) {
      if (!canSwitchModeFromSearch()) return false;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        showHistoryPanel('law');
        return true;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        showHistoryPanel('favorites');
        return true;
      }
      return false;
    }

    if (historyMode === 'law' && e.key === 'ArrowRight') {
      e.preventDefault();
      hideHistoryPanel();
      return true;
    }
    if (historyMode === 'favorites' && e.key === 'ArrowLeft') {
      e.preventDefault();
      hideHistoryPanel();
      return true;
    }

    return false;
  }

  // D&D 状態
  let dragFromArrayIdx = -1;
  let dragType         = '';   // 'item' | 'folder'
  let dragFolderIdx    = -1;

  // D&D オートスクロール
  let autoScrollRAF = null;
  function startAutoScroll(speed) {
    if (autoScrollRAF !== null) return;
    (function step() {
      histListEl.scrollTop += speed;
      autoScrollRAF = requestAnimationFrame(step);
    })();
  }
  function stopAutoScroll() {
    if (autoScrollRAF !== null) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
  }

  // dragend が発火しない場合（ウィンドウ外でドロップなど）の安全停止
  document.addEventListener('mouseup', () => {
    if (dragType) {
      stopAutoScroll();
      clearDropIndicators();
      dragType         = '';
      dragFolderIdx    = -1;
      dragFromArrayIdx = -1;
    }
  });

  // ================================================
  // UI ユーティリティ
  // ================================================

  // カーソルを一時的に非表示（描画直後のちらつき防止）
  // ※ render系関数で重複していたコードを統一
  function hideCursorBriefly() {
    mainHoverEnabled = false;
    document.documentElement.classList.add('keyboard-nav-hide-cursor');
    document.body.classList.add('keyboard-nav-hide-cursor');
    document.addEventListener('mousemove', () => {
      mainHoverEnabled = true;
      document.documentElement.classList.remove('keyboard-nav-hide-cursor');
      document.body.classList.remove('keyboard-nav-hide-cursor');
    }, { once: true, passive: true });
  }

  // ホバー有効フラグ（描画直後のマウスオーバー誤検知防止）
  // 返り値: () => boolean — true になったらホバー処理を実行してよい
  function makeHoverGuard(delay = 200) {
    let ready = false;
    setTimeout(() => { ready = true; }, delay);
    return () => ready;
  }

  // フォルダ折りたたみ状態 { folderId: true/false }
  let folderCollapsed = {};

  syncModeHint('search');
  setupFavoritesDnD();
  searchInput.focus();
  showEmptyState();

  // 初回表示をブロックしない。履歴とコマンド指定モードは描画後に反映する。
  loadHistories()
    .then(async () => {
      const { requestedPopupMode = '' } = await chrome.storage.session.get('requestedPopupMode').catch(() => ({ requestedPopupMode: '' }));
      const initialMode = requestedPopupMode === 'law' || requestedPopupMode === 'favorites'
        ? requestedPopupMode
        : null;
      chrome.storage.session.remove('requestedPopupMode').catch(() => {});
      if (initialMode) {
        showHistoryPanel(initialMode);
      } else if (historyMode === null && !searchInput.value.trim()) {
        showEmptyState();
      }
    })
    .catch(() => {});
  document.addEventListener('keydown', (e) => {
    setCtrlPressed(e.ctrlKey || e.key === 'Control');
  }, true);
  document.addEventListener('keyup', (e) => {
    setCtrlPressed(e.ctrlKey && e.key !== 'Control');
  }, true);
  window.addEventListener('blur', () => setCtrlPressed(false));
  document.addEventListener('keydown', (e) => {
    if (handleModeArrowNavigation(e)) e.stopPropagation();
  }, true);
  document.addEventListener('keydown', (e) => {
    const activeEl = document.activeElement;
    if (activeEl === searchInput) return;
    if (isEditableForModeSwitch(activeEl)) return;
    if (historyMode !== null) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace', 'Enter', 'Escape'].includes(e.key)) {
        handleHistoryKeydown(e);
      }
      return;
    }
    handleMainListKeydown(e);
  });

  // ================================================
  // IME変換確定後に検索
  // ================================================
  searchInput.addEventListener('compositionstart', () => {
    isComposing = true;
    if (historyMode !== null) hideHistoryPanel();
  });
  searchInput.addEventListener('compositionend', () => {
    isComposing = false;
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();
    if (query.length >= 1) doSearch(query);
  });

  // ================================================
  // 通常入力（IME非使用時・400msデバウンス）
  // ================================================
  searchInput.addEventListener('input', () => {
    if (historyMode !== null && searchInput.value.length > 0) {
      hideHistoryPanel();
    }
    if (isComposing) return;
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();
    if (query.length >= 2) {
      isEmptyState = false;
      debounceTimer = setTimeout(() => doSearch(query), 400);
    } else if (query.length === 0) {
      currentResults     = [];
      focusedResultIndex = -1;
      showEmptyState();
    } else {
      // 1文字: 検索しないが履歴も非表示
      isEmptyState       = false;
      resultsEl.innerHTML = '';
      currentResults     = [];
      focusedResultIndex = -1;
    }
  });

  // ================================================
  // キーボードナビゲーション（Mode0）
  // ================================================
  searchInput.addEventListener('keydown', (e) => {
    // 履歴パネル表示中はパネル内操作に委譲
    if (historyMode !== null) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideHistoryPanel();
        return;
      }
      if (!isComposing && ['Enter', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.stopPropagation();
        handleHistoryKeydown(e);
        return;
      }
      return;
    }
    if (handleMainListKeydown(e)) {
      e.stopPropagation();
      return;
    }
  });

  // ================================================
  // 履歴パネル内キー操作
  // ================================================
  function handleHistoryKeydown(e) {
    if (handleModeArrowNavigation(e)) return;

    e.preventDefault();

    if (e.key === 'ArrowUp')   { moveHistFocus(-1, getHistItemCount()); return; }
    if (e.key === 'ArrowDown') { moveHistFocus(+1, getHistItemCount()); return; }

    if (e.key === 'ArrowLeft') {
      if (historyMode === 'favorites') hideHistoryPanel();  // Mode3 → Mode0（閉じる）
      // Mode2: ◀ は非表示なので何もしない
      return;
    }
    if (e.key === 'ArrowRight' && historyMode === 'law') {
      hideHistoryPanel(); // Mode2 → Mode0（閉じる）
      return;
    }
    if (e.key === 'Delete' && e.ctrlKey) {
      deleteHistItem(getFocusedArrayIdx()); return;
    }
    if (e.key === 'Enter') {
      if (e.shiftKey && historyMode === 'law') {
        // Mode2: Shift+Enter でお気に入りトグル
        const idx = getFocusedArrayIdx();
        if (idx >= 0 && openedLawHistory[idx]) {
          toggleFavorite(openedLawHistory[idx]);
          // ★ボタン表示を更新
          const items = histListEl.querySelectorAll('.history-item');
          if (items[histFocusedIdx]) {
            const btn = items[histFocusedIdx].querySelector('.hist-fav-btn');
            applyFavButtonState(btn, isFavorite(openedLawHistory[idx].lawId), 'hist-fav-active');
          }
        }
        return;
      }
      selectHistItem(getFocusedArrayIdx(), { alternate: e.ctrlKey }); return;
    }
    if (e.key === 'Escape') { hideHistoryPanel(); return; }
  }

  function clearMainListFocus() {
    resultsEl.querySelectorAll('.result-item').forEach((el) => {
      el.classList.remove('result-item-focused');
    });
    focusedResultIndex = -1;
  }

  function clearHistoryListFocus() {
    histListEl.querySelectorAll('.history-item').forEach((el) => {
      el.classList.remove('history-item-focused');
    });
    histFocusedIdx = -1;
    hideTooltip();
  }

  function blurSearchInputForListSelection() {
    if (document.activeElement === searchInput) searchInput.blur();
  }

  function focusSearchInputFromList(kind) {
    if (kind === 'history') clearHistoryListFocus();
    else clearMainListFocus();
    searchInput.focus();
  }

  function handleMainListKeydown(e) {
    if (handleModeArrowNavigation(e)) return true;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(+1);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
      return true;
    }

    if (isEmptyState && e.key === 'Delete' && e.ctrlKey && focusedResultIndex >= 0) {
      e.preventDefault();
      queryHistory.splice(focusedResultIndex, 1);
      persistLocal({ queryHistory });
      const nextIdx = Math.min(focusedResultIndex, queryHistory.length - 1);
      showEmptyState();
      if (nextIdx >= 0) {
        const items = resultsEl.querySelectorAll('.result-item');
        items.forEach((el, i) => el.classList.toggle('result-item-focused', i === nextIdx));
        focusedResultIndex = nextIdx;
        blurSearchInputForListSelection();
      }
      return true;
    }

    if (e.key === 'Enter' && !isComposing) {
      e.preventDefault();
      if (isEmptyState && focusedResultIndex >= 0 && queryHistory[focusedResultIndex]) {
        const query = queryHistory[focusedResultIndex];
        isEmptyState = false;
        searchInput.value = query;
        doSearch(query);
      } else if (e.ctrlKey) {
        if (focusedResultIndex >= 0 && currentResults[focusedResultIndex]) {
          openResult(currentResults[focusedResultIndex], { alternate: true });
        }
      } else if (e.shiftKey) {
        if (focusedResultIndex >= 0 && currentResults[focusedResultIndex]) {
          const law = currentResults[focusedResultIndex];
          const { lawId } = getLawFields(law);
          toggleFavorite(law);
          showResults(currentResults, currentSearchQuery, currentSearchHasMore, lawId);
        }
      } else {
        if (focusedResultIndex >= 0 && currentResults[focusedResultIndex]) {
          openResult(currentResults[focusedResultIndex]);
        } else {
          const query = searchInput.value.trim();
          if (query) doSearch(query);
        }
      }
      return true;
    }

    return false;
  }

  // ================================================
  // 履歴配列取得・ナビゲーション補助
  // ================================================
  function getHistArray(mode) {
    if (mode === 'search')    return queryHistory;
    if (mode === 'law')       return openedLawHistory;
    if (mode === 'favorites') return favorites;
    return [];
  }

  // .history-item 要素数（favoriteではフォルダヘッダーを除く）
  function getHistItemCount() {
    return histListEl.querySelectorAll('.history-item').length;
  }

  // histFocusedIdx（DOM上のvisual index）から配列インデックスを取得
  function getFocusedArrayIdx() {
    const items = histListEl.querySelectorAll('.history-item');
    const el = items[histFocusedIdx];
    if (!el) return -1;
    return parseInt(el.dataset.idx ?? '-1');
  }

  // ================================================
  // 履歴パネル 表示・切替
  // ================================================
  function showHistoryPanel(mode) {
    hideTooltip();
    historyMode = mode;
    histFocusedIdx = -1;
    syncModeHint(mode);
    favFolderBtn.style.display = mode === 'favorites' ? '' : 'none';
    histListEl.innerHTML = '';

    if (mode === 'favorites') {
      renderFavoritesPanel();
    } else {
      renderHistList(mode);
    }

    histPanelEl.style.display = 'flex';
    searchHintEl.style.display = '';
    resultsEl.style.display = 'none';
    searchInput.focus();
  }

  function hideHistoryPanel() {
    hideTooltip();
    historyMode = null;
    histFocusedIdx = -1;
    syncModeHint('search');
    document.body.style.cursor = '';
    histPanelEl.style.display = 'none';
    searchHintEl.style.display = '';
    resultsEl.style.display = '';
    favFolderBtn.style.display = 'none';
    document.getElementById('folderDelConfirm')?.remove();
    searchInput.focus();
    if (!searchInput.value.trim()) showEmptyState();
  }

  // ================================================
  // 空欄状態: 検索履歴をインライン表示（resultsEl 内）
  // ================================================
  function showEmptyState() {
    if (historyMode !== null) return; // パネル表示中は割り込まない
    isEmptyState       = true;
    focusedResultIndex = -1;
    currentResults     = [];
    resultsEl.innerHTML = '';

    if (queryHistory.length === 0) return;

    const isHoverReady = makeHoverGuard();

    const label = document.createElement('div');
    label.className   = 'results-label';
    label.textContent = `検索履歴 ${queryHistory.length}件 ｜ ↑↓ 選択 ｜ Enter 検索 ｜ Ctrl+Del 削除`;
    resultsEl.appendChild(label);

    const list = document.createElement('ul');
    list.className = 'results-list';

    queryHistory.forEach((query, i) => {
      const li = document.createElement('li');
      li.className      = 'result-item';
      li.dataset.histIdx = String(i);
      li.innerHTML =
        `<span class="hist-icon">🔍</span>` +
        `<span class="hist-text">${escapeHtml(query)}</span>` +
        `<button class="hist-del-btn" title="削除 (Ctrl+Del)">×</button>`;

      li.querySelector('.hist-del-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        queryHistory.splice(i, 1);
        persistLocal({ queryHistory });
        showEmptyState();
        searchInput.focus();
      });
      li.addEventListener('mouseenter', () => {
        if (!isHoverReady() || !mainHoverEnabled) return;
        const items = resultsEl.querySelectorAll('.result-item');
        items.forEach((el, j) => el.classList.toggle('result-item-focused', j === i));
        focusedResultIndex = i;
        blurSearchInputForListSelection();
      });
      li.addEventListener('click', (ev) => {
        if (ev.target instanceof Element && ev.target.closest('.hist-del-btn')) return;
        isEmptyState = false;
        searchInput.value = query;
        doSearch(query);
      });
      list.appendChild(li);
    });
    resultsEl.appendChild(list);
  }

  // ================================================
  // 通常履歴リスト描画（Mode2）
  // ================================================
  function renderHistList(mode) {
    const hist = getHistArray(mode);

    hideCursorBriefly();
    const isHoverReady = makeHoverGuard();

    if (hist.length === 0) {
      const empty = document.createElement('li');
      empty.className   = 'history-empty';
      empty.textContent = '履歴はありません';
      histListEl.appendChild(empty);
      histFocusedIdx = -1;
      return;
    }

    hist.forEach((item, i) => {
      const li = document.createElement('li');
      li.className  = 'history-item';
      li.dataset.idx = i;

      let inner = '';
      if (mode === 'search') {
        inner =
          `<span class="hist-icon">🔍</span>` +
          `<span class="hist-text">${escapeHtml(item)}</span>`;
      } else if (mode === 'law') {
        const fav = isFavorite(item.lawId);
        inner =
          `<span class="hist-icon">📄</span>` +
          `<span class="hist-text">${formatLawNameHtml(item.lawName)}</span>` +
          `<button class="hist-fav-btn${fav ? ' hist-fav-active' : ''}" title="${fav ? 'お気に入りから削除' : 'お気に入りに追加'}">${fav ? '★' : '☆'}</button>`;
        // ツールチップ用データ属性（法令名＋法令番号）
        li.dataset.tooltipName = item.lawName || '';
        li.dataset.tooltipNum  = item.lawNum  || '';
      }
      inner += `<button class="hist-del-btn" title="削除 (Ctrl+Del)">×</button>`;
      li.innerHTML = inner;

      // ★ ボタン（Mode2 のみ）
      if (mode === 'law') {
        li.querySelector('.hist-fav-btn').addEventListener('click', (ev) => {
          ev.stopPropagation();
          toggleFavorite(item);
          applyFavButtonState(ev.currentTarget, isFavorite(item.lawId), 'hist-fav-active');
          refocusSearchInput();
        });
      }

      // × ボタン
      li.querySelector('.hist-del-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteHistItem(parseInt(li.dataset.idx));
        refocusSearchInput();
      });

      li.addEventListener('mouseenter', () => {
        if (isHoverReady() && mainHoverEnabled) {
          highlightHistItem(i);
          if (mode === 'law') showTooltip(li, li.dataset.tooltipName, li.dataset.tooltipNum);
        }
      });
      li.addEventListener('mouseleave', () => hideTooltip());
      li.addEventListener('click', (ev) => {
        if (ev.target instanceof Element && (ev.target.closest('.hist-del-btn') || ev.target.closest('.hist-fav-btn'))) return;
        selectHistItem(parseInt(li.dataset.idx), { alternate: ev.ctrlKey });
      });
      histListEl.appendChild(li);
    });
    highlightHistItem(0);
  }

  // ================================================
  // お気に入りパネル描画（Mode3）フォルダ対応
  // ================================================
  function renderFavoritesPanel() {
    histListEl.innerHTML = '';
    // 確認ダイアログが残っていたら除去
    document.getElementById('folderDelConfirm')?.remove();

    hideCursorBriefly();
    const isHoverReady = makeHoverGuard();

    if (favorites.length === 0 && favFolders.length === 0) {
      const empty = document.createElement('li');
      empty.className   = 'history-empty';
      empty.textContent = 'お気に入りはありません';
      histListEl.appendChild(empty);
      histFocusedIdx = -1;
      return;
    }

    // ---- 全折りたたみ/全展開コントロールバー ----
    if (favFolders.length > 0) {
      const bar = document.createElement('li');
      bar.className = 'fav-control-bar';
      bar.innerHTML =
        `<button class="fav-ctrl-btn" data-action="collapse-all">全折りたたみ</button>` +
        `<button class="fav-ctrl-btn" data-action="expand-all">全展開</button>`;
      bar.querySelector('[data-action="collapse-all"]').addEventListener('click', () => {
        favFolders.forEach(f => { folderCollapsed[f.id] = true; });
        folderCollapsed['__uncat__'] = true;
        persistLocal({ folderCollapsed });
        renderFavoritesPanel();
        refocusSearchInput();
      });
      bar.querySelector('[data-action="expand-all"]').addEventListener('click', () => {
        favFolders.forEach(f => { folderCollapsed[f.id] = false; });
        folderCollapsed['__uncat__'] = false;
        persistLocal({ folderCollapsed });
        renderFavoritesPanel();
        refocusSearchInput();
      });
      histListEl.appendChild(bar);
    }

    let visualIdx = 0; // .history-item の DOM 順インデックス

    // ---- フォルダ（名前付きフォルダを先に）----
    favFolders.forEach((folder, folderIdx) => {
      const folderItems = favorites
        .map((fav, arrayIdx) => ({ ...fav, arrayIdx }))
        .filter(fav => fav.folderId === folder.id);

      const collapsed    = !!folderCollapsed[folder.id];
      const folderHeader = createFolderHeaderEl(folder, folderIdx, collapsed);
      histListEl.appendChild(folderHeader);

      if (!collapsed) {
        if (folderItems.length === 0) {
          const emptyZone = document.createElement('li');
          emptyZone.className = 'fav-folder-empty-zone';
          emptyZone.textContent = 'ここにドロップ';
          emptyZone.dataset.folderId = folder.id;
          histListEl.appendChild(emptyZone);
        } else {
          folderItems.forEach(item => {
            const li = createFavItemLi(item, item.arrayIdx, visualIdx++, isHoverReady);
            li.classList.add('fav-folder-item');
            histListEl.appendChild(li);
          });
        }
      }
    });

    // ---- 未分類フォルダ（最下部固定）----
    const uncatItems = favorites
      .map((item, arrayIdx) => ({ ...item, arrayIdx }))
      .filter(item => !item.folderId);

    const uncatCollapsed = !!folderCollapsed['__uncat__'];
    const uncatHeader = createUncatFolderHeaderEl(uncatCollapsed);
    histListEl.appendChild(uncatHeader);

    if (!uncatCollapsed) {
      if (uncatItems.length === 0) {
        const emptyZone = document.createElement('li');
        emptyZone.className = 'fav-folder-empty-zone';
        emptyZone.textContent = 'ここにドロップ';
        emptyZone.dataset.folderId = '';
        histListEl.appendChild(emptyZone);
      } else {
        uncatItems.forEach(item => {
          const li = createFavItemLi(item, item.arrayIdx, visualIdx++, isHoverReady);
          li.classList.add('fav-folder-item');
          histListEl.appendChild(li);
        });
      }
    }

    if (visualIdx > 0) {
      histFocusedIdx = -1;
      highlightHistItem(0);
    } else {
      histFocusedIdx = -1;
    }
  }

  // isHoverReady: () => boolean（makeHoverGuard の戻り値）
  function createFavItemLi(item, arrayIdx, visualIdx, isHoverReady) {
    const li = document.createElement('li');
    li.className   = 'history-item fav-item';
    li.draggable   = true;
    li.dataset.idx = arrayIdx;
    li.dataset.folderId = item.folderId || '';

    li.innerHTML =
      `<span class="hist-icon">★</span>` +
      `<span class="hist-text">${formatLawNameHtml(item.lawName)}</span>` +
      `<button class="hist-del-btn" title="削除 (Ctrl+Del)">×</button>`;
    li.dataset.tooltipName = item.lawName || '';
    li.dataset.tooltipNum  = item.lawNum  || '';

    li.querySelector('.hist-del-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      hideTooltip();
      deleteHistItem(parseInt(li.dataset.idx));
      refocusSearchInput();
    });

    li.addEventListener('mouseenter', () => {
      if (isHoverReady() && mainHoverEnabled) {
        highlightHistItem(visualIdx);
        showTooltip(li, li.dataset.tooltipName, li.dataset.tooltipNum);
      }
    });
    li.addEventListener('mouseleave', () => hideTooltip());
    li.addEventListener('click', (ev) => {
      if (ev.target instanceof Element && ev.target.closest('.hist-del-btn')) return;
      selectHistItem(parseInt(li.dataset.idx), { alternate: ev.ctrlKey });
    });

    // ---- Drag & Drop (dragstart/dragend のみ。dragover/drop は委譲ハンドラで処理) ----
    li.addEventListener('dragstart', (e) => {
      dragType         = 'item';
      dragFromArrayIdx = arrayIdx;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', arrayIdx.toString());
      setTimeout(() => li.classList.add('fav-dragging'), 0);
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('fav-dragging');
      clearDropIndicators();
      stopAutoScroll();
      dragFromArrayIdx = -1;
      dragType         = '';
    });

    return li;
  }

  function createFolderHeaderEl(folder, folderIdx, collapsed) {
    const li = document.createElement('li');
    li.className   = 'fav-folder-header';
    li.draggable   = true;
    li.dataset.folderId  = folder.id;
    li.dataset.folderIdx = folderIdx;   // 委譲ハンドラで参照
    li.innerHTML =
      `<button class="fav-folder-toggle" title="${collapsed ? '展開' : '折りたたみ'}">${collapsed ? '▶' : '▼'}</button>` +
      `<span class="fav-folder-icon">📁</span>` +
      `<span class="fav-folder-name">${escapeHtml(folder.name)}</span>` +
      `<button class="fav-folder-rename-btn" title="フォルダ名を変更">✏️</button>` +
      `<button class="fav-folder-del-btn" title="フォルダを削除">×</button>`;

    // 折りたたみトグル
    li.querySelector('.fav-folder-toggle').addEventListener('click', (ev) => {
      ev.stopPropagation();
      folderCollapsed[folder.id] = !folderCollapsed[folder.id];
      persistLocal({ folderCollapsed });
      renderFavoritesPanel();
      refocusSearchInput();
    });

    li.querySelector('.fav-folder-rename-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      renameFolder(folder.id, folderIdx);
    });

    li.querySelector('.fav-folder-del-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      confirmDeleteFolder(folder.id, folder.name);
      refocusSearchInput();
    });

    // D&D: dragstart/dragend のみ。dragover/drop は委譲ハンドラで処理
    li.addEventListener('dragstart', (e) => {
      if (e.target instanceof Element && e.target.closest('.fav-folder-toggle, .fav-folder-del-btn, .fav-folder-rename-btn')) { e.preventDefault(); return; }
      dragType      = 'folder';
      dragFolderIdx = folderIdx;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'folder:' + folderIdx);
      setTimeout(() => li.classList.add('fav-dragging'), 0);
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('fav-dragging');
      clearDropIndicators();
      stopAutoScroll();
      dragType      = '';
      dragFolderIdx = -1;
    });

    return li;
  }

  // 未分類フォルダのヘッダー要素を生成（D&D 不可、削除ボタンなし）
  function createUncatFolderHeaderEl(collapsed) {
    const li = document.createElement('li');
    li.className = 'fav-folder-header fav-uncat-header';
    li.draggable = false;
    li.dataset.folderId = ''; // 空文字 → drop 処理で || null = null（未分類扱い）
    li.innerHTML =
      `<button class="fav-folder-toggle" title="${collapsed ? '展開' : '折りたたみ'}">${collapsed ? '▶' : '▼'}</button>` +
      `<span class="fav-folder-icon">📁</span>` +
      `<span class="fav-folder-name">未分類</span>`;
    li.querySelector('.fav-folder-toggle').addEventListener('click', (ev) => {
      ev.stopPropagation();
      folderCollapsed['__uncat__'] = !folderCollapsed['__uncat__'];
      persistLocal({ folderCollapsed });
      renderFavoritesPanel();
      refocusSearchInput();
    });
    return li;
  }

  // ================================================
  // フォルダ名インライン編集
  // ================================================
  function renameFolder(folderId, folderIdx) {
    const li = histListEl.querySelector(`.fav-folder-header[data-folder-id="${folderId}"]`);
    if (!li) return;
    const currentName = favFolders[folderIdx]?.name || '';

    li.draggable = false;   // リネーム中はD&D無効
    li.innerHTML =
      `<input type="text" class="fav-folder-rename-input" value="${escapeHtml(currentName)}" maxlength="30" placeholder="フォルダ名">` +
      `<button class="fav-folder-rename-ok" title="確定">✓</button>` +
      `<button class="fav-folder-rename-cancel" title="キャンセル">✕</button>`;

    const input = li.querySelector('.fav-folder-rename-input');
    input.select();
    input.focus();

    // 二重実行防止フラグ（Enterキーリピート等への対策）
    let done = false;

    function confirmRename() {
      if (done) return;
      done = true;
      input.removeEventListener('keydown', onKeydown);
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        favFolders[folderIdx].name = newName;
        persistLocal({ favFolders });
      }
      renderFavoritesPanel();
      refocusSearchInput();
    }
    function cancelRename() {
      if (done) return;
      done = true;
      input.removeEventListener('keydown', onKeydown);
      renderFavoritesPanel();
      refocusSearchInput();
    }
    function onKeydown(ev) {
      ev.stopPropagation();
      if (ev.key === 'Enter')  confirmRename();
      if (ev.key === 'Escape') cancelRename();
    }

    li.querySelector('.fav-folder-rename-ok').addEventListener('click', confirmRename);
    li.querySelector('.fav-folder-rename-cancel').addEventListener('click', cancelRename);
    input.addEventListener('keydown', onKeydown);
  }

  function clearDropIndicators() {
    histListEl.querySelectorAll('.fav-drop-above, .fav-drop-below, .fav-drop-folder')
      .forEach(el => el.classList.remove('fav-drop-above', 'fav-drop-below', 'fav-drop-folder'));
  }

  // ================================================
  // お気に入り D&D イベント委譲ハンドラ（histListEl に一度だけ登録）
  // ================================================
  function setupFavoritesDnD() {
    const TARGETS = '.fav-folder-header, .fav-item, .fav-folder-empty-zone';

    // Y 座標に最も近いフォルダヘッダー要素を返す（フォルダ間の隙間でもドロップを確実にするため）
    function findNearestFolderHeader(clientY) {
      // 未分類フォルダは D&D 並べ替えの対象外なので除く
      const headers = [...histListEl.querySelectorAll('.fav-folder-header:not(.fav-uncat-header)')];
      if (headers.length === 0) return null;
      let best = null, bestDist = Infinity;
      for (const h of headers) {
        const rect = h.getBoundingClientRect();
        const center = rect.top + rect.height / 2;
        const dist = Math.abs(clientY - center);
        if (dist < bestDist) { bestDist = dist; best = h; }
      }
      return best;
    }

    histListEl.addEventListener('dragover', (e) => {
      if (historyMode !== 'favorites') return;
      if (!dragType) return;

      // dragType が設定されている場合は常に preventDefault（フォルダ間の隙間でも drop を発火させる）
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropIndicators();

      // オートスクロール（端から48px 以内でスクロール）
      const listRect = histListEl.getBoundingClientRect();
      const edge = 48;
      if (e.clientY < listRect.top + edge) {
        startAutoScroll(-4);
      } else if (e.clientY > listRect.bottom - edge) {
        startAutoScroll(+4);
      } else {
        stopAutoScroll();
      }

      if (dragType === 'folder') {
        // セル間の隙間にいる場合も位置ベースで最近傍フォルダを探してインジケーターを表示
        const nearest = findNearestFolderHeader(e.clientY);
        if (!nearest || parseInt(nearest.dataset.folderIdx) === dragFolderIdx) return;
        const rect = nearest.getBoundingClientRect();
        nearest.classList.add(e.clientY < rect.top + rect.height / 2 ? 'fav-drop-above' : 'fav-drop-below');

      } else if (dragType === 'item') {
        const target = e.target instanceof Element ? e.target.closest(TARGETS) : null;
        if (!target) return;
        if (target.classList.contains('fav-item')) {
          const rect = target.getBoundingClientRect();
          target.classList.add(e.clientY < rect.top + rect.height / 2 ? 'fav-drop-above' : 'fav-drop-below');
        } else {
          target.classList.add('fav-drop-folder');
        }
      }
    });

    histListEl.addEventListener('dragleave', (e) => {
      if (!histListEl.contains(e.relatedTarget)) { clearDropIndicators(); stopAutoScroll(); }
    });

    histListEl.addEventListener('drop', (e) => {
      if (historyMode !== 'favorites') return;
      if (!dragType) return;
      e.preventDefault();
      stopAutoScroll();
      clearDropIndicators();

      if (dragType === 'folder') {
        // 位置ベースで最近傍フォルダを特定してリオーダー
        const nearest = findNearestFolderHeader(e.clientY);
        if (!nearest) return;
        const fromIdx = dragFolderIdx;
        const toIdx   = parseInt(nearest.dataset.folderIdx);
        if (isNaN(toIdx) || fromIdx === toIdx || fromIdx < 0) return;

        const rect         = nearest.getBoundingClientRect();
        const insertBefore = e.clientY < rect.top + rect.height / 2;
        const [moved]      = favFolders.splice(fromIdx, 1);
        const adjustedTo   = toIdx > fromIdx ? toIdx - 1 : toIdx;
        favFolders.splice(insertBefore ? adjustedTo : adjustedTo + 1, 0, moved);

        persistLocal({ favFolders });
        renderFavoritesPanel();
        refocusSearchInput();

      } else if (dragType === 'item') {
        const target = e.target instanceof Element ? e.target.closest(TARGETS) : null;
        if (!target) return;
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
        if (isNaN(fromIdx) || fromIdx < 0 || fromIdx >= favorites.length) return;

        if (target.classList.contains('fav-item')) {
          const toIdx = parseInt(target.dataset.idx);
          if (isNaN(toIdx) || fromIdx === toIdx) return;
          const rect         = target.getBoundingClientRect();
          const insertBefore = e.clientY < rect.top + rect.height / 2;
          const [moved]      = favorites.splice(fromIdx, 1);
          moved.folderId     = target.dataset.folderId || null;
          const adjustedTo   = toIdx > fromIdx ? toIdx - 1 : toIdx;
          favorites.splice(insertBefore ? adjustedTo : adjustedTo + 1, 0, moved);

        } else if (target.classList.contains('fav-folder-header')) {
          // fav-uncat-header は dataset.folderId = '' なので || null で null（未分類）になる
          favorites[fromIdx].folderId = target.dataset.folderId || null;
        } else if (target.classList.contains('fav-folder-empty-zone')) {
          favorites[fromIdx].folderId = target.dataset.folderId || null;
        }

        persistLocal({ favorites });
        renderFavoritesPanel();
        refocusSearchInput();
      }
    });
  }

  // ================================================
  // フォルダ作成
  // ================================================
  favFolderBtn.addEventListener('click', () => {
    showCreateFolderForm();
  });

  function showCreateFolderForm() {
    if (histListEl.querySelector('.fav-create-folder-row')) {
      histListEl.querySelector('.fav-folder-name-input')?.focus();
      return;
    }
    const row = document.createElement('li');
    row.className = 'fav-create-folder-row';
    row.innerHTML =
      `<input type="text" class="fav-folder-name-input" placeholder="フォルダ名を入力" maxlength="30">` +
      `<button class="fav-folder-create-ok">作成</button>` +
      `<button class="fav-folder-create-cancel">✕</button>`;

    const input = row.querySelector('.fav-folder-name-input');
    row.querySelector('.fav-folder-create-ok').addEventListener('click', () => {
      createFolderFromInput(input.value.trim());
    });
    row.querySelector('.fav-folder-create-cancel').addEventListener('click', () => {
      row.remove();
      searchInput.focus();
    });
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') createFolderFromInput(input.value.trim());
      if (ev.key === 'Escape') { row.remove(); searchInput.focus(); }
    });

    histListEl.insertBefore(row, histListEl.firstChild);
    input.focus();
  }

  function createFolderFromInput(name) {
    if (!name) return;
    const folder = {
      id:   Date.now().toString(36) + Math.random().toString(36).slice(2),
      name,
    };
    favFolders.push(folder);
    persistLocal({ favFolders });
    renderFavoritesPanel();
    refocusSearchInput();
  }

  // ================================================
  // フォルダ削除確認ダイアログ
  // ================================================
  function confirmDeleteFolder(folderId, folderName) {
    document.getElementById('folderDelConfirm')?.remove();

    const div = document.createElement('div');
    div.id = 'folderDelConfirm';
    div.className = 'folder-del-confirm';
    div.innerHTML =
      `<div class="folder-del-confirm-msg">` +
        `フォルダ「${escapeHtml(folderName)}」を削除します。<br>フォルダ内の法令をどうしますか？` +
      `</div>` +
      `<div class="folder-del-confirm-btns">` +
        `<button class="fdc-root">未分類に移動</button>` +
        `<button class="fdc-del">お気に入りから削除</button>` +
        `<button class="fdc-cancel">キャンセル</button>` +
      `</div>`;

    // historyPanel の先頭（リストの前）に挿入
    histPanelEl.insertBefore(div, histListEl);

    div.querySelector('.fdc-root').addEventListener('click', () => {
      favorites.forEach(f => { if (f.folderId === folderId) f.folderId = null; });
      favFolders = favFolders.filter(f => f.id !== folderId);
      persistLocal({ favorites, favFolders });
      div.remove();
      renderFavoritesPanel();
      refocusSearchInput();
    });
    div.querySelector('.fdc-del').addEventListener('click', () => {
      favorites  = favorites.filter(f => f.folderId !== folderId);
      favFolders = favFolders.filter(f => f.id !== folderId);
      persistLocal({ favorites, favFolders });
      div.remove();
      renderFavoritesPanel();
      refocusSearchInput();
    });
    div.querySelector('.fdc-cancel').addEventListener('click', () => {
      div.remove();
      refocusSearchInput();
    });
  }

  // ================================================
  // 履歴ハイライト・フォーカス移動
  // ================================================
  function ensureFavoriteFolderHeaderVisible(itemEl) {
    if (historyMode !== 'favorites' || !itemEl) return;

    const folderId = itemEl.dataset.folderId ?? '';
    const header = [...histListEl.querySelectorAll('.fav-folder-header')]
      .find((el) => (el.dataset.folderId ?? '') === folderId);
    if (!header) return;

    const listRect = histListEl.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    if (headerRect.top < listRect.top) {
      histListEl.scrollTop -= (listRect.top - headerRect.top) + 4;
    }
  }

  function highlightHistItem(idx) {
    const items = histListEl.querySelectorAll('.history-item');
    items.forEach((el, i) => el.classList.toggle('history-item-focused', i === idx));
    if (idx >= 0 && items[idx]) {
      blurSearchInputForListSelection();
      items[idx].scrollIntoView({ block: 'nearest' });
      ensureFavoriteFolderHeaderVisible(items[idx]);
      // キーボードフォーカス時もツールチップ表示
      const el = items[idx];
      if (el.dataset.tooltipName || el.dataset.tooltipNum) {
        showTooltip(el, el.dataset.tooltipName || '', el.dataset.tooltipNum || '');
      } else {
        hideTooltip();
      }
    }
    histFocusedIdx = idx;
  }

  function moveHistFocus(dir, len) {
    if (len === 0) return;
    hideCursorBriefly();
    if (histFocusedIdx === 0 && dir < 0) {
      focusSearchInputFromList('history');
      return;
    }
    if (histFocusedIdx === len - 1 && dir > 0) {
      focusSearchInputFromList('history');
      return;
    }
    const next = (histFocusedIdx + dir + len) % len;
    highlightHistItem(next);
  }

  function deleteHistItem(arrayIdx) {
    if (arrayIdx < 0) return;
    const hist = getHistArray(historyMode);
    if (arrayIdx >= hist.length) return;
    hist.splice(arrayIdx, 1);

    const keyMap = { search: 'queryHistory', law: 'openedLawHistory', favorites: 'favorites' };
    persistLocal({ [keyMap[historyMode]]: hist });

    if (historyMode === 'favorites') {
      renderFavoritesPanel();
    } else {
      // DOM から該当アイテムを削除してインデックスを更新
      const items = histListEl.querySelectorAll('.history-item');
      const domIdx = [...items].findIndex(el => parseInt(el.dataset.idx) === arrayIdx);
      if (domIdx >= 0 && items[domIdx]) items[domIdx].remove();

      if (hist.length === 0) {
        const empty = document.createElement('li');
        empty.className   = 'history-empty';
        empty.textContent = '履歴はありません';
        histListEl.appendChild(empty);
        histFocusedIdx = -1;
      } else {
        // dataset.idx を振り直す
        histListEl.querySelectorAll('.history-item').forEach((el, i) => { el.dataset.idx = i; });
        const newVisualIdx = Math.min(domIdx, hist.length - 1);
        histFocusedIdx = -1;
        highlightHistItem(newVisualIdx);
      }
    }
  }

  function selectHistItem(arrayIdx, { alternate = false } = {}) {
    if (arrayIdx < 0) return;
    hideTooltip();
    if (historyMode === 'search') {
      const query = queryHistory[arrayIdx];
      if (!query) return;
      hideHistoryPanel();
      searchInput.value = query;
      doSearch(query);
    } else {
      const law = getHistArray(historyMode)[arrayIdx];
      if (!law) return;
      // お気に入り・法令履歴どちらから開いた場合も「開いた法令履歴」に追加
      if (!openLaw(law, { alternate })) {
        showToast('法令を開けませんでした');
      }
    }
  }

  // Mode0 の ◀ ▶ ボタンクリック（searchHint 内）
  mode0NavLeft.addEventListener('click', () => {
    if (historyMode === null) showHistoryPanel('law');
    else if (historyMode === 'favorites') hideHistoryPanel();
  });
  mode0NavRight.addEventListener('click', () => {
    if (historyMode === null) showHistoryPanel('favorites');
    else if (historyMode === 'law') hideHistoryPanel();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hideTooltip();
  });

  // フォーム送信
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (query) {
      doSearch(query);
      return;
    }
    if (focusedResultIndex >= 0 && currentResults[focusedResultIndex])
      openResult(currentResults[focusedResultIndex]);
  });

  // ボトムバーの外部リンク
  document.querySelectorAll('.footer-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: link.dataset.url });
      window.close();
    });
  });

  // 設定ボタン
  document.getElementById('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
  document.getElementById('openManual').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'egov-open-manual-page' }).finally(() => window.close());
  });
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'egov-open-manual-page' }).finally(() => window.close());
    }
  });

  // ================================================
  // フォーカス移動（↑↓キー・検索結果）
  // ================================================
  function moveFocus(direction) {
    const items = resultsEl.querySelectorAll('.result-item');
    if (items.length === 0) return;
    hideCursorBriefly();
    if (focusedResultIndex === 0 && direction < 0) {
      focusSearchInputFromList('main');
      return;
    }
    if (focusedResultIndex === items.length - 1 && direction > 0) {
      focusSearchInputFromList('main');
      return;
    }
    if (focusedResultIndex >= 0 && items[focusedResultIndex])
      items[focusedResultIndex].classList.remove('result-item-focused');
    let next = focusedResultIndex + direction;
    if (next < 0)             next = items.length - 1;
    if (next >= items.length) next = 0;
    focusedResultIndex = next;
    items[focusedResultIndex].classList.add('result-item-focused');
    items[focusedResultIndex].scrollIntoView({ block: 'nearest' });
    blurSearchInputForListSelection();
  }

  function openResult(law, options = {}) {
    openLaw(law, options);
  }

  // ================================================
  // API検索
  // ================================================
  async function doSearch(query) {
    if (historyMode !== null) hideHistoryPanel();
    isEmptyState       = false;
    focusedResultIndex = -1;
    showLoading(true);
    try {
      const normalizedQuery = query.replace(/[\s　]+/g, '').toLowerCase();
      const localLaws = LOCAL_COURT_RULES.filter((rule) =>
        rule.aliases.some((alias) => alias.toLowerCase().includes(normalizedQuery) || normalizedQuery.includes(alias.toLowerCase()))
      );
      let laws = [];
      let remoteError = null;
      try {
        laws = await searchLawsByTitle(query, { limit: 31 });
      } catch (error) {
        remoteError = error;
      }
      if (remoteError && localLaws.length === 0) throw remoteError;
      const hasMore = laws.length > 30;
      const remoteDisplay = hasMore ? laws.slice(0, 30) : laws;
      const localIds = new Set(localLaws.map((rule) => rule.lawId));
      const display = [...localLaws, ...remoteDisplay.filter((law) => !localIds.has(getLawFields(law).lawId))];
      // currentResults は showResults 内で表示順（sortedLaws）に確定させる
      showResults(display, query, hasMore);
      if (display.length > 0) pushQueryHistory(query);
    } catch (err) {
      showError(`エラー: ${err.message}`);
    } finally {
      showLoading(false);
    }
  }

  // ================================================
  // 履歴・お気に入り管理
  // ================================================
  async function loadHistories() {
    try {
      const data = await chrome.storage.local.get([
        'queryHistory', 'openedLawHistory', 'favorites', 'favFolders', 'liteModeDefault',
      ]);
      if (Array.isArray(data.queryHistory))     queryHistory     = data.queryHistory;
      if (Array.isArray(data.openedLawHistory)) openedLawHistory = data.openedLawHistory;
      if (Array.isArray(data.favorites))        favorites        = data.favorites;
      if (Array.isArray(data.favFolders))       favFolders       = data.favFolders;
      liteModeDefault = data.liteModeDefault === true;
      updateLiteModeTitleBadge();
      if (data.folderCollapsed && typeof data.folderCollapsed === 'object') folderCollapsed = data.folderCollapsed;
    } catch (_) {}
  }

  function pushQueryHistory(query) {
    if (!query) return;
    const idx = queryHistory.indexOf(query);
    if (idx !== -1) queryHistory.splice(idx, 1);
    queryHistory.unshift(query);
    if (queryHistory.length > HIST_MAX) queryHistory.length = HIST_MAX;
    persistLocal({ queryHistory });
  }

  function pushOpenedLaw(law) {
    if (!law.lawId) return;
    const idx = openedLawHistory.findIndex(l => l.lawId === law.lawId);
    if (idx !== -1) openedLawHistory.splice(idx, 1);
    openedLawHistory.unshift(law);
    if (openedLawHistory.length > HIST_MAX) openedLawHistory.length = HIST_MAX;
    persistLocal({ openedLawHistory });
  }

  function isFavorite(lawId) {
    return favorites.some(f => f.lawId === lawId);
  }

  function toggleFavorite(lawOrFields) {
    const fields = lawOrFields.lawId !== undefined ? lawOrFields : getLawFields(lawOrFields);
    const { lawId, lawName, lawNum, lawType } = fields;
    if (!lawId) return;
    const result = toggleFavoriteRecord(
      favorites,
      { lawId, lawName, lawNum, lawType, folderId: null },
      FAV_MAX
    );
    showToast(result.isFavorite ? 'お気に入りに追加しました' : 'お気に入りから削除しました');
    persistLocal({ favorites });
  }

  // ================================================
  // 結果表示
  // ================================================
  function showResults(laws, query, hasMore = false, focusedLawId = null) {
    isEmptyState        = false;
    resultsEl.innerHTML = '';
    focusedResultIndex  = -1;
    currentSearchQuery  = query ?? '';
    currentSearchHasMore = hasMore;

    if (laws.length === 0) {
      resultsEl.innerHTML = `
        <div class="no-results">
          「${escapeHtml(query ?? '')}」に一致する法令が見つかりませんでした
          <a href="#" class="fallback-link" data-url="https://laws.e-gov.go.jp/">e-Govで直接検索する →</a>
        </div>`;
      wireFallbackLink();
      searchInput.focus();
      return;
    }

    // お気に入りを最上位、その次にMode2（開いた法令）に含まれる法令を表示
    const favoriteIds = new Set(favorites.map(f => f.lawId));
    const visitedIds = new Set(openedLawHistory.map(l => l.lawId));
    const sortedLaws = [
      ...laws.filter(l => favoriteIds.has(getLawFields(l).lawId)),
      ...laws.filter(l => {
        const lawId = getLawFields(l).lawId;
        return !favoriteIds.has(lawId) && visitedIds.has(lawId);
      }),
      ...laws.filter(l => {
        const lawId = getLawFields(l).lawId;
        return !favoriteIds.has(lawId) && !visitedIds.has(lawId);
      }),
    ];

    resultsEl.innerHTML = `<div class="results-label">${sortedLaws.length}件${hasMore ? '（上限）' : ''} &nbsp;｜&nbsp; ↑↓ 移動 ｜ Enter 開く ｜ Shift+Enter ★</div>`;
    const list = document.createElement('ul');
    list.className = 'results-list';

    // カーソル非表示 + マウス移動でホバー有効化（描画直後の誤検知防止）
    hideCursorBriefly();

    sortedLaws.forEach((law, i) => {
      const { lawId, lawName, lawNum, lawType } = getLawFields(law);
      const isLocalCourtRule = Boolean(law.localRule || LOCAL_COURT_RULE_BY_ID.has(lawId));
      const typeTags = isLocalCourtRule
        ? [
            '<span class="result-type">裁判所規則</span>',
            '<span class="result-type result-type-local">ローカル</span>',
          ].join('')
        : (lawType ? `<span class="result-type">${escapeHtml(formatType(lawType))}</span>` : '');
      const isVisited = visitedIds.has(lawId);
      const fav       = isFavorite(lawId);
      const li        = document.createElement('li');
      li.className    = [
        'result-item',
        isVisited ? 'result-item-visited' : '',
        fav ? 'result-item-favorite' : '',
      ].filter(Boolean).join(' ');
      li.innerHTML = `
        <div class="result-main">
          ${typeTags ? `<div class="result-tags">${typeTags}</div>` : ''}
          <span class="result-name">${formatLawNameHtml(lawName)}</span>
          ${lawNum ? `<span class="result-num">${escapeHtml(lawNum)}</span>` : ''}
        </div>
        <button class="result-fav-btn${fav ? ' result-fav-active' : ''}"
                title="${fav ? 'お気に入りから削除 (Shift+Enter)' : 'お気に入りに追加 (Shift+Enter)'}">${fav ? '★' : '☆'}</button>
      `;
      li.querySelector('.result-fav-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleFavorite(law);
        showResults(currentResults, query, hasMore, lawId);
      });
      li.addEventListener('click', (ev) => openResult(law, { alternate: ev.ctrlKey }));
      li.addEventListener('mouseenter', () => {
        if (!mainHoverEnabled) return;
        const items = resultsEl.querySelectorAll('.result-item');
        if (focusedResultIndex >= 0 && items[focusedResultIndex])
          items[focusedResultIndex].classList.remove('result-item-focused');
        focusedResultIndex = i;
        li.classList.add('result-item-focused');
        blurSearchInputForListSelection();
      });
      list.appendChild(li);
    });
    currentResults = sortedLaws;
    resultsEl.appendChild(list);

    const resultItems = list.querySelectorAll('.result-item');
    const preferredIndex = focusedLawId
      ? sortedLaws.findIndex(law => getLawFields(law).lawId === focusedLawId)
      : 0;
    const focusedItem = resultItems[preferredIndex >= 0 ? preferredIndex : 0];
    if (focusedItem) {
      focusedResultIndex = preferredIndex >= 0 ? preferredIndex : 0;
      focusedItem.classList.add('result-item-focused');
      focusedItem.scrollIntoView({ block: 'nearest' });
      blurSearchInputForListSelection();
    }

    if (hasMore) {
      const notice = document.createElement('div');
      notice.className  = 'results-overflow-notice';
      notice.textContent = '検索結果が多いため、上位30件のみ表示しています';
      resultsEl.appendChild(notice);
    }
  }

  function showLoading(on) {
    if (on) { resultsEl.innerHTML = '<div class="loading">検索中...</div>'; currentResults = []; }
  }

  function showError(msg) {
    resultsEl.innerHTML = `
      <div class="no-results">
        <span>${escapeHtml(msg)}</span>
        <a href="#" class="fallback-link" data-url="https://laws.e-gov.go.jp/">e-Govで直接検索する →</a>
      </div>`;
    wireFallbackLink();
  }

  // ================================================
  // ユーティリティ
  // ================================================
  function formatType(type) {
    const map = {
      'Constitution': '憲法', 'Act': '法律', 'CabinetOrder': '政令',
      'ImperialOrder': '勅令', 'MinisterialOrdinance': '府省令',
      'Rule': '規則', 'Misc': 'その他',
    };
    return map[type] || type || '法令';
  }

});
