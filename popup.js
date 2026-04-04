document.addEventListener('DOMContentLoaded', async () => {
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
  const {
    buildLawUrl,
    escapeHtml,
    formatLawNameHtml,
    getLawFields,
    searchLawsByTitle,
  } = shared;
  const searchForm    = document.getElementById('searchForm');
  const searchInput   = document.getElementById('searchInput');
  const resultsEl     = document.getElementById('searchResults');
  const histPanelEl   = document.getElementById('historyPanel');
  const histListEl    = document.getElementById('historyList');
  const histTitleEl   = { textContent: '' };
  const histHintEl    = { textContent: '' };
  const searchHintEl  = document.getElementById('searchHint');
  const histLeftBtn   = { style: {}, disabled: false, title: '', addEventListener() {} };
  const histRightBtn  = { style: {}, disabled: false, title: '', addEventListener() {} };
  const favFolderBtn  = document.getElementById('favFolderBtn');
  const mode0NavLeft  = document.getElementById('mode0NavLeft');
  const mode0NavRight = document.getElementById('mode0NavRight');
  const modeLeftLabel = document.getElementById('modeLeftLabel');
  const modeCurrentLabel = document.getElementById('modeCurrentLabel');
  const modeRightLabel = document.getElementById('modeRightLabel');

  let debounceTimer      = null;
  let isComposing        = false;
  let currentResults     = [];
  let focusedResultIndex = -1;
  let mainHoverEnabled   = true;

  // 履歴・お気に入りデータ
  let queryHistory     = [];   // 検索クエリ履歴（文字列）
  let openedLawHistory = [];   // 開いた法令履歴（{lawId,lawName,lawNum,lawType}）
  let favorites        = [];   // お気に入り法令（{lawId,lawName,lawNum,lawType,folderId?}）
  let favFolders       = [];   // お気に入りフォルダ（{id,name}）
  const HIST_MAX = 30;
  const FAV_MAX  = 50;

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

  // ================================================
  // 起動時：履歴を読み込んで検索履歴を表示
  // ================================================
  await loadHistories();
  const { requestedPopupMode = '' } = await chrome.storage.session.get('requestedPopupMode').catch(() => ({ requestedPopupMode: '' }));
  const initialMode = requestedPopupMode === 'law' || requestedPopupMode === 'favorites'
    ? requestedPopupMode
    : null;
  chrome.storage.session.remove('requestedPopupMode').catch(() => {});
  syncModeHint('search');
  setupFavoritesDnD();
  if (initialMode) {
    showHistoryPanel(initialMode);
  } else {
    searchInput.focus();
    showEmptyState();
  }
  document.addEventListener('keydown', (e) => {
    if (handleModeArrowNavigation(e)) e.stopPropagation();
  }, true);

  // ================================================
  // IME変換確定後に検索
  // ================================================
  searchInput.addEventListener('compositionstart', () => { isComposing = true; });
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
    if (historyMode !== null) { handleHistoryKeydown(e); return; }
    if (handleModeArrowNavigation(e)) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault(); moveFocus(+1); return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault(); moveFocus(-1); return;
    }

    // 空欄・履歴表示中: Del でフォーカス中の履歴アイテムを削除
    if (isEmptyState && e.key === 'Delete' && focusedResultIndex >= 0) {
      e.preventDefault();
      queryHistory.splice(focusedResultIndex, 1);
      chrome.storage.local.set({ queryHistory }).catch(() => {});
      const nextIdx = Math.min(focusedResultIndex, queryHistory.length - 1);
      showEmptyState();
      if (nextIdx >= 0) {
        const items = resultsEl.querySelectorAll('.result-item');
        items.forEach((el, i) => el.classList.toggle('result-item-focused', i === nextIdx));
        focusedResultIndex = nextIdx;
      }
      return;
    }

    if (e.key === 'Enter' && !isComposing) {
      e.preventDefault();
      if (isEmptyState && focusedResultIndex >= 0 && queryHistory[focusedResultIndex]) {
        // 検索履歴から選択してそのまま検索
        const query = queryHistory[focusedResultIndex];
        isEmptyState = false;
        searchInput.value = query;
        doSearch(query);
      } else if (e.shiftKey) {
        // Shift+Enter：注目中の検索結果をお気に入りトグル
        if (focusedResultIndex >= 0 && currentResults[focusedResultIndex]) {
          toggleFavorite(currentResults[focusedResultIndex]);
          updateFavBtnAt(focusedResultIndex);
        }
      } else {
        if (focusedResultIndex >= 0 && currentResults[focusedResultIndex]) {
          openResult(currentResults[focusedResultIndex]);
        } else {
          const query = searchInput.value.trim();
          if (query) doSearch(query);
        }
      }
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
      if (historyMode === 'law')            hideHistoryPanel(); // Mode2 → Mode0（閉じる）
      else if (historyMode === 'favorites') hideHistoryPanel(); // Mode3 → Mode0（閉じる）
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
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
            if (btn) {
              const fav = isFavorite(openedLawHistory[idx].lawId);
              btn.textContent = fav ? '★' : '☆';
              btn.classList.toggle('hist-fav-active', fav);
              btn.title = fav ? 'お気に入りから削除' : 'お気に入りに追加';
            }
          }
        }
        return;
      }
      selectHistItem(getFocusedArrayIdx()); return;
    }
    if (e.key === 'Escape') { hideHistoryPanel(); return; }
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
    historyMode    = mode;
    histFocusedIdx = -1;
    syncModeHint(mode);

    // タイトル

    // ◀ ボタン（Mode3 のみ表示）
    histLeftBtn.title = mode === 'favorites' ? '閉じる' : '';

    // ▶ ボタン（Mode2 / Mode3 で表示）
    const showRight = mode === 'law';
    histRightBtn.style.visibility = showRight ? 'visible' : 'hidden';
    histRightBtn.style.display    = showRight ? '' : 'none';
    histRightBtn.disabled         = !showRight;
    histRightBtn.title = mode === 'law' ? '閉じる' : mode === 'favorites' ? '閉じる' : '';

    // フォルダ作成ボタン（Mode3 のみ表示）
    favFolderBtn.style.display = mode === 'favorites' ? '' : 'none';

    // ガイドヒント
    const hints = {
      law:       '▶ 閉じる ｜ ↑↓ 選択 ｜ Shift+Enter ★ ｜ Enter 開く ｜ Del 削除',
      favorites: '◀ 閉じる ｜ ↑↓ 選択 ｜ Enter 開く ｜ Del 削除 ｜ D&D 並替/移動',
    };
    histHintEl.textContent = ({
      law: '↑↓ 選択 ｜ Shift+Enter お気に入り ｜ Enter 開く ｜ Del 削除',
      favorites: '↑↓ 選択 ｜ Enter 開く ｜ Del 削除',
    })[mode] || '';

    // リスト描画
    histListEl.innerHTML = '';

    if (mode === 'favorites') {
      renderFavoritesPanel();
    } else {
      renderHistList(mode);
    }

    histPanelEl.style.display  = 'flex';
    searchHintEl.style.display = '';
    resultsEl.style.display    = 'none';
    searchInput.readOnly       = true;
    searchForm.classList.add('search-form-inactive');
    searchInput.focus();
  }

  function hideHistoryPanel() {
    hideTooltip();
    historyMode    = null;
    histFocusedIdx = -1;
    syncModeHint('search');
    document.body.style.cursor = '';
    histPanelEl.style.display  = 'none';
    searchHintEl.style.display = '';
    resultsEl.style.display    = '';
    searchInput.readOnly       = false;
    searchForm.classList.remove('search-form-inactive');
    favFolderBtn.style.display = 'none';
    // 確認ダイアログが残っていたら除去
    document.getElementById('folderDelConfirm')?.remove();
    searchInput.focus();
    // 入力が空欄なら検索履歴をインライン表示
    if (!searchInput.value.trim()) showEmptyState();
  }

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
    searchInput.readOnly = true;
    searchForm.classList.add('search-form-inactive');
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
    searchInput.readOnly = false;
    searchForm.classList.remove('search-form-inactive');
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
    label.textContent = `検索履歴 ${queryHistory.length}件 ｜ ↑↓ 選択 ｜ Enter 検索 ｜ Del 削除`;
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
        `<button class="hist-del-btn" title="削除 (Del)">×</button>`;

      li.querySelector('.hist-del-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        queryHistory.splice(i, 1);
        chrome.storage.local.set({ queryHistory }).catch(() => {});
        showEmptyState();
        searchInput.focus();
      });
      li.addEventListener('mouseenter', () => {
        if (!isHoverReady() || !mainHoverEnabled) return;
        const items = resultsEl.querySelectorAll('.result-item');
        items.forEach((el, j) => el.classList.toggle('result-item-focused', j === i));
        focusedResultIndex = i;
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
      inner += `<button class="hist-del-btn" title="削除 (Del)">×</button>`;
      li.innerHTML = inner;

      // ★ ボタン（Mode2 のみ）
      if (mode === 'law') {
        li.querySelector('.hist-fav-btn').addEventListener('click', (ev) => {
          ev.stopPropagation();
          toggleFavorite(item);
          const btn  = ev.currentTarget;
          const nfav = isFavorite(item.lawId);
          btn.textContent = nfav ? '★' : '☆';
          btn.classList.toggle('hist-fav-active', nfav);
          btn.title = nfav ? 'お気に入りから削除' : 'お気に入りに追加';
          setTimeout(() => searchInput.focus(), 0);
        });
      }

      // × ボタン
      li.querySelector('.hist-del-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteHistItem(parseInt(li.dataset.idx));
        setTimeout(() => searchInput.focus(), 0);
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
        selectHistItem(parseInt(li.dataset.idx));
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
        chrome.storage.local.set({ folderCollapsed }).catch(() => {});
        renderFavoritesPanel();
        setTimeout(() => searchInput.focus(), 0);
      });
      bar.querySelector('[data-action="expand-all"]').addEventListener('click', () => {
        favFolders.forEach(f => { folderCollapsed[f.id] = false; });
        folderCollapsed['__uncat__'] = false;
        chrome.storage.local.set({ folderCollapsed }).catch(() => {});
        renderFavoritesPanel();
        setTimeout(() => searchInput.focus(), 0);
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
      `<button class="hist-del-btn" title="削除 (Del)">×</button>`;
    li.dataset.tooltipName = item.lawName || '';
    li.dataset.tooltipNum  = item.lawNum  || '';

    li.querySelector('.hist-del-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      hideTooltip();
      deleteHistItem(parseInt(li.dataset.idx));
      setTimeout(() => searchInput.focus(), 0);
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
      selectHistItem(parseInt(li.dataset.idx));
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
      chrome.storage.local.set({ folderCollapsed }).catch(() => {});
      renderFavoritesPanel();
      setTimeout(() => searchInput.focus(), 0);
    });

    li.querySelector('.fav-folder-rename-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      renameFolder(folder.id, folderIdx);
    });

    li.querySelector('.fav-folder-del-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      confirmDeleteFolder(folder.id, folder.name);
      setTimeout(() => searchInput.focus(), 0);
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
      chrome.storage.local.set({ folderCollapsed }).catch(() => {});
      renderFavoritesPanel();
      setTimeout(() => searchInput.focus(), 0);
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
        chrome.storage.local.set({ favFolders }).catch(() => {});
      }
      renderFavoritesPanel();
      setTimeout(() => searchInput.focus(), 0);
    }
    function cancelRename() {
      if (done) return;
      done = true;
      input.removeEventListener('keydown', onKeydown);
      renderFavoritesPanel();
      setTimeout(() => searchInput.focus(), 0);
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

        chrome.storage.local.set({ favFolders }).catch(() => {});
        renderFavoritesPanel();
        setTimeout(() => searchInput.focus(), 0);

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

        chrome.storage.local.set({ favorites }).catch(() => {});
        renderFavoritesPanel();
        setTimeout(() => searchInput.focus(), 0);
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
    chrome.storage.local.set({ favFolders }).catch(() => {});
    renderFavoritesPanel();
    setTimeout(() => searchInput.focus(), 0);
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
      chrome.storage.local.set({ favorites, favFolders }).catch(() => {});
      div.remove();
      renderFavoritesPanel();
      setTimeout(() => searchInput.focus(), 0);
    });
    div.querySelector('.fdc-del').addEventListener('click', () => {
      favorites  = favorites.filter(f => f.folderId !== folderId);
      favFolders = favFolders.filter(f => f.id !== folderId);
      chrome.storage.local.set({ favorites, favFolders }).catch(() => {});
      div.remove();
      renderFavoritesPanel();
      setTimeout(() => searchInput.focus(), 0);
    });
    div.querySelector('.fdc-cancel').addEventListener('click', () => {
      div.remove();
      setTimeout(() => searchInput.focus(), 0);
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
    const next = (histFocusedIdx + dir + len) % len;
    highlightHistItem(next);
  }

  function deleteHistItem(arrayIdx) {
    if (arrayIdx < 0) return;
    const hist = getHistArray(historyMode);
    if (arrayIdx >= hist.length) return;
    hist.splice(arrayIdx, 1);

    const keyMap = { search: 'queryHistory', law: 'openedLawHistory', favorites: 'favorites' };
    chrome.storage.local.set({ [keyMap[historyMode]]: hist }).catch(() => {});

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

  function selectHistItem(arrayIdx) {
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
      hideHistoryPanel();
      // お気に入り・法令履歴どちらから開いた場合も「開いた法令履歴」に追加
      if (historyMode !== 'law') pushOpenedLaw(law);
      chrome.tabs.create({ url: buildLawUrl(law.lawId) });
      window.close();
    }
  }

  // ◀ ▶ ボタンクリック（履歴パネル内）— 両方とも閉じるだけ
  histLeftBtn.addEventListener('click',  () => { if (historyMode !== null) hideHistoryPanel(); });
  histRightBtn.addEventListener('click', () => { if (historyMode !== null) hideHistoryPanel(); });

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
    if (focusedResultIndex >= 0 && currentResults[focusedResultIndex])
      openResult(currentResults[focusedResultIndex]);
  });

  // クイックリンク
  document.querySelectorAll('.quick-link').forEach((link) => {
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

  // ================================================
  // フォーカス移動（↑↓キー・検索結果）
  // ================================================
  function moveFocus(direction) {
    const items = resultsEl.querySelectorAll('.result-item');
    if (items.length === 0) return;
    hideCursorBriefly();
    if (focusedResultIndex >= 0 && items[focusedResultIndex])
      items[focusedResultIndex].classList.remove('result-item-focused');
    let next = focusedResultIndex + direction;
    if (next < 0)             next = items.length - 1;
    if (next >= items.length) next = 0;
    focusedResultIndex = next;
    items[focusedResultIndex].classList.add('result-item-focused');
    items[focusedResultIndex].scrollIntoView({ block: 'nearest' });
  }

  function openResult(law) {
    const { lawId, lawName, lawNum, lawType } = getLawFields(law);
    pushOpenedLaw({ lawId, lawName, lawNum, lawType });
    chrome.tabs.create({ url: buildLawUrl(lawId) });
    window.close();
  }

  // ★ ボタン表示を最新状態に更新
  function updateFavBtnAt(idx) {
    const items = resultsEl.querySelectorAll('.result-item');
    const li = items[idx];
    if (!li) return;
    const btn = li.querySelector('.result-fav-btn');
    if (!btn || !currentResults[idx]) return;
    const { lawId } = getLawFields(currentResults[idx]);
    const fav = isFavorite(lawId);
    btn.textContent = fav ? '★' : '☆';
    btn.classList.toggle('result-fav-active', fav);
    btn.title = fav ? 'お気に入りから削除 (Shift+Enter)' : 'お気に入りに追加 (Shift+Enter)';
  }

  // ================================================
  // API検索
  // ================================================
  async function doSearch(query) {
    isEmptyState       = false;
    focusedResultIndex = -1;
    showLoading(true);
    try {
      const laws = await searchLawsByTitle(query, { limit: 31 });
      const hasMore = laws.length > 30;
      const display = hasMore ? laws.slice(0, 30) : laws;
      currentResults = display;
      showResults(display, query, hasMore);
      pushQueryHistory(query);
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
        'queryHistory', 'openedLawHistory', 'favorites', 'favFolders',
      ]);
      if (Array.isArray(data.queryHistory))     queryHistory     = data.queryHistory;
      if (Array.isArray(data.openedLawHistory)) openedLawHistory = data.openedLawHistory;
      if (Array.isArray(data.favorites))        favorites        = data.favorites;
      if (Array.isArray(data.favFolders))       favFolders       = data.favFolders;
      if (data.folderCollapsed && typeof data.folderCollapsed === 'object') folderCollapsed = data.folderCollapsed;
    } catch (_) {}
  }

  function pushQueryHistory(query) {
    if (!query) return;
    const idx = queryHistory.indexOf(query);
    if (idx !== -1) queryHistory.splice(idx, 1);
    queryHistory.unshift(query);
    if (queryHistory.length > HIST_MAX) queryHistory.length = HIST_MAX;
    chrome.storage.local.set({ queryHistory }).catch(() => {});
  }

  function pushOpenedLaw(law) {
    if (!law.lawId) return;
    const idx = openedLawHistory.findIndex(l => l.lawId === law.lawId);
    if (idx !== -1) openedLawHistory.splice(idx, 1);
    openedLawHistory.unshift(law);
    if (openedLawHistory.length > HIST_MAX) openedLawHistory.length = HIST_MAX;
    chrome.storage.local.set({ openedLawHistory }).catch(() => {});
  }

  function isFavorite(lawId) {
    return favorites.some(f => f.lawId === lawId);
  }

  function toggleFavorite(lawOrFields) {
    const fields = lawOrFields.lawId !== undefined ? lawOrFields : getLawFields(lawOrFields);
    const { lawId, lawName, lawNum, lawType } = fields;
    if (!lawId) return;
    const idx = favorites.findIndex(f => f.lawId === lawId);
    if (idx !== -1) {
      favorites.splice(idx, 1);
      showToast('お気に入りから削除しました');
    } else {
      favorites.unshift({ lawId, lawName, lawNum, lawType, folderId: null });
      if (favorites.length > FAV_MAX) favorites.length = FAV_MAX;
      showToast('お気に入りに追加しました');
    }
    chrome.storage.local.set({ favorites }).catch(() => {});
  }

  // （セッション保存・復元は廃止：起動時は常に空欄から開始）

  // ================================================
  // API レスポンス解析
  // ================================================
  // ================================================
  // 結果表示
  // ================================================
  function showResults(laws, query, hasMore = false) {
    isEmptyState        = false;
    resultsEl.innerHTML = '';
    focusedResultIndex  = -1;

    if (laws.length === 0) {
      resultsEl.innerHTML = `
        <div class="no-results">
          「${escapeHtml(query ?? '')}」に一致する法令が見つかりませんでした
          <a href="#" class="fallback-link" data-url="https://laws.e-gov.go.jp/">e-Govで直接検索する →</a>
        </div>`;
      resultsEl.querySelector('.fallback-link')?.addEventListener('click', (e) => {
        e.preventDefault(); chrome.tabs.create({ url: e.currentTarget.dataset.url }); window.close();
      });
      return;
    }

    // Mode2（開いた法令）に含まれる法令を上位表示
    const visitedIds = new Set(openedLawHistory.map(l => l.lawId));
    const sortedLaws = [
      ...laws.filter(l => visitedIds.has(getLawFields(l).lawId)),
      ...laws.filter(l => !visitedIds.has(getLawFields(l).lawId)),
    ];

    resultsEl.innerHTML = `<div class="results-label">${sortedLaws.length}件${hasMore ? '（上限）' : ''} &nbsp;｜&nbsp; ↑↓ 移動 ｜ Enter 開く ｜ Shift+Enter ★</div>`;
    const list = document.createElement('ul');
    list.className = 'results-list';

    // カーソル非表示 → マウス移動で復元 + ホバー有効化
    // カーソル非表示 + マウス移動でホバー有効化（描画直後の誤検知防止）
    hideCursorBriefly();

    sortedLaws.forEach((law, i) => {
      const { lawId, lawName, lawNum, lawType } = getLawFields(law);
      const isVisited = visitedIds.has(lawId);
      const fav       = isFavorite(lawId);
      const li        = document.createElement('li');
      li.className    = isVisited ? 'result-item result-item-visited' : 'result-item';
      li.innerHTML = `
        <div class="result-main">
          ${lawType ? `<span class="result-type">${escapeHtml(formatType(lawType))}</span>` : ''}
          <span class="result-name">${formatLawNameHtml(lawName)}</span>
          ${lawNum ? `<span class="result-num">${escapeHtml(lawNum)}</span>` : ''}
        </div>
        <button class="result-fav-btn${fav ? ' result-fav-active' : ''}"
                title="${fav ? 'お気に入りから削除 (Shift+Enter)' : 'お気に入りに追加 (Shift+Enter)'}">${fav ? '★' : '☆'}</button>
      `;
      li.querySelector('.result-fav-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleFavorite(law);
        updateFavBtnAt(i);
        searchInput.focus();
      });
      li.addEventListener('click', () => openResult(law));
      li.addEventListener('mouseenter', () => {
        if (!mainHoverEnabled) return;
        const items = resultsEl.querySelectorAll('.result-item');
        if (focusedResultIndex >= 0 && items[focusedResultIndex])
          items[focusedResultIndex].classList.remove('result-item-focused');
        focusedResultIndex = i;
        li.classList.add('result-item-focused');
      });
      list.appendChild(li);
    });
    currentResults = sortedLaws;
    resultsEl.appendChild(list);

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
    resultsEl.querySelector('.fallback-link')?.addEventListener('click', (e) => {
      e.preventDefault(); chrome.tabs.create({ url: e.currentTarget.dataset.url }); window.close();
    });
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
