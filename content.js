/**
 * e-Gov法令検索 拡張機能 - コンテンツスクリプト
 *
 * キーボードショートカット（入力欄フォーカス外）:
 *   0-9    : 条文ジャンプ（3.2.1 で 第3条第2項第1号 指定）
 *   h / l  : 条文ジャンプ履歴を前後に移動
 *   n / p  : 次/前の条文を画面上端に表示
 *   d / u  : 下/上へ80%スクロール
 *   s      : ページ内検索
 *   r      : 現在の法令名で法令検索
 *   c      : 条文番号の漢数字/アラビア数字の切り替え
 *   Esc    : ダイアログを閉じる
 */
(function () {
  'use strict';

  const shared = globalThis.EgovShared;
  const {
    buildLawUrl,
    escapeHtml,
    getLawFields,
  } = shared;
  const formatLawNameHtml = (name) => shared.formatLawNameHtml(name, 'egov-ext-law-name-muted');

  // ==================
  // 状態管理
  // ==================
  let activeDialog = null;
  let searchState  = { highlights: [], currentIndex: -1 };

  // ページ滞在中のみ保持する履歴（ドロップダウン用）
  let articleHistory = [];
  let searchHistory  = [];
  const HISTORY_MAX  = 10;

  // 条文ジャンプ ナビゲーション履歴（h/l キー用）
  let articleJumpHistory = [];
  let articleJumpCursor  = -1;
  let indicatorTimer     = null;

  // 数字表示モード
  let numberMode = 'kanji'; // 'kanji' | 'arabic'

  // かな変換済みフラグ（一方通行）
  let kanaConverted = false;

  // ショートカット有効/無効
  let extensionEnabled = true;
  let guideTooltipPinned = false;
  let autoMovedToFirstArticle = false;
  let activeFlashEl = null;
  let activeFlashOrigBg = '';
  let activeFlashOrigTr = '';
  let activeFlashTimer = null;
  let activeFlashTransitionTimer = null;
  let favoriteScrollSaveTimer = null;
  let favoriteScrollRestored = false;
  let favoritesCache = null;
  let favoritesCachePromise = null;
  let pinIndicatorTimer = null;
  let pinToastVisible = false;
  let pinToastPinned = false;
  let pinToastTimer = null;
  let pinToastRenderRaf = 0;
  let pinToastDefaultVisible = true;
  let parenthesesMuteMode = 'off'; // 'off' | 'flat' | 'nested'
  let parenthesesMutingInitialized = false;
  let mutedParenGroupSeq = 0;
  let activeMutedParenGroup = '';
  let articleElementsCache = null;
  const PIN_SLOT_ORDER = ['i', 'o', 'j', 'k', 'm'];
  const PIN_SLOT_CONFIG = {
    i: { color: '#ef6b73', label: 'i' },
    o: { color: '#f6b73c', label: 'o' },
    j: { color: '#5bbd72', label: 'j' },
    k: { color: '#4c8df6', label: 'k' },
    m: { color: '#9a6df2', label: 'm' },
  };

  // スクロール速度（'instant' | 'smooth'、デフォ: instant）
  let scrollBehavior = 'instant';
  chrome.storage.local.get(['scrollBehavior'], (data) => {
    if (data.scrollBehavior === 'smooth') scrollBehavior = 'smooth';
  });
  chrome.storage.local.get(['pinToastDefaultVisible'], (data) => {
    if (typeof data.pinToastDefaultVisible === 'boolean') pinToastDefaultVisible = data.pinToastDefaultVisible;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.scrollBehavior) scrollBehavior = changes.scrollBehavior.newValue;
    if (area === 'local' && changes.favorites) refreshFavoriteHeaderBadge();
    if (area === 'local' && changes.favorites) {
      favoritesCache = Array.isArray(changes.favorites.newValue) ? changes.favorites.newValue : [];
    }
    if (area === 'local' && changes.pinToastDefaultVisible) {
      pinToastDefaultVisible = !!changes.pinToastDefaultVisible.newValue;
      if (pinToastDefaultVisible) {
        pinToastPinned = true;
        showPinToast(false);
      } else if (pinToastPinned) {
        pinToastPinned = false;
        hidePinToast(true);
      }
    }
    if (area === 'session' && changes.colorPins) {
      refreshColorPinHighlights();
      if (pinToastVisible) schedulePinToastRender();
    }
  });
  window.addEventListener('resize', () => { if (pinToastVisible) schedulePinToastRender(); });
  window.addEventListener('scroll', () => { if (pinToastVisible) schedulePinToastRender(); }, { passive: true });

  // ==================
  // 履歴ユーティリティ
  // ==================
  function pushHistory(history, value) {
    if (!value) return;
    const idx = history.indexOf(value);
    if (idx !== -1) history.splice(idx, 1);
    history.unshift(value);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  }

  function pushJumpHistory(num) {
    if (!num) return;
    if (articleJumpCursor >= 0 && articleJumpCursor < articleJumpHistory.length - 1) {
      articleJumpHistory.splice(articleJumpCursor + 1);
    }
    if (articleJumpHistory[articleJumpHistory.length - 1] === num) {
      articleJumpCursor = articleJumpHistory.length - 1;
      return;
    }
    articleJumpHistory.push(num);
    if (articleJumpHistory.length > 50) articleJumpHistory.shift();
    articleJumpCursor = articleJumpHistory.length - 1;
  }

  function navigateJumpHistory(dir) {
    if (articleJumpHistory.length === 0) return;
    const newCursor = articleJumpCursor + dir;
    if (newCursor < 0 || newCursor >= articleJumpHistory.length) return;
    articleJumpCursor = newCursor;
    const raw   = articleJumpHistory[articleJumpCursor];
    const parts = raw.split('.');
    jumpToArticleWithDetail(parts[0], parts[1] || null, parts[2] || null);
    showJumpHistoryIndicator();
  }

  // ==================
  // 履歴インジケーター（画面下部）
  // ==================
  function numToDisplay(raw) {
    if (!raw) return '';
    const parts = raw.split('.');
    let s = '第' + parts[0].replace(/[-－‐ー_]/g, 'の').replace(/のの+/g, 'の') + '条';
    if (parts[1]) s += '第' + parts[1] + '項';
    if (parts[2]) s += '第' + parts[2] + '号';
    return s;
  }

  function showJumpHistoryIndicator() {
    let ind = document.getElementById('egov-jump-indicator');
    if (!ind) {
      ind = document.createElement('div');
      ind.id = 'egov-jump-indicator';
      document.body.appendChild(ind);
    }

    const current = articleJumpHistory[articleJumpCursor];
    const pos     = `${articleJumpCursor + 1} / ${articleJumpHistory.length}`;
    const CONTEXT = 5;

    const prevNums = [];
    for (let i = Math.max(0, articleJumpCursor - CONTEXT); i < articleJumpCursor; i++) {
      prevNums.push(articleJumpHistory[i]);
    }
    const nextNums = [];
    for (let i = articleJumpCursor + 1; i <= Math.min(articleJumpHistory.length - 1, articleJumpCursor + CONTEXT); i++) {
      nextNums.push(articleJumpHistory[i]);
    }

    function itemOpacity(dist) { return [0, 0.68, 0.50, 0.36, 0.24, 0.14][Math.min(dist, 5)]; }

    const prevHtml = prevNums.map((num, idx) => {
      const dist = prevNums.length - idx;
      return `<span class="egov-jump-ind-near" style="opacity:${itemOpacity(dist)}">${escapeHtml(numToDisplay(num))}</span>`;
    }).join('');

    const nextHtml = nextNums.map((num, idx) => {
      const dist = idx + 1;
      return `<span class="egov-jump-ind-near" style="opacity:${itemOpacity(dist)}">${escapeHtml(numToDisplay(num))}</span>`;
    }).join('');

    ind.innerHTML =
      `<div class="egov-jump-ind-inner">` +
        `<div class="egov-jump-ind-context egov-jump-ind-prev">${prevHtml}</div>` +
        `<span class="egov-jump-ind-current">${escapeHtml(numToDisplay(current))}<span class="egov-jump-ind-pos">${escapeHtml(pos)}</span></span>` +
        `<div class="egov-jump-ind-context egov-jump-ind-next">${nextHtml}</div>` +
      `</div>`;

    ind.style.setProperty('opacity', '1', 'important');
    ind.style.setProperty('display', 'flex', 'important');
    clearTimeout(indicatorTimer);
    indicatorTimer = setTimeout(() => {
      ind.style.setProperty('opacity', '0', 'important');
      setTimeout(() => { ind.style.setProperty('display', 'none', 'important'); }, 400);
    }, 2500);
  }

  // ==================
  // ユーティリティ
  // ==================
  function isInputActive() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    return (
      tag === 'input' || tag === 'textarea' || tag === 'select' ||
      el.isContentEditable || el.getAttribute('contenteditable') === 'true'
    );
  }

  function closeDialog() {
    if (activeDialog) { activeDialog.remove(); activeDialog = null; }
    clearHighlights();
  }

  function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function toFullWidth(s) {
    return String(s).replace(/[0-9]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
  }

  function isWithinMutedParen(node) {
    return !!node.parentElement?.closest('.egov-ext-muted-paren');
  }

  function getParenProcessingContainer(el) {
    return el?.closest('.sentence, .item > .sentence, .subitem1 > .sentence, .subitem2 > .sentence, .subitem3 > .sentence, .subitem4 > .sentence, .subitem5 > .sentence, .subitem6 > .sentence, .subitem7 > .sentence, .subitem8 > .sentence, .subitem9 > .sentence, .subitem10 > .sentence, .list1 > .sentence, .list2 > .sentence, .list3 > .sentence, .list4 > .sentence, .list5 > .sentence, .list6 > .sentence, .list7 > .sentence, .list8 > .sentence, .list9 > .sentence, .list10 > .sentence, ._div_ParagraphSentence, ._div_ItemSentence, ._div_Subitem1Sentence, ._div_Subitem2Sentence, ._div_Subitem3Sentence, ._div_Subitem4Sentence, ._div_Subitem5Sentence, ._div_Subitem6Sentence, ._div_Subitem7Sentence, ._div_Subitem8Sentence, ._div_Subitem9Sentence, ._div_Subitem10Sentence, ._div_ListSentence, ._div_List1Sentence, ._div_List2Sentence, ._div_List3Sentence, ._div_List4Sentence, ._div_List5Sentence, ._div_List6Sentence, ._div_List7Sentence, ._div_List8Sentence, ._div_List9Sentence, ._div_List10Sentence');
  }

  function isWrappableBodyTextNode(node) {
    if (!node || !node.parentElement) return false;
    if (!node.textContent) return false;
    if (isWithinMutedParen(node)) return false;
    const el = node.parentElement;
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'textarea', 'input', 'select', 'option'].includes(tag)) return false;
    if (el.closest('em.articleheading, .articleheading')) return false;
    if (!getParenProcessingContainer(el)) return false;
    if (el.closest('.egov-ext-overlay, #TOC, #egov-ext-guide, #egov-jump-indicator, #egov-pin-indicator, #egov-ext-pin-toast')) return false;
    return true;
  }

  function getMutedParenDepthClass(depth) {
    return String(Math.min(Math.max(depth, 1), 6));
  }

  function nextMutedParenGroupId() {
    mutedParenGroupSeq += 1;
    return `egov-paren-${mutedParenGroupSeq}`;
  }

  function appendMutedParenSegment(parent, text, depth, inLink, groupId) {
    if (!text) return;
    if (depth <= 0) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    const span = document.createElement('span');
    span.className = `egov-ext-muted-paren${inLink ? ' egov-ext-muted-paren-link' : ''}`;
    span.dataset.depth = getMutedParenDepthClass(depth);
    if (groupId) span.dataset.group = groupId;
    span.textContent = text;
    parent.appendChild(span);
  }

  function wrapFullWidthParenthesesInTextNode(node, state = { depth: 0, activeGroupId: '' }) {
    if (!isWrappableBodyTextNode(node)) return { changed: false, state };

    const text = node.textContent || '';
    let depth = Math.max(0, state.depth || 0);
    let activeGroupId = state.activeGroupId || '';
    let segmentDepth = depth > 0 ? 1 : 0;
    let segmentGroupId = activeGroupId;
    let buffer = '';
    let changed = false;
    const frag = document.createDocumentFragment();

    function flushBuffer() {
      if (!buffer) return;
      appendMutedParenSegment(frag, buffer, segmentDepth, !!node.parentElement.closest('a'), segmentGroupId);
      buffer = '';
    }

    for (const ch of text) {
      if (ch === '\uFF08') {
        flushBuffer();
        if (depth === 0) activeGroupId = nextMutedParenGroupId();
        depth += 1;
        segmentDepth = 1;
        segmentGroupId = activeGroupId;
        buffer += ch;
        changed = true;
        continue;
      }

      if (ch === '\uFF09') {
        buffer += ch;
        flushBuffer();
        depth = Math.max(0, depth - 1);
        segmentDepth = depth > 0 ? 1 : 0;
        if (depth === 0) activeGroupId = '';
        segmentGroupId = activeGroupId;
        changed = true;
        continue;
      }

      if (segmentDepth !== depth) {
        flushBuffer();
        segmentDepth = depth > 0 ? 1 : 0;
        segmentGroupId = activeGroupId;
      }
      buffer += ch;
    }

    flushBuffer();

    if (changed || depth > 0 || (state.depth || 0) > 0) {
      node.parentNode.replaceChild(frag, node);
      return { changed: true, state: { depth, activeGroupId } };
    }
    return { changed: false, state: { depth, activeGroupId } };
  }

  function processSentenceElement(sentence) {
    if (!sentence) return;
    const walker = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return isWrappableBodyTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });

    const nodes = [];
    let current;
    while ((current = walker.nextNode())) nodes.push(current);
    let state = { depth: 0, activeGroupId: '' };
    nodes.forEach((node) => {
      const result = wrapFullWidthParenthesesInTextNode(node, state);
      state = result.state;
    });
  }

  function setMutedParenHoverGroup(groupId) {
    if (activeMutedParenGroup === groupId) return;
    if (activeMutedParenGroup) {
      document.querySelectorAll(`.egov-ext-muted-paren-hover[data-group="${activeMutedParenGroup}"]`).forEach((el) => {
        el.classList.remove('egov-ext-muted-paren-hover');
      });
    }
    activeMutedParenGroup = groupId || '';
    if (!activeMutedParenGroup) return;
    document.querySelectorAll(`.egov-ext-muted-paren[data-group="${activeMutedParenGroup}"]`).forEach((el) => {
      el.classList.add('egov-ext-muted-paren-hover');
    });
  }

  function muteFullWidthParenthesesInBody(root = document.querySelector('#provisionview') || document.body) {
    if (!root) return;
    if (root.nodeType === Node.ELEMENT_NODE && getParenProcessingContainer(root)) {
      processSentenceElement(root);
      return;
    }
    root.querySelectorAll?.('.sentence, ._div_ParagraphSentence, ._div_ItemSentence, ._div_Subitem1Sentence, ._div_Subitem2Sentence, ._div_Subitem3Sentence, ._div_Subitem4Sentence, ._div_Subitem5Sentence, ._div_Subitem6Sentence, ._div_Subitem7Sentence, ._div_Subitem8Sentence, ._div_Subitem9Sentence, ._div_Subitem10Sentence, ._div_ListSentence, ._div_List1Sentence, ._div_List2Sentence, ._div_List3Sentence, ._div_List4Sentence, ._div_List5Sentence, ._div_List6Sentence, ._div_List7Sentence, ._div_List8Sentence, ._div_List9Sentence, ._div_List10Sentence').forEach((sentence) => {
      processSentenceElement(sentence);
    });
  }

  function setupBodyParenthesesMuting() {
    if (parenthesesMutingInitialized) return;
    parenthesesMutingInitialized = true;
    muteFullWidthParenthesesInBody();

    const root = document.querySelector('#provisionview') || document.body;
    if (!root) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            const sentence = getParenProcessingContainer(node.parentElement);
            if (sentence) {
              processSentenceElement(sentence);
            }
            continue;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.closest?.('.egov-ext-muted-paren')) continue;
          if (getParenProcessingContainer(node) === node) {
            processSentenceElement(node);
            continue;
          }
          muteFullWidthParenthesesInBody(node);
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });

    root.addEventListener('mouseover', (event) => {
      const target = event.target instanceof Element ? event.target.closest('.egov-ext-muted-paren[data-group]') : null;
      if (!target) return;
      setMutedParenHoverGroup(target.dataset.group || '');
    });

    root.addEventListener('mouseout', (event) => {
      const target = event.target instanceof Element ? event.target.closest('.egov-ext-muted-paren[data-group]') : null;
      if (!target) return;
      const related = event.relatedTarget instanceof Element ? event.relatedTarget.closest('.egov-ext-muted-paren[data-group]') : null;
      if (related?.dataset.group === target.dataset.group) return;
      setMutedParenHoverGroup('');
    });
  }

  function applyParenthesesMuteMode() {
    const root = document.body;
    if (!root) return;
    if (parenthesesMuteMode === 'off') {
      delete root.dataset.egovParenMode;
    } else {
      root.dataset.egovParenMode = parenthesesMuteMode;
    }
  }

  function toggleParenthesesMute(mode) {
    if (!parenthesesMutingInitialized) setupBodyParenthesesMuting();
    parenthesesMuteMode = parenthesesMuteMode === mode ? 'off' : mode;
    applyParenthesesMuteMode();
  }

  function getCurrentLawIdFromUrl() {
    const m = location.pathname.match(/\/law\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function getCurrentLawInfo() {
    return {
      lawId: getCurrentLawIdFromUrl(),
      lawName: getCurrentLawName(),
      lawNum: '',
      lawType: '',
      folderId: null,
    };
  }

  async function getFavoritesList() {
    try {
      const data = await chrome.storage.local.get(['favorites']);
      return Array.isArray(data.favorites) ? data.favorites : [];
    } catch (_) {
      return [];
    }
  }

  async function setFavoritesList(favorites) {
    try {
      await chrome.storage.local.set({ favorites });
    } catch (_) {}
  }

  async function setCurrentLawFavorite(shouldFavorite) {
    const law = getCurrentLawInfo();
    if (!law.lawId) return false;

    const favorites = await getFavoritesList();
    const idx = favorites.findIndex((f) => f.lawId === law.lawId);
    const isFavorite = idx !== -1;
    if (shouldFavorite === isFavorite) return isFavorite;

    if (shouldFavorite) {
      favorites.unshift(law);
      if (favorites.length > 50) favorites.length = 50;
    } else {
      favorites.splice(idx, 1);
    }

    await setFavoritesList(favorites);
    return shouldFavorite;
  }

  function updateFavoriteHeaderBadgeState(badge, isFavorite) {
    if (!badge) return;
    badge.classList.toggle('is-favorite', !!isFavorite);
    badge.classList.toggle('is-not-favorite', !isFavorite);
    badge.textContent = '★';
    badge.title = isFavorite ? 'お気に入りに登録済み' : 'お気に入り未登録';
    badge.setAttribute('aria-label', isFavorite ? 'お気に入りに登録済み' : 'お気に入り未登録');
  }

  function ensureHeaderControlHost() {
    const heading = document.querySelector('h1.appid');
    if (!heading) return null;

    let host = document.getElementById('egov-ext-header-controls');
    if (host) return host;

    host = document.createElement('span');
    host.id = 'egov-ext-header-controls';
    host.className = 'egov-ext-header-controls';
    heading.insertAdjacentElement('afterend', host);
    return host;
  }

  function ensureFavoriteHeaderBadge() {
    const host = ensureHeaderControlHost();
    if (!host) return null;

    let badge = document.getElementById('egov-ext-favorite-header-badge');
    if (badge) return badge;

    badge = document.createElement('button');
    badge.id = 'egov-ext-favorite-header-badge';
    badge.type = 'button';
    badge.className = 'egov-ext-favorite-header-badge is-not-favorite';
    badge.textContent = '★';
    badge.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const favorites = await getFavoritesList();
      const lawId = getCurrentLawIdFromUrl();
      const isFavorite = favorites.some((f) => f.lawId === lawId);
      const nextFavorite = !isFavorite;
      await setCurrentLawFavorite(nextFavorite);
      updateFavoriteHeaderBadgeState(badge, nextFavorite);
      showPinIndicator(nextFavorite ? 'お気に入りに追加しました' : 'お気に入りから外しました');
    });

    host.appendChild(badge);
    return badge;
  }

  async function refreshFavoriteHeaderBadge() {
    const lawId = getCurrentLawIdFromUrl();
    if (!lawId) return;
    const badge = ensureFavoriteHeaderBadge();
    if (!badge) return;

    const favorites = await getFavoritesList();
    updateFavoriteHeaderBadgeState(badge, favorites.some((f) => f.lawId === lawId));
  }

  function setupFavoriteHeaderBadge() {
    if (ensureFavoriteHeaderBadge()) {
      refreshFavoriteHeaderBadge();
      return;
    }

    const observer = new MutationObserver(() => {
      if (!ensureFavoriteHeaderBadge()) return;
      observer.disconnect();
      refreshFavoriteHeaderBadge();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 10000);
  }

  function showPinIndicator(message, anchorEl = null) {
    let ind = document.getElementById('egov-pin-indicator');
    if (!ind) {
      ind = document.createElement('div');
      ind.id = 'egov-pin-indicator';
      ind.style.setProperty('position', 'fixed', 'important');
      ind.style.setProperty('z-index', '2147483647', 'important');
      ind.style.setProperty('padding', '8px 12px', 'important');
      ind.style.setProperty('border-radius', '10px', 'important');
      ind.style.setProperty('background', 'rgba(40, 40, 56, 0.92)', 'important');
      ind.style.setProperty('color', '#fff', 'important');
      ind.style.setProperty('font-size', '12px', 'important');
      ind.style.setProperty('box-shadow', '0 8px 24px rgba(0,0,0,0.25)', 'important');
      ind.style.setProperty('opacity', '0', 'important');
      ind.style.setProperty('transition', 'opacity 0.18s ease', 'important');
      document.body.appendChild(ind);
    }

    ind.textContent = message;
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      const top = Math.max(12, rect.top - 34);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - 220));
      ind.style.setProperty('left', `${Math.round(left)}px`, 'important');
      ind.style.setProperty('top', `${Math.round(top)}px`, 'important');
      ind.style.setProperty('right', 'auto', 'important');
      ind.style.setProperty('bottom', 'auto', 'important');
    } else {
      ind.style.setProperty('right', '16px', 'important');
      ind.style.setProperty('bottom', '16px', 'important');
      ind.style.setProperty('left', 'auto', 'important');
      ind.style.setProperty('top', 'auto', 'important');
    }
    ind.style.setProperty('display', 'block', 'important');
    ind.style.setProperty('opacity', '1', 'important');

    clearTimeout(pinIndicatorTimer);
    pinIndicatorTimer = setTimeout(() => {
      ind.style.setProperty('opacity', '0', 'important');
      setTimeout(() => { ind.style.setProperty('display', 'none', 'important'); }, 180);
    }, 1400);
  }

  function normalizeColorPins(raw) {
    const pins = {};
    for (const slotKey of PIN_SLOT_ORDER) {
      pins[slotKey] = raw && typeof raw === 'object' && raw[slotKey] && typeof raw[slotKey] === 'object'
        ? raw[slotKey]
        : null;
    }
    return pins;
  }

  async function getColorPins() {
    try {
      const data = await chrome.storage.session.get(['colorPins']);
      return normalizeColorPins(data.colorPins);
    } catch (_) {
      return normalizeColorPins(null);
    }
  }

  async function saveColorPins(colorPins) {
    try {
      await chrome.storage.session.set({ colorPins: normalizeColorPins(colorPins) });
      return true;
    } catch (_) {
      return false;
    }
  }

  function getArticleAbsoluteTop(el) {
    const rect = el.getBoundingClientRect();
    const container = getScrollContainer();
    if (container) {
      const cRect = container.getBoundingClientRect();
      return rect.top - cRect.top + container.scrollTop;
    }
    return rect.top + window.scrollY;
  }

  function getArticleAtViewport25pct() {
    const articles = getAllArticles();
    if (articles.length === 0) return null;

    const container = getScrollContainer();
    const containerRect = container ? container.getBoundingClientRect() : null;
    const anchorTop = container ? container.clientHeight * 0.25 : window.innerHeight * 0.25;
    let current = articles[0];

    for (const article of articles) {
      const rect = article.getBoundingClientRect();
      const top = containerRect ? rect.top - containerRect.top : rect.top;
      if (top <= anchorTop + 1) current = article;
      else break;
    }
    return current;
  }

  async function waitForArticles(timeoutMs = 8000) {
    if (getAllArticles().length > 0) return true;

    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (getAllArticles().length === 0) return;
        observer.disconnect();
        resolve(true);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(getAllArticles().length > 0);
      }, timeoutMs);
    });
  }

  function buildColorPinRecord(slotKey, articleEl) {
    return {
      slotKey,
      lawId: getCurrentLawIdFromUrl(),
      lawName: getCurrentLawName(),
      articleId: articleEl.id || '',
      scrollTop: Math.max(0, Math.round(getArticleAbsoluteTop(articleEl))),
      updatedAt: Date.now(),
    };
  }

  function findPinSlotOnArticle(colorPins, lawId, articleId, excludeSlotKey) {
    for (const slotKey of PIN_SLOT_ORDER) {
      if (slotKey === excludeSlotKey) continue;
      const pin = colorPins[slotKey];
      if (pin && pin.lawId === lawId && pin.articleId === articleId) return slotKey;
    }
    return '';
  }

  function getPinArticleElement(pin) {
    if (!pin || pin.lawId !== getCurrentLawIdFromUrl()) return null;
    if (pin.articleId) {
      const direct = document.getElementById(pin.articleId);
      if (direct) return direct;
    }

    const articles = getAllArticles();
    if (articles.length === 0 || typeof pin.scrollTop !== 'number') return null;

    let nearest = null;
    let nearestDiff = Infinity;
    for (const article of articles) {
      const diff = Math.abs(getArticleAbsoluteTop(article) - pin.scrollTop);
      if (diff < nearestDiff) {
        nearest = article;
        nearestDiff = diff;
      }
    }
    return nearestDiff <= 120 ? nearest : null;
  }

  function clearColorPinHighlights() {
    for (const el of document.querySelectorAll('.egov-ext-color-pin')) {
      el.classList.remove('egov-ext-color-pin');
      el.style.removeProperty('--egov-pin-color');
      delete el.dataset.egovPinKey;
      delete el.dataset.egovPinSlot;
    }
  }

  async function refreshColorPinHighlights() {
    clearColorPinHighlights();
    const lawId = getCurrentLawIdFromUrl();
    if (!lawId) return;

    const colorPins = await getColorPins();
    for (const slotKey of PIN_SLOT_ORDER) {
      const pin = colorPins[slotKey];
      if (!pin || pin.lawId !== lawId) continue;
      const article = getPinArticleElement(pin);
      if (!article) continue;
      article.classList.add('egov-ext-color-pin');
      article.style.setProperty('--egov-pin-color', PIN_SLOT_CONFIG[slotKey].color);
      article.dataset.egovPinSlot = slotKey;
      article.dataset.egovPinKey = PIN_SLOT_CONFIG[slotKey].label;
    }
  }

  function ensurePinToast() {
    let toast = document.getElementById('egov-ext-pin-toast');
    if (toast) return toast;

    toast = document.createElement('div');
    toast.id = 'egov-ext-pin-toast';
    toast.className = 'egov-ext-pin-toast';
    toast.innerHTML = '<div class="egov-ext-pin-toast-slots"></div>';
    toast.addEventListener('click', (e) => {
      const slotEl = e.target.closest('.egov-ext-pin-slot');
      if (!slotEl) return;
      const slotKey = slotEl.dataset.slotKey;
      if (!slotKey || !PIN_SLOT_ORDER.includes(slotKey)) return;
      e.preventDefault();
      e.stopPropagation();
      handleColorPinShortcut(slotKey);
    });
    const host = ensureHeaderControlHost();
    if (host) host.appendChild(toast);
    else document.body.appendChild(toast);
    return toast;
  }

  function positionPinToast(toast) {
    const host = ensureHeaderControlHost();
    if (host && toast.parentElement !== host) host.appendChild(toast);
  }

  function hidePinToast(force = false) {
    if (!force && pinToastPinned) return;
    const toast = document.getElementById('egov-ext-pin-toast');
    pinToastVisible = false;
    if (pinToastRenderRaf) {
      cancelAnimationFrame(pinToastRenderRaf);
      pinToastRenderRaf = 0;
    }
    clearTimeout(pinToastTimer);
    pinToastTimer = null;
    if (toast) toast.classList.remove('is-visible');
  }

  function schedulePinToastRender() {
    if (pinToastRenderRaf) return;
    pinToastRenderRaf = requestAnimationFrame(() => {
      pinToastRenderRaf = 0;
      if (pinToastVisible) renderPinToast();
    });
  }

  async function renderPinToast() {
    const toast = ensurePinToast();
    const slotsEl = toast.querySelector('.egov-ext-pin-toast-slots');
    const colorPins = await getColorPins();
    const currentLawId = getCurrentLawIdFromUrl();

    slotsEl.innerHTML = PIN_SLOT_ORDER.map((slotKey) => {
      const pin = colorPins[slotKey];
      const classes = [
        'egov-ext-pin-slot',
        pin ? 'is-set' : 'is-empty',
        pin && pin.lawId === currentLawId ? 'is-current-law' : '',
      ].filter(Boolean).join(' ');
      const title = pin
        ? `${slotKey}: ${pin.lawName || pin.lawId}`
        : `${slotKey}: 未設定`;
      return `
        <div class="${classes}" data-slot-key="${slotKey}" title="${escapeHtml(title)}" style="--egov-pin-color:${PIN_SLOT_CONFIG[slotKey].color}">
          <span class="egov-ext-pin-slot-dot">●</span>
          <span class="egov-ext-pin-slot-key">${escapeHtml(slotKey)}</span>
        </div>
      `;
    }).join('');

    positionPinToast(toast);
    toast.classList.add('is-visible');
  }

  function showPinToast(temporary = false) {
    clearTimeout(pinToastTimer);
    pinToastVisible = true;
    if (!temporary) pinToastPinned = true;
    schedulePinToastRender();
    if (temporary) {
      pinToastTimer = setTimeout(() => {
        if (!pinToastPinned) hidePinToast(true);
      }, 1600);
    }
  }

  function togglePinToast() {
    if (pinToastPinned) {
      pinToastPinned = false;
      hidePinToast(true);
    } else {
      pinToastPinned = true;
      showPinToast(false);
    }
  }

  async function refreshPinToastAfterMutation() {
    if (pinToastPinned) {
      schedulePinToastRender();
      return;
    }
    showPinToast(true);
  }

  function ensureArticleVisibleForPin(article) {
    if (!article) return;
    const container = getScrollContainer();
    const rect = article.getBoundingClientRect();
    if (container) {
      const cRect = container.getBoundingClientRect();
      const fullyVisible = rect.top >= cRect.top && rect.bottom <= cRect.bottom;
      if (!fullyVisible) scrollToElement25pct(article);
      return;
    }

    const fullyVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
    if (!fullyVisible) scrollToElement25pct(article);
  }

  async function placeColorPin(slotKey) {
    const ready = await waitForArticles();
    if (!ready) {
      showPinIndicator('条文の読み込み完了後にもう一度試してください');
      return;
    }
    const article = getArticleAtViewport25pct();
    if (!article) {
      showPinIndicator('条文が見つかりません');
      return;
    }

    const lawId = getCurrentLawIdFromUrl();
    const colorPins = await getColorPins();
    const newPin = buildColorPinRecord(slotKey, article);
    const existingSlotPin = colorPins[slotKey];
    const conflictingSlotKey = findPinSlotOnArticle(colorPins, lawId, newPin.articleId, slotKey);

    if (existingSlotPin && existingSlotPin.lawId === lawId && existingSlotPin.articleId === newPin.articleId) {
      colorPins[slotKey] = null;
      if (!await saveColorPins(colorPins)) {
        showPinIndicator('ピン解除の保存に失敗しました');
        return;
      }
      await refreshColorPinHighlights();
      await refreshPinToastAfterMutation();
      showPinIndicator(`${slotKey} のピンを外しました`, article);
      return;
    }

    if (conflictingSlotKey) {
      if (!window.confirm(`この条文には ${conflictingSlotKey} のピンがあります。${slotKey} に入れ替えますか？`)) return;
      colorPins[conflictingSlotKey] = null;
    }

    colorPins[slotKey] = newPin;
    if (!await saveColorPins(colorPins)) {
      showPinIndicator('ピン設定の保存に失敗しました');
      return;
    }
    await refreshColorPinHighlights();
    ensureArticleVisibleForPin(article);
    await refreshPinToastAfterMutation();
    showPinIndicator(`${slotKey} のピンを設定しました`, article);
  }

  async function jumpToStoredColorPin(pin) {
    const ready = await waitForArticles();
    if (!ready) return false;
    const article = getPinArticleElement(pin);
    if (article) {
      clearHighlights();
      scrollToElement25pct(article);
      requestAnimationFrame(() => {
        flashElementHighlight(article);
      });
      return true;
    }
    return false;
  }

  async function jumpToColorPinSlot(slotKey) {
    const colorPins = await getColorPins();
    const pin = colorPins[slotKey];
    if (!pin) {
      showPinIndicator(`${slotKey} のピンは未設定です`);
      return;
    }

    if (pin.lawId === getCurrentLawIdFromUrl()) {
      const ok = await jumpToStoredColorPin(pin);
      if (ok) {
        showPinIndicator(`${slotKey} のピンへ移動しました`);
        return;
      }
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: 'egov-jump-color-pin', pin });
      if (!response || !response.ok) showPinIndicator('別タブのピン移動に失敗しました');
    } catch (_) {
      showPinIndicator('別タブのピン移動に失敗しました');
    }
  }

  async function forceRemoveColorPinSlot(slotKey) {
    const colorPins = await getColorPins();
    const pin = colorPins[slotKey];
    if (!pin) {
      showPinIndicator(`${slotKey} のピンは未設定です`);
      return;
    }

    colorPins[slotKey] = null;
    if (!await saveColorPins(colorPins)) {
      showPinIndicator('ピン解除の保存に失敗しました');
      return;
    }
    await refreshColorPinHighlights();
    await refreshPinToastAfterMutation();
    showPinIndicator(`${slotKey} のピンを強制解除しました`);
  }


  async function handleColorPinShortcut(slotKey) {
    const ready = await waitForArticles();
    if (!ready) {
      showPinIndicator('条文の読み込み完了後にもう一度試してください');
      return;
    }
    const article = getArticleAtViewport25pct();
    if (!article) {
      showPinIndicator('条文が見つかりません');
      return;
    }

    const currentLawId = getCurrentLawIdFromUrl();
    const currentArticleId = article.id || '';
    const colorPins = await getColorPins();
    const pin = colorPins[slotKey];

    if (pin && pin.lawId === currentLawId && pin.articleId === currentArticleId) {
      await placeColorPin(slotKey);
      return;
    }

    if (pin) {
      await jumpToColorPinSlot(slotKey);
      return;
    }

    await placeColorPin(slotKey);
  }

  const KANJI_NUMS = ['〇','一','二','三','四','五','六','七','八','九',
                      '十','十一','十二','十三','十四','十五','十六','十七','十八','十九',
                      '二十','二十一','二十二','二十三','二十四','二十五','二十六','二十七','二十八','二十九','三十'];
  function toKanjiNum(n) { return KANJI_NUMS[n] || String(n); }

  // 漢数字パーサー（〜999）
  const _KV = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  function parseKanjiNum(s) {
    let v = 0, rem = s;
    const h = rem.match(/^([一二三四五六七八九])?百(.*)/);
    if (h) { v += (h[1] ? _KV[h[1]] : 1) * 100; rem = h[2]; }
    const j = rem.match(/^([一二三四五六七八九])?十(.*)/);
    if (j) { v += (j[1] ? _KV[j[1]] : 1) * 10; rem = j[2]; }
    if (rem && _KV[rem]) v += _KV[rem];
    return v;
  }

  // 整数（1-999）→ 漢数字文字列
  function numToKanjiStr(n) {
    if (n <= 0 || n >= 1000) return null;
    const ONES = ['','一','二','三','四','五','六','七','八','九'];
    const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), o = n % 10;
    let s = '';
    if (h) s += (h === 1 ? '' : ONES[h]) + '百';
    if (t) s += (t === 1 ? '' : ONES[t]) + '十';
    if (o) s += ONES[o];
    return s || null;
  }

  // テキスト内の漢数字 → 全角アラビア数字
  // ルール: 千以上の単位を含む場合は万/億/兆 の前の係数のみ変換、含まない場合は全変換
  function kanjiToArabicInText(text) {
    return text.replace(/[一二三四五六七八九十百千万億兆]+/g, (match) => {
      if (/千/.test(match)) {
        // 千を含む → 万/億/兆 の前の[一-百]セグメントのみ変換
        return match.replace(/([一二三四五六七八九十百]+)(?=[万億兆])/g, (seg) => {
          const n = parseKanjiNum(seg);
          return n > 0 ? toFullWidth(String(n)) : seg;
        });
      }
      // 千を含まない → [一-百]+ セグメントをすべて変換
      return match.replace(/[一二三四五六七八九十百]+/g, (seg) => {
        const n = parseKanjiNum(seg);
        return n > 0 ? toFullWidth(String(n)) : seg;
      });
    });
  }

  // テキスト内のアラビア数字（全角・半角どちらも対象、1-999）→ 漢数字
  function arabicToKanjiInText(text) {
    return text.replace(/[０-９0-9]+/g, (match) => {
      // 全角 → 半角に正規化してから parseInt
      const ascii = match.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
      const n = parseInt(ascii, 10);
      if (n >= 1 && n <= 999) return numToKanjiStr(n) || match;
      return match;
    });
  }

  // 丸数字 ①-⑳ → 漢数字
  const _CIRCLED = ['','①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩',
                       '⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];
  function circledToKanji(c) {
    const n = c.charCodeAt(0) - 0x245F; // ① = U+2460 → n = 1
    if (n < 1 || n > 20) return c;
    return numToKanjiStr(n) || c;
  }

  // APIレスポンスから法令フィールドを取り出す
  // ページ上部25%の位置に要素をスクロール表示する
  function scrollToElement25pct(el) {
    const container = getScrollContainer();
    const rect = el.getBoundingClientRect();
    if (container) {
      const cRect  = container.getBoundingClientRect();
      const absTop = rect.top - cRect.top + container.scrollTop;
      container.scrollTo({ top: Math.max(0, absTop - container.clientHeight * 0.25), behavior: scrollBehavior });
    } else {
      const absTop = rect.top + window.scrollY;
      window.scrollTo({ top: Math.max(0, absTop - window.innerHeight * 0.25), behavior: scrollBehavior });
    }
  }

  // ==================
  // キーボードイベント
  // ==================
  document.addEventListener('keydown', (e) => {
    // Alt+P: ショートカット有効/無効トグル（入力中・ダイアログ中でも動作）
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      extensionEnabled = !extensionEnabled;
      updateGuideButtonState();
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'egov-open-options-page' }).catch(() => {});
      return;
    }

    if (guideTooltipPinned) {
      hideShortcutGuideTooltip();
      e.preventDefault();
      return;
    }

    const isGuideShortcut =
      e.key === '?' ||
      (e.shiftKey && e.key === '/') ||
      (e.shiftKey && e.code === 'Slash');
    if (!activeDialog && !isInputActive() && !e.ctrlKey && !e.altKey && !e.metaKey && isGuideShortcut) {
      if (document.querySelector('#provisionview')) {
        e.preventDefault();
        showShortcutGuideTooltip();
        return;
      }
    }

    if (isInputActive()) return;

    if (e.key === 'Escape') {
      if (pinToastVisible && !pinToastPinned) {
        e.preventDefault();
        hidePinToast(true);
        return;
      }
      if (activeDialog) { e.preventDefault(); closeDialog(); }
      return;
    }

    // ショートカット無効中はここで止める
    if (!extensionEnabled) return;

    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key.length > 1) return;

    // ダイアログ非表示時のみ有効なキー
    if (!activeDialog) {
      const lowerKey = e.key.toLowerCase();
      if (e.shiftKey && lowerKey === 'g') { e.preventDefault(); toggleParenthesesMute('nested'); return; }
      if (e.shiftKey && PIN_SLOT_ORDER.includes(lowerKey)) { e.preventDefault(); forceRemoveColorPinSlot(lowerKey); return; }
      if (e.shiftKey && lowerKey === 'h') { e.preventDefault(); convertKatakanaToHiragana(); return; }
      if (e.key === 'g') { e.preventDefault(); toggleParenthesesMute('flat'); return; }
      if (e.key === 'h') { e.preventDefault(); navigateJumpHistory(-1); return; }
      if (e.key === 'l') { e.preventDefault(); navigateJumpHistory(+1); return; }
      if (e.key === 'b') { e.preventDefault(); togglePinToast(); return; }
      if (PIN_SLOT_ORDER.includes(lowerKey)) { e.preventDefault(); handleColorPinShortcut(lowerKey); return; }
      if (e.key === 'd') { e.preventDefault(); scrollPage(+0.8); return; }
      if (e.key === 'u') { e.preventDefault(); scrollPage(-0.8); return; }
      if (e.key === 'n') { e.preventDefault(); navigateArticle(+1); return; }
      if (e.key === 'p') { e.preventDefault(); navigateArticle(-1); return; }
      if (e.key === 'f') { e.preventDefault(); showFavoriteDialog(); return; }
      if (e.key === 'c') { e.preventDefault(); toggleNumberMode(); return; }
    }

    e.preventDefault();
    closeDialog();

    if (/^[0-9]$/.test(e.key)) {
      showArticleDialog(e.key);
    } else if (e.key === 's') {
      showSearchDialog();
    } else if (e.key === 'r') {
      showLawSearchDialog();
    }
  }, true);

  // ==================
  // ダイアログ生成ファクトリ
  // ==================
  function createDialog(innerHtml, modeClass) {
    const overlay = document.createElement('div');
    overlay.className = 'egov-ext-overlay';
    if (modeClass) overlay.classList.add(modeClass);
    const dialog = document.createElement('div');
    dialog.className = 'egov-ext-dialog';
    dialog.innerHTML = innerHtml;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    activeDialog = overlay;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });
    dialog.querySelector('.egov-ext-close')?.addEventListener('click', closeDialog);
    return dialog;
  }

  async function showFavoriteDialog() {
    const law = getCurrentLawInfo();
    if (!law.lawId) return;

    const favorites = await getFavoritesList();
    const isFavorite = favorites.some((f) => f.lawId === law.lawId);
    const nextFavorite = !isFavorite;
    await setCurrentLawFavorite(nextFavorite);
    showPinIndicator(nextFavorite ? 'お気に入りに追加しました' : 'お気に入りから外しました');
  }

  // ==================
  // 履歴ドロップダウン
  // ==================
  function buildHistoryDropdown(input, history, onSelect) {
    const wrap = input.parentElement;
    wrap.style.position = 'relative';
    const dropdown = document.createElement('div');
    dropdown.className = 'egov-ext-history-dropdown';
    dropdown.style.display = 'none';
    wrap.appendChild(dropdown);

    let highlightedIndex = -1;
    let hoverEnabled = false;

    function render() {
      dropdown.innerHTML = '';
      highlightedIndex = -1;
      history.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'egov-ext-history-item';
        div.textContent = item;
        div.addEventListener('mousedown', (e) => { e.preventDefault(); select(i); });
        div.addEventListener('mouseenter', () => { if (hoverEnabled) setHighlight(i); });
        dropdown.appendChild(div);
      });
    }

    function setHighlight(index) {
      const items = dropdown.querySelectorAll('.egov-ext-history-item');
      items.forEach((el, i) => {
        el.classList.toggle('egov-ext-history-item-focused', i === index);
      });
      highlightedIndex = index;
      if (index >= 0) input.value = history[index];
      if (index >= 0 && items[index]) {
        items[index].scrollIntoView({ block: 'nearest' });
      }
    }

    function moveHighlight(direction) {
      if (history.length === 0) return;
      const next = highlightedIndex < 0
        ? (direction > 0 ? 0 : history.length - 1)
        : (highlightedIndex + direction + history.length) % history.length;
      setHighlight(next);
    }

    function select(index) {
      const value = history[index];
      if (!value) return;
      pushHistory(history, value);
      input.value = value;
      hide();
      onSelect(value);
    }

    function show() {
      if (history.length === 0) return;
      hoverEnabled = false;
      setTimeout(() => { hoverEnabled = true; }, 250);
      render();
      dropdown.scrollTop = 0;
      dropdown.style.display = 'block';
    }

    function hide() { dropdown.style.display = 'none'; highlightedIndex = -1; }
    function isVisible() { return dropdown.style.display !== 'none'; }
    function getCurrentValue() { return highlightedIndex >= 0 ? history[highlightedIndex] : null; }

    return { show, hide, isVisible, moveHighlight, getCurrentValue, select: () => select(highlightedIndex) };
  }

  // ==================
  // 条文ジャンプ ダイアログ
  // ==================
  function showArticleDialog(pressedDigit) {
    const initial = pressedDigit || '';

    const dialog = createDialog(`
      <div class="egov-ext-dialog-header">
        <div class="egov-ext-dialog-title">
          <span class="egov-ext-title-icon">⚡</span> 条文ジャンプ
        </div>
        <button class="egov-ext-close" aria-label="閉じる">✕</button>
      </div>
      <div class="egov-ext-dialog-body">
        <div class="egov-ext-article-row">
          <span class="egov-ext-article-label">第</span>
          <div class="egov-ext-input-wrap">
            <input type="text" class="egov-ext-input" id="egov-article-num"
              placeholder="条番号を入力" value="${escapeHtml(initial)}" inputmode="numeric">
          </div>
          <span class="egov-ext-article-label">条</span>
        </div>
        <p class="egov-ext-hint">
          <kbd>-</kbd> で「の」（例: <code>3-2</code> → 第3条の2）<br>
          <kbd>.</kbd> で項・号（例: <code>3.2</code>=第3条第2項、<code>3.2.1</code>=第3条第2項第1号）<br>
          <kbd>Enter</kbd> ジャンプ ｜ <kbd>↑</kbd><kbd>↓</kbd> 履歴 ｜ <kbd>Tab</kbd> ページ内検索へ
        </p>
        <div class="egov-ext-result" id="egov-article-result"></div>
      </div>
    `, 'egov-ext-article-mode');

    const input = dialog.querySelector('#egov-article-num');
    input.setAttribute('inputmode', 'numeric');
    try { input.style.imeMode = 'disabled'; } catch (_) {}
    input.focus();
    input.setSelectionRange(initial.length, initial.length);
    input.addEventListener('input', () => {
      const filtered = input.value.replace(/[^0-9.-]/g, '');
      if (input.value !== filtered) {
        const cursor = Math.min(input.selectionStart ?? filtered.length, filtered.length);
        input.value = filtered;
        try { input.setSelectionRange(cursor, cursor); } catch (_) {}
      }
    });

    const hist = buildHistoryDropdown(input, articleHistory, (val) => { doJump(val); });

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Tab') { e.preventDefault(); closeDialog(); showSearchDialog(); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (!hist.isVisible()) hist.show();
        hist.moveHighlight(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Escape') { hist.isVisible() ? hist.hide() : closeDialog(); return; }
      if (e.key === 'Enter') {
        if (hist.isVisible() && hist.getCurrentValue() !== null) { hist.select(); }
        else { hist.hide(); doJump(); }
        return;
      }
      hist.hide();
    });

    function doJump(overrideNum) {
      const raw = (overrideNum !== undefined ? overrideNum : input.value).trim();
      if (!raw) return;

      const parts      = raw.split('.');
      const articleRaw = parts[0] || '';
      const paraRaw    = parts[1] || null;
      const itemRaw    = parts[2] || null;

      const found    = jumpToArticleWithDetail(articleRaw, paraRaw, itemRaw);
      const resultEl = dialog.querySelector('#egov-article-result');

      if (found) {
        pushHistory(articleHistory, raw);
        pushJumpHistory(raw);
        closeDialog();
      } else {
        const dispArticle = articleRaw.replace(/[-－‐ー_]/g, 'の').replace(/のの+/g, 'の');
        let msg = `第${dispArticle}条`;
        if (paraRaw) msg += `第${paraRaw}項`;
        if (itemRaw) msg += `第${itemRaw}号`;
        resultEl.textContent = `「${msg}」が見つかりませんでした`;
        resultEl.className   = 'egov-ext-result egov-ext-result-error';
        input.focus();
        input.select();
      }
    }
  }

  // ==================
  // 条文ジャンプ（条のみ）
  // ==================
  function jumpToArticle(num) {
    const norm = num.replace(/[のノ]/g, '_').replace(/[-－‐ー]/g, '_').replace(/\s+/g, '');
    console.log(`[e-Gov Jump] 検索: "${num}" → norm: "${norm}"`);

    const idPatterns = [
      `[id$="-At_${norm}"]`,
      `[id$="-At_${norm.replace(/_/g, '-')}"]`,
      `[id*="-At_${norm}-"]`,
    ];

    for (const sel of idPatterns) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          let target = els[0];
          if (sel.includes('*=')) {
            let el = target;
            while (el && el !== document.body) {
              if (/-At_/.test(el.id) && !/-At_.*-/.test(el.id.replace(/^.*-At_[^-]*/, ''))) { target = el; break; }
              el = el.parentElement;
            }
          }
          console.log(`[e-Gov Jump] ヒット: ${sel} → id="${target.id}"`);
          highlightAndScroll(target, 0.25);
          return true;
        }
      } catch (_) {}
    }

    const root = document.querySelector('#provisionview') || document.body;
    const displayNum   = num.replace(/[_\-－‐ー]/g, 'の').replace(/のの/g, 'の');
    const exactPattern = new RegExp(`^第\\s*${escapeRegex(displayNum)}\\s*条(?:[^の0-9]|$)`);
    for (const el of root.querySelectorAll('span, div, p, h1, h2, h3, h4, h5')) {
      if (el.children.length > 3) continue;
      const text = el.textContent.trim();
      if (text.length > 60) continue;
      if (exactPattern.test(text)) { highlightAndScroll(el, 0.25); return true; }
    }
    return false;
  }

  // ==================
  // 項・号まで含む詳細ジャンプ
  // ==================
  function jumpToArticleWithDetail(articleNum, paraNum, itemNum) {
    if (!paraNum) return jumpToArticle(articleNum);

    const na = articleNum.replace(/[のノ]/g, '_').replace(/[-－‐ー]/g, '_').replace(/\s+/g, '');
    const np = String(paraNum).trim();
    const ni = itemNum ? String(itemNum).trim() : null;

    let paraEl = null;
    for (const sel of [
      `[id$="-At_${na}-Co_${np}"]`,
      `[id$="-At_${na}-Pa_${np}"]`,
      `[id$="-At_${na}-Pr_${np}"]`,
      `[id*="-At_${na}-Co_${np}"]`,
      `[id*="-At_${na}-Pa_${np}"]`,
    ]) {
      try { const el = document.querySelector(sel); if (el) { paraEl = el; break; } } catch (_) {}
    }

    if (!paraEl) {
      const artEl = [...document.querySelectorAll(`[id*="-At_${na}"]`)]
        .find(el => /\-At_[\d_]+$/.test(el.id));
      if (artEl) {
        const fwN  = toFullWidth(np);
        const walker = document.createTreeWalker(artEl.parentElement || artEl, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          const t = node.textContent.trim();
          if (t === fwN || t === np || t === `第${fwN}項` || t === `第${np}項`) {
            paraEl = node.parentElement;
            break;
          }
        }
      }
    }

    if (!paraEl) return false;

    if (!ni) { highlightAndScroll(paraEl, 0.25); return true; }

    let itemEl = null;
    for (const sel of [
      `[id*="-Co_${np}-It_${ni}"]`,
      `[id*="-Co_${np}-Sg_${ni}"]`,
      `[id*="-Pa_${np}-It_${ni}"]`,
      `[id*="-Pa_${np}-Sg_${ni}"]`,
      `[id*="-At_${na}"][id$="-It_${ni}"]`,
      `[id*="-At_${na}"][id$="-${ni}"]`,
    ]) {
      try { const el = document.querySelector(sel); if (el) { itemEl = el; break; } } catch (_) {}
    }

    if (!itemEl) {
      const kanjiN = toKanjiNum(parseInt(ni));
      const root   = paraEl.parentElement || document.querySelector('#provisionview') || document.body;
      let pastPara = false;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        if (!pastPara) {
          if (paraEl.contains(node.parentElement) || node.parentElement === paraEl) pastPara = true;
          continue;
        }
        const t = node.textContent.trim();
        if (t === kanjiN || t === `${kanjiN}　` || t === `${kanjiN} `) {
          itemEl = node.parentElement;
          break;
        }
      }
    }

    if (!itemEl) return false;
    highlightAndScroll(itemEl, 0.25);
    return true;
  }

  function highlightAndScroll(el, viewportRatio = 0.5) {
    const container = getScrollContainer();
    const targetRatio = Math.max(0, Math.min(1, viewportRatio));

    if (container) {
      const rect = el.getBoundingClientRect();
      const cRect = container.getBoundingClientRect();
      const top = rect.top - cRect.top + container.scrollTop - (container.clientHeight * targetRatio);
      container.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior });
    } else {
      const top = el.getBoundingClientRect().top + window.scrollY - (window.innerHeight * targetRatio);
      window.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior });
    }

    flashElementHighlight(el);
  }

  function flashElementHighlight(el) {
    if (!el) return;

    if (activeFlashTimer) {
      clearTimeout(activeFlashTimer);
      activeFlashTimer = null;
    }
    if (activeFlashTransitionTimer) {
      clearTimeout(activeFlashTransitionTimer);
      activeFlashTransitionTimer = null;
    }
    if (activeFlashEl && activeFlashEl !== el) {
      activeFlashEl.style.backgroundColor = activeFlashOrigBg;
      activeFlashEl.style.transition = activeFlashOrigTr;
    }

    activeFlashEl = el;
    activeFlashOrigBg = el.style.backgroundColor;
    activeFlashOrigTr = el.style.transition;
    el.style.backgroundColor = '#FFF9C4';
    el.style.transition = 'background-color 1s';

    activeFlashTimer = setTimeout(() => {
      el.style.backgroundColor = activeFlashOrigBg;
      activeFlashTransitionTimer = setTimeout(() => {
        el.style.transition = activeFlashOrigTr;
        if (activeFlashEl === el) {
          activeFlashEl = null;
          activeFlashOrigBg = '';
          activeFlashOrigTr = '';
        }
      }, 1000);
      activeFlashTimer = null;
    }, 1200);
  }

  function clearFlashElementHighlight() {
    if (activeFlashTimer) {
      clearTimeout(activeFlashTimer);
      activeFlashTimer = null;
    }
    if (activeFlashTransitionTimer) {
      clearTimeout(activeFlashTransitionTimer);
      activeFlashTransitionTimer = null;
    }
    if (activeFlashEl) {
      activeFlashEl.style.backgroundColor = activeFlashOrigBg;
      activeFlashEl.style.transition = activeFlashOrigTr;
      activeFlashEl = null;
    }
    activeFlashOrigBg = '';
    activeFlashOrigTr = '';
  }

  // ==================
  // スクロールユーティリティ
  // ==================
  function getScrollContainer() {
    let el = document.querySelector('#provisionview');
    while (el && el !== document.documentElement) {
      const oy = window.getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return null;
  }

  function invalidateArticleCache() {
    articleElementsCache = null;
  }

  async function getFavoritesCache() {
    if (Array.isArray(favoritesCache)) return favoritesCache;
    if (!favoritesCachePromise) {
      favoritesCachePromise = chrome.storage.local.get(['favorites'])
        .then((data) => {
          favoritesCache = Array.isArray(data.favorites) ? data.favorites : [];
          favoritesCachePromise = null;
          return favoritesCache;
        })
        .catch(() => {
          favoritesCache = [];
          favoritesCachePromise = null;
          return favoritesCache;
        });
    }
    return favoritesCachePromise;
  }

  async function saveFavoritesCache() {
    if (!Array.isArray(favoritesCache)) return;
    try {
      await chrome.storage.local.set({ favorites: favoritesCache });
    } catch (_) {}
  }

  function scrollPage(ratio) {
    const container = getScrollContainer();
    if (container) {
      container.scrollBy({ top: container.clientHeight * ratio, behavior: 'smooth' });
    } else {
      window.scrollBy({ top: window.innerHeight * ratio, behavior: 'smooth' });
    }
  }

  // ==================
  // 条文ナビゲーション（n/p キー）
  // ==================
  function getAllArticles() {
    if (articleElementsCache) return articleElementsCache;
    articleElementsCache = [...document.querySelectorAll('[id*="-At_"]')]
      .filter(el => /\-At_[\d_]+$/.test(el.id))
      .sort((a, b) => {
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return  1;
        return 0;
      });
    return articleElementsCache;
  }

  function navigateArticle(direction) {
    const articles = getAllArticles();
    if (articles.length === 0) return;

    const container = getScrollContainer();
    const containerRect = container ? container.getBoundingClientRect() : null;
    const anchorTop = container ? container.clientHeight * 0.25 : window.innerHeight * 0.25;

    function getViewportTop(el) {
      const rect = el.getBoundingClientRect();
      return containerRect ? rect.top - containerRect.top : rect.top;
    }

    let currentIdx = -1;
    for (let i = 0; i < articles.length; i++) {
      if (getViewportTop(articles[i]) <= anchorTop + 1) currentIdx = i;
      else break;
    }

    const targetIdx = direction > 0 ? currentIdx + 1 : currentIdx - 1;
    if (targetIdx < 0 || targetIdx >= articles.length) return;

    const targetEl = articles[targetIdx];

    clearHighlights();
    scrollToElement25pct(targetEl);
    requestAnimationFrame(() => {
      flashElementHighlight(targetEl);
    });
  }

  function moveToFirstArticleOnLoad() {
    if (autoMovedToFirstArticle) return;
    if (favoriteScrollRestored) return;
    if (location.hash) return;

    const move = () => {
      const articles = getAllArticles();
      if (articles.length === 0) return false;
      autoMovedToFirstArticle = true;
      const firstArticle = articles[0];
      const container = getScrollContainer();
      if (container) {
        const rect = firstArticle.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        const top = rect.top - cRect.top + container.scrollTop;
        container.scrollTo({ top: Math.max(0, top - 16), behavior: 'instant' });
      } else {
        const top = firstArticle.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: Math.max(0, top - 16), behavior: 'instant' });
      }
      return true;
    };

    if (move()) return;

    const observer = new MutationObserver(() => {
      if (move()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 10000);
  }

  function getCurrentScrollTop() {
    const container = getScrollContainer();
    return container ? container.scrollTop : window.scrollY;
  }

  function scrollToStoredTop(top, behavior = 'instant') {
    const targetTop = Math.max(0, Number(top) || 0);
    const container = getScrollContainer();
    if (container) {
      container.scrollTo({ top: targetTop, behavior });
    } else {
      window.scrollTo({ top: targetTop, behavior });
    }
  }

  async function updateFavoriteScrollPosition(scrollTop) {
    const lawId = getCurrentLawIdFromUrl();
    if (!lawId) return;

    try {
      const favorites = await getFavoritesCache();
      const idx = favorites.findIndex((f) => f.lawId === lawId);
      if (idx === -1) return;

      const normalizedTop = Math.max(0, Math.round(Number(scrollTop) || 0));
      if ((favorites[idx].lastScrollTop ?? 0) === normalizedTop) return;

      favorites[idx] = { ...favorites[idx], lastScrollTop: normalizedTop };
      favoritesCache = favorites;
      await saveFavoritesCache();
    } catch (_) {}
  }

  function scheduleFavoriteScrollSave() {
    if (favoriteScrollSaveTimer) clearTimeout(favoriteScrollSaveTimer);
    favoriteScrollSaveTimer = setTimeout(() => {
      favoriteScrollSaveTimer = null;
      updateFavoriteScrollPosition(getCurrentScrollTop());
    }, 400);
  }

  function setupFavoriteScrollPersistence() {
    const lawId = getCurrentLawIdFromUrl();
    if (!lawId) return;

    let saveEnabled = false;
    getFavoritesCache().then((favorites) => {
      saveEnabled = favorites.some((f) => f.lawId === lawId);
      if (!saveEnabled) return;

      const container = getScrollContainer();
      const target = container || window;
      target.addEventListener('scroll', scheduleFavoriteScrollSave, { passive: true });
      window.addEventListener('pagehide', () => { updateFavoriteScrollPosition(getCurrentScrollTop()); }, { once: true });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') updateFavoriteScrollPosition(getCurrentScrollTop());
      });
    }).catch(() => {});
  }

  async function restoreFavoriteScrollOnLoad() {
    const lawId = getCurrentLawIdFromUrl();
    if (!lawId || location.hash) return false;

    try {
      const favorites = await getFavoritesCache();
      const fav = favorites.find((f) => f.lawId === lawId);
      if (!fav || typeof fav.lastScrollTop !== 'number') return false;

      const restore = () => {
        scrollToStoredTop(fav.lastScrollTop, 'instant');
        favoriteScrollRestored = true;
        return true;
      };

      if (getAllArticles().length > 0) return restore();

      await new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (getAllArticles().length === 0) return;
          observer.disconnect();
          resolve();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve();
        }, 10000);
      });

      if (getAllArticles().length === 0) return false;
      return restore();
    } catch (_) {
      return false;
    }
  }

  // ==================
  // ページ内検索 ダイアログ
  // ==================
  function showSearchDialog() {
    const dialog = createDialog(`
      <div class="egov-ext-dialog-header">
        <div class="egov-ext-dialog-title">
          <span class="egov-ext-title-icon">🔍</span> ページ内検索
        </div>
        <button class="egov-ext-close" aria-label="閉じる">✕</button>
      </div>
      <div class="egov-ext-dialog-body">
        <div class="egov-ext-search-row">
          <div class="egov-ext-input-wrap" style="flex:1">
            <input type="text" class="egov-ext-input" id="egov-search-text"
              placeholder="検索キーワードを入力..." lang="ja">
          </div>
          <button class="egov-ext-nav-btn" id="egov-search-prev" title="前へ (↑)">▲</button>
          <button class="egov-ext-nav-btn" id="egov-search-next" title="次へ (Enter)">▼</button>
        </div>
        <div class="egov-ext-result" id="egov-search-result"></div>
        <p class="egov-ext-hint">
          <kbd>Enter</kbd> ページトップから検索
          <span id="egov-search-hint-shift" style="display:none"> ｜ <kbd>Shift</kbd>+<kbd>Enter</kbd> 上方向に検索</span>
          <span id="egov-search-hint-ctrl"> ｜ <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 現在位置から検索</span><br>
          <kbd>↑</kbd><kbd>↓</kbd> 履歴 ｜ <kbd>Tab</kbd> 条文ジャンプへ
        </p>
      </div>
    `, 'egov-ext-search-mode');

    const input    = dialog.querySelector('#egov-search-text');
    const resultEl = dialog.querySelector('#egov-search-result');
    const shiftHint = dialog.querySelector('#egov-search-hint-shift');
    const ctrlHint  = dialog.querySelector('#egov-search-hint-ctrl');

    try { input.style.imeMode = 'active'; } catch (_) {}
    input.focus();

    let lastExecutedQuery = '';
    let hasExecutedSearch = false;

    function refocusSearchInput() {
      try { input.focus({ preventScroll: true }); }
      catch (_) { input.focus(); }
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
    }

    function updateSearchHints() {
      if (shiftHint) shiftHint.style.display = hasExecutedSearch ? '' : 'none';
      if (ctrlHint) ctrlHint.style.display = hasExecutedSearch ? 'none' : '';
    }

    function markSearchExecuted() {
      hasExecutedSearch = true;
      updateSearchHints();
    }

    function resetSearchExecutionState() {
      lastExecutedQuery = '';
      hasExecutedSearch = false;
      updateSearchHints();
    }

    updateSearchHints();

    function doSearchNext(query) {
      if (!query) return;
      if (query !== lastExecutedQuery) {
        lastExecutedQuery = query;
        pushHistory(searchHistory, query);
        performSearch(query, resultEl);
        markSearchExecuted();
        navigate(1, resultEl);
        refocusSearchInput();
      } else {
        navigate(1, resultEl);
        refocusSearchInput();
      }
    }

    function doSearchPrev(query) {
      if (!query) return;
      if (query !== lastExecutedQuery) {
        lastExecutedQuery = query;
        pushHistory(searchHistory, query);
        performSearch(query, resultEl);
        markSearchExecuted();
        navigateFromViewportStart(resultEl);
        refocusSearchInput();
      } else {
        navigate(-1, resultEl);
        refocusSearchInput();
      }
    }

    function doSearchFromHere(query) {
      if (!query) return;
      if (query !== lastExecutedQuery) {
        lastExecutedQuery = query;
        pushHistory(searchHistory, query);
        performSearch(query, resultEl);
        markSearchExecuted();
        navigateFromCurrentScrollPos(resultEl);
        refocusSearchInput();
      } else {
        navigateFromCurrentScrollPos(resultEl);
        refocusSearchInput();
      }
    }

    const hist = buildHistoryDropdown(input, searchHistory, (val) => {
      lastExecutedQuery = val;
      performSearch(val, resultEl);
      markSearchExecuted();
      navigateFromViewportStart(resultEl);
      refocusSearchInput();
    });

    input.addEventListener('input', () => {
      if (hasExecutedSearch || lastExecutedQuery) {
        resetSearchExecutionState();
        resultEl.textContent = '';
      }
      hist.hide();
    });

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Tab') { e.preventDefault(); closeDialog(); showArticleDialog(); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (!hist.isVisible()) hist.show();
        hist.moveHighlight(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Escape') { hist.isVisible() ? hist.hide() : closeDialog(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (hist.isVisible() && hist.getCurrentValue() !== null) { hist.select(); return; }
        hist.hide();
        const query = input.value.trim();
        if (e.ctrlKey)      doSearchFromHere(query);
        else if (e.shiftKey) doSearchPrev(query);
        else                 doSearchNext(query);
        return;
      }
      hist.hide();
    });

    dialog.querySelector('#egov-search-prev').addEventListener('click', () => {
      navigate(-1, resultEl);
      refocusSearchInput();
    });
    dialog.querySelector('#egov-search-next').addEventListener('click', () => doSearchNext(input.value.trim()));
  }

  function performSearch(query, resultEl) {
    clearHighlights();
    if (!query) { if (resultEl) resultEl.textContent = ''; return; }
    searchState.highlights   = markText(query);
    searchState.currentIndex = -1;
    if (resultEl) {
      if (searchState.highlights.length === 0) {
        resultEl.textContent = '見つかりませんでした';
        resultEl.className   = 'egov-ext-result egov-ext-result-error';
      } else {
        resultEl.textContent = `${searchState.highlights.length} 件見つかりました`;
        resultEl.className   = 'egov-ext-result egov-ext-result-success';
      }
    }
  }

  function navigateFromViewportStart(resultEl) {
    const { highlights } = searchState;
    if (highlights.length === 0) return;

    const threshold = window.innerHeight * 0.25;
    let targetIdx = -1;
    for (let i = 0; i < highlights.length; i++) {
      const rect = highlights[i].getBoundingClientRect();
      if (rect.top >= threshold - 10) { targetIdx = i; break; }
    }
    if (targetIdx === -1) targetIdx = 0;

    clearCurrentHighlight();
    searchState.currentIndex = targetIdx;
    const current = highlights[targetIdx];
    setCurrentHighlight(current);
    scrollRangeToView(current);
    if (resultEl) {
      resultEl.textContent = `${targetIdx + 1} / ${highlights.length} 件`;
      resultEl.className   = 'egov-ext-result egov-ext-result-success';
    }
  }

  function navigateFromCurrentScrollPos(resultEl) {
    navigateFromViewportStart(resultEl);
  }

  function navigate(direction, resultEl) {
    const { highlights } = searchState;
    if (highlights.length === 0) return;
    clearCurrentHighlight();
    searchState.currentIndex =
      (searchState.currentIndex + direction + highlights.length) % highlights.length;
    const current = highlights[searchState.currentIndex];
    if (current) {
      setCurrentHighlight(current);
      scrollRangeToView(current);
      if (resultEl) {
        resultEl.textContent = `${searchState.currentIndex + 1} / ${highlights.length} 件`;
        resultEl.className   = 'egov-ext-result egov-ext-result-success';
      }
    }
  }

  // ==================
  // CSS Custom Highlight API ヘルパー
  //   DOM を一切変更せず Range オブジェクトだけでハイライト表示する
  //   - markText   : TreeWalker で Range[] を収集し CSS.highlights に登録（replaceChild/normalize なし）
  //   - clearHighlights : CSS.highlights を削除するだけ（瞬時）
  // ==================
  function injectHighlightStyles() {
    if (document.getElementById('egov-ext-hl-style')) return;
    const s = document.createElement('style');
    s.id = 'egov-ext-hl-style';
    s.textContent =
      '::highlight(egov-search){background-color:#FFF9C4;color:inherit}' +
      '::highlight(egov-search-current){background-color:#FF6B35;color:white}';
    document.head.appendChild(s);
  }

  function setCurrentHighlight(range) {
    if (!range) return;
    if (CSS.highlights) {
      CSS.highlights.set('egov-search-current', new Highlight(range));
    } else {
      // フォールバック: Selection でカレントを示す
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range.cloneRange()); }
    }
  }

  function clearCurrentHighlight() {
    if (CSS.highlights) CSS.highlights.set('egov-search-current', new Highlight());
  }

  // Range の viewport 上位置を取得して scrollBehavior でスクロール
  function scrollRangeToView(range) {
    const rect = range.getBoundingClientRect();
    const container = getScrollContainer();
    if (container) {
      const cRect  = container.getBoundingClientRect();
      const absTop = rect.top - cRect.top + container.scrollTop;
      container.scrollTo({ top: Math.max(0, absTop - container.clientHeight * 0.25), behavior: scrollBehavior });
    } else {
      const absTop = rect.top + window.scrollY;
      window.scrollTo({ top: Math.max(0, absTop - window.innerHeight * 0.25), behavior: scrollBehavior });
    }
  }

  function markText(query) {
    const ranges = [];
    const queryLower = query.toLowerCase();
    const regex = new RegExp(escapeRegex(query), 'gi');
    const searchRoot = document.querySelector('#provisionview') || document.body;
    const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_SKIP;
        // オーバーレイと #TOC は丸ごとスキップ（長い法令で大幅高速化）
        if (el.closest('.egov-ext-overlay, #TOC')) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return NodeFilter.FILTER_REJECT;
        // includes() は regex.test() より高速（リテラル検索のため）
        return node.textContent.toLowerCase().includes(queryLower)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        ranges.push(range);
      }
    }
    // DOM 変更ゼロで全マッチをハイライト
    if (CSS.highlights) {
      CSS.highlights.set('egov-search', new Highlight(...ranges));
      CSS.highlights.set('egov-search-current', new Highlight());
    }
    return ranges;
  }

  function clearHighlights() {
    clearFlashElementHighlight();
    if (CSS.highlights) {
      CSS.highlights.delete('egov-search');
      CSS.highlights.delete('egov-search-current');
    }
    window.getSelection()?.removeAllRanges();
    searchState.highlights   = [];
    searchState.currentIndex = -1;
  }

  // ==================
  // 法令名検索 ダイアログ（r キー）
  // ==================
  function getCurrentLawName() {
    for (const sel of ['.law-title', '#lawTitle', '.lawTitle', '.provisionViewHead h1',
                        '.provision-view-title', 'h1.title', '.title', 'h1']) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    const m = document.title.match(/^(.+?)(?:\s*[|｜\-–—]\s*e-Gov|$)/);
    return m ? m[1].trim() : document.title;
  }

  function cleanLawNameForSearch(name) {
    // 全角・半角括弧の括弧書きを除去
    let s = name.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
    // 末尾の「施行規則」「施行令」のみ削除（法・法律は残す）
    s = s.replace(/(?:施行規則|施行令)$/, '').trim();
    return s;
  }

  async function showLawSearchDialog() {
    let favorites = [];
    try {
      const data = await chrome.storage.local.get(['favorites']);
      favorites = Array.isArray(data.favorites) ? data.favorites : [];
    } catch (_) {}

    const initQuery = cleanLawNameForSearch(getCurrentLawName());

    const dialog = createDialog(`
      <div class="egov-ext-dialog-header">
        <div class="egov-ext-dialog-title">
          <span class="egov-ext-title-icon">📚</span> 関連法令検索
        </div>
        <button class="egov-ext-close" aria-label="閉じる">✕</button>
      </div>
      <div class="egov-ext-dialog-body">
        <div class="egov-ext-search-row">
          <div class="egov-ext-input-wrap" style="flex:1">
            <input type="text" class="egov-ext-input" id="egov-law-search-input"
              value="${escapeHtml(initQuery)}" placeholder="法令名を入力…" lang="ja">
          </div>
        </div>
        <div class="egov-ext-result" id="egov-law-search-status"></div>
        <ul class="egov-ext-law-result-list" id="egov-law-result-list"></ul>
        <p class="egov-ext-hint">
          <kbd>Enter</kbd> 検索 / 別タブで開く ｜ <kbd>↑</kbd><kbd>↓</kbd> 移動 ｜ <kbd>★</kbd> お気に入り
        </p>
      </div>
    `, 'egov-ext-law-mode');

    const input    = dialog.querySelector('#egov-law-search-input');
    const statusEl = dialog.querySelector('#egov-law-search-status');
    const listEl   = dialog.querySelector('#egov-law-result-list');
    input.focus();
    input.select();

    let results      = [];
    let focusedIdx   = -1;
    let hoverEnabled = false;

    function isFav(lawId) { return favorites.some(f => f.lawId === lawId); }

    function toggleFav(law) {
      const idx = favorites.findIndex(f => f.lawId === law.lawId);
      if (idx !== -1) {
        favorites.splice(idx, 1);
      } else {
        favorites.unshift({ lawId: law.lawId, lawName: law.lawName, lawNum: law.lawNum, lawType: law.lawType, folderId: null });
        if (favorites.length > 50) favorites.length = 50;
      }
      chrome.storage.local.set({ favorites: [...favorites] }).catch(() => {});
    }

    function setFocus(idx) {
      focusedIdx = idx;
      const items = listEl.querySelectorAll('.egov-ext-law-result-item');
      items.forEach((li, i) => li.classList.toggle('focused', i === idx));
      if (idx >= 0 && items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
    }

    function openLaw(law) {
      window.open(buildLawUrl(law.lawId), '_blank');
      closeDialog();
    }

    function renderResults() {
      listEl.innerHTML = '';
      if (results.length === 0) { listEl.style.setProperty('display', 'none', 'important'); return; }
      listEl.style.setProperty('display', 'block', 'important');
      results.forEach((law, i) => {
        const li  = document.createElement('li');
        li.className = 'egov-ext-law-result-item';
        const fav = isFav(law.lawId);
        li.innerHTML =
          `<div class="egov-ext-law-result-main">` +
            `<span class="egov-ext-law-result-name">${formatLawNameHtml(law.lawName)}</span>` +
            (law.lawNum ? `<span class="egov-ext-law-result-num">${escapeHtml(law.lawNum)}</span>` : '') +
          `</div>` +
          `<button class="egov-ext-law-result-fav${fav ? ' active' : ''}" title="${fav ? 'お気に入りから削除' : 'お気に入りに追加'}">${fav ? '★' : '☆'}</button>`;

        li.querySelector('.egov-ext-law-result-fav').addEventListener('click', (e) => {
          e.stopPropagation();
          toggleFav(law);
          const btn    = e.currentTarget;
          const nowFav = isFav(law.lawId);
          btn.textContent = nowFav ? '★' : '☆';
          btn.classList.toggle('active', nowFav);
          btn.title = nowFav ? 'お気に入りから削除' : 'お気に入りに追加';
        });

        li.addEventListener('mouseenter', () => { if (hoverEnabled) setFocus(i); });
        li.addEventListener('click', () => openLaw(law));
        listEl.appendChild(li);
      });
      focusedIdx = -1;
    }

    async function doSearch() {
      const query = input.value.trim();
      if (!query) return;
      statusEl.textContent = '検索中…';
      statusEl.className   = 'egov-ext-result';
      listEl.style.setProperty('display', 'none', 'important');
      results      = [];
      focusedIdx   = -1;
      hoverEnabled = false;
      setTimeout(() => { hoverEnabled = true; }, 300);
      try {
        const url  = `https://laws.e-gov.go.jp/api/2/laws?law_title=${encodeURIComponent(query)}&limit=31&response_format=json`;
        const res  = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const laws = Array.isArray(data.laws) ? data.laws : [];
        if (laws.length === 0) {
          statusEl.textContent = '見つかりませんでした';
          statusEl.className   = 'egov-ext-result egov-ext-result-error';
          return;
        }
        results = laws.slice(0, 30).map(getLawFields);
        statusEl.textContent = `${results.length}件${laws.length > 30 ? '（上限）' : ''}`;
        statusEl.className   = 'egov-ext-result egov-ext-result-success';
        renderResults();
      } catch (err) {
        statusEl.textContent = `エラー: ${err.message}`;
        statusEl.className   = 'egov-ext-result egov-ext-result-error';
      }
    }

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { closeDialog(); return; }
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        if (focusedIdx >= 0 && results[focusedIdx]) {
          toggleFav(results[focusedIdx]);
          const items = listEl.querySelectorAll('.egov-ext-law-result-item');
          if (items[focusedIdx]) {
            const btn    = items[focusedIdx].querySelector('.egov-ext-law-result-fav');
            const nowFav = isFav(results[focusedIdx].lawId);
            if (btn) {
              btn.textContent = nowFav ? '★' : '☆';
              btn.classList.toggle('active', nowFav);
              btn.title = nowFav ? 'お気に入りから削除' : 'お気に入りに追加';
            }
          }
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (focusedIdx >= 0 && results[focusedIdx]) openLaw(results[focusedIdx]);
        else doSearch();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (results.length > 0) setFocus((focusedIdx + 1 + results.length) % results.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (results.length > 0) setFocus((focusedIdx - 1 + results.length) % results.length);
        return;
      }
    });

    // 開いた直後に自動検索
    doSearch();
  }

  // ==================
  // 条文番号の漢数字/アラビア数字切り替え（c キー）
  //
  // 変換対象: 「第N条」「第N条のN」「第N項」「第N号」の N 部分のみ
  //   + 号リストアイテム（-It_/-Sg_ 要素内）の先頭単独漢数字
  // 変換先: 条・項 → 全角アラビア数字、号 → 丸数字（①② … / (N)）
  // ==================
  function toggleNumberMode() {
    const root = document.querySelector('#provisionview') || document.body;

    // テキストノードが号タイトル要素内にあるか判定（.itemtitle クラスのみ対象）
    function isInItemEl(node) {
      return !!node.parentElement?.closest('.itemtitle');
    }

    const KC = '[一二三四五六七八九十百千]+'; // 漢数字クラス
    const DC = '[０-９0-9]+';                // 全角・半角数字クラス
    const KANJI_RE  = /^[一二三四五六七八九十百千]+$/;
    const CIRCLE_RE = /^[①-⑳]$/;

    // 全角数字 → 半角ASCII
    function fw2hw(s) {
      return s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement?.closest('.egov-ext-overlay')) return NodeFilter.FILTER_REJECT;
        const tag = node.parentElement?.tagName?.toLowerCase();
        if (['script', 'style', 'noscript'].includes(tag)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    let nd;
    while ((nd = walker.nextNode())) nodes.push(nd);

    if (numberMode === 'kanji') {
      // 漢数字 → アラビア数字（号は丸数字）
      nodes.forEach(n => {
        if (isInItemEl(n)) {
          // 号リストアイテム先頭: 単独漢数字 → 丸数字
          const t = n.textContent.trim();
          if (KANJI_RE.test(t) && t.length <= 4) {
            const num = parseKanjiNum(t);
            if (num >= 1) {
              const c = num <= 20 ? _CIRCLED[num] : `(${toFullWidth(String(num))})`;
              n.textContent = n.textContent.replace(t, c);
            }
          }
        } else {
          // 条文参照: 第N条/項/号 の N 部分のみ変換
          const orig = n.textContent;
          let conv = orig
            // 第N条（のN…） — のN チェーンも含む
            .replace(new RegExp(`第(${KC})条((?:の${KC})*)`, 'g'), (m, art, chain) => {
              const artN = parseKanjiNum(art);
              if (artN < 1) return m;
              let res = `第${toFullWidth(String(artN))}条`;
              if (chain) {
                res += chain.replace(new RegExp(`の(${KC})`, 'g'), (cm, k) => {
                  const sn = parseKanjiNum(k);
                  return sn > 0 ? `の${toFullWidth(String(sn))}` : cm;
                });
              }
              return res;
            })
            // 第N項
            .replace(new RegExp(`第(${KC})項`, 'g'), (m, k) => {
              const nn = parseKanjiNum(k);
              return nn > 0 ? `第${toFullWidth(String(nn))}項` : m;
            })
            // 第N号（テキスト中の参照）→ アラビア数字（丸数字にしない）
            .replace(new RegExp(`第(${KC})号`, 'g'), (m, k) => {
              const nn = parseKanjiNum(k);
              return nn > 0 ? `第${toFullWidth(String(nn))}号` : m;
            });
          if (conv !== orig) n.textContent = conv;
        }
      });
      numberMode = 'arabic';

    } else {
      // アラビア数字・丸数字 → 漢数字
      nodes.forEach(n => {
        if (isInItemEl(n)) {
          // 号リストアイテム先頭: 丸数字/(N) → 漢数字
          const t = n.textContent.trim();
          if (CIRCLE_RE.test(t)) {
            n.textContent = n.textContent.replace(t, circledToKanji(t));
          } else if (/^\([０-９0-9]+\)$/.test(t)) {
            const nn = parseInt(fw2hw(t.slice(1, -1)), 10);
            const kanji = nn >= 1 ? (numToKanjiStr(nn) || String(nn)) : t.slice(1, -1);
            n.textContent = n.textContent.replace(t, kanji);
          }
        } else {
          // 条文参照: 全角/半角数字 → 漢数字（第N条/項/号 のNのみ）
          const orig = n.textContent;
          let conv = orig
            // 第N条（のN…）
            .replace(new RegExp(`第(${DC})条((?:の${DC})*)`, 'g'), (m, art, chain) => {
              const artN = parseInt(fw2hw(art), 10);
              if (!(artN >= 1)) return m;
              let res = `第${numToKanjiStr(artN) || art}条`;
              if (chain) {
                res += chain.replace(new RegExp(`の(${DC})`, 'g'), (cm, d) => {
                  const sn = parseInt(fw2hw(d), 10);
                  return sn >= 1 ? `の${numToKanjiStr(sn) || d}` : cm;
                });
              }
              return res;
            })
            // 第N項
            .replace(new RegExp(`第(${DC})項`, 'g'), (m, d) => {
              const nn = parseInt(fw2hw(d), 10);
              return nn >= 1 ? `第${numToKanjiStr(nn) || d}項` : m;
            })
            // 第N号（アラビア数字）→ 漢数字
            .replace(new RegExp(`第(${DC})号`, 'g'), (m, d) => {
              const nn = parseInt(fw2hw(d), 10);
              return nn >= 1 ? `第${numToKanjiStr(nn) || d}号` : m;
            });
          if (conv !== orig) n.textContent = conv;
        }
      });
      numberMode = 'kanji';
    }
  }

  // ==================
  // カタカナをひらがなに変換（k キー / 一方通行）
  // ==================
  function convertKatakanaToHiragana() {
    if (kanaConverted) return; // 既に変換済み
    const root = document.querySelector('#provisionview') || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement?.closest('.egov-ext-overlay')) return NodeFilter.FILTER_REJECT;
        const tag = node.parentElement?.tagName?.toLowerCase();
        if (['script', 'style', 'noscript'].includes(tag)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let nd;
    while ((nd = walker.nextNode())) nodes.push(nd);

    // カタカナ（ァ-ヶ: U+30A1-U+30F6）→ ひらがな（ぁ-ゖ: U+3041-U+3096）
    nodes.forEach(n => {
      const orig = n.textContent;
      const conv = orig.replace(/[\u30A1-\u30F6]/g, c =>
        String.fromCharCode(c.charCodeAt(0) - 0x60)
      );
      if (conv !== orig) n.textContent = conv;
    });
    kanaConverted = true;
  }

  // ==================
  // ガイドボタン状態更新（有効=青 / 無効=灰）
  // ==================
  function updateGuideButtonState() {
    const guide = document.getElementById('egov-ext-guide');
    if (!guide) return;
    if (extensionEnabled) {
      guide.classList.remove('egov-ext-disabled');
    } else {
      guide.classList.add('egov-ext-disabled');
    }
  }

  function showShortcutGuideTooltip() {
    const guide = document.getElementById('egov-ext-guide');
    if (!guide) return;
    guideTooltipPinned = true;
    guide.classList.add('egov-ext-guide-open');
  }

  function hideShortcutGuideTooltip() {
    const guide = document.getElementById('egov-ext-guide');
    guideTooltipPinned = false;
    if (!guide) return;
    guide.classList.remove('egov-ext-guide-open');
  }

  window.addEventListener('blur', () => {
    if (guideTooltipPinned) hideShortcutGuideTooltip();
  });

  // ==================
  // ショートカットガイドボタン（右下に常駐）
  // ==================
  function addShortcutGuide() {
    injectHighlightStyles();
    if (!document.querySelector('#provisionview')) return;
    if (document.getElementById('egov-ext-guide')) return;

    const guide = document.createElement('div');
    guide.id = 'egov-ext-guide';
    guide.innerHTML = `
      <button class="egov-ext-guide-btn" title="クリックでショートカット有効/無効を切り替え" aria-label="キーボードショートカット一覧">⌨️</button>
      <div class="egov-ext-guide-tooltip" role="tooltip">
        <div class="egov-ext-guide-title">キーボードショートカット</div>
        <table class="egov-ext-guide-table">
          <tr><td><kbd>0</kbd>〜<kbd>9</kbd></td>
              <td>条文ジャンプ<br>
                <span class="egov-ext-guide-sub"><kbd>.</kbd>で項・号（3.2.1=第3条第2項第1号）</span></td></tr>
          <tr><td><kbd>h</kbd> / <kbd>l</kbd></td>
              <td>ジャンプ履歴を前後に移動</td></tr>
          <tr><td><kbd>n</kbd> / <kbd>p</kbd></td>
              <td>次/前の条文を画面上端に表示</td></tr>
          <tr><td><kbd>d</kbd> / <kbd>u</kbd></td>
              <td>下/上へ80%スクロール</td></tr>
          <tr><td><kbd>s</kbd></td>
              <td>ページ内検索<br>
                <span class="egov-ext-guide-sub">Ctrl+Enter=現在位置から検索</span></td></tr>
          <tr><td><kbd>r</kbd></td>
              <td>現在の法令名で法令検索（別タブで開く）</td></tr>
          <tr><td><kbd>c</kbd></td>
              <td>条文番号の漢数字/アラビア数字の切り替え<br>
                <span class="egov-ext-guide-sub">号タイトルは丸数字（①②③）</span></td></tr>
          <tr><td><kbd>Shift</kbd>+<kbd>H</kbd></td>
              <td>カタカナをひらがなに変換</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>O</kbd></td>
              <td>オプション画面を開く</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>P</kbd></td>
              <td>ショートカット有効/無効の切り替え<br>
                <span class="egov-ext-guide-sub">青=有効 / 灰=無効。このボタンクリックでも切り替え可</span></td></tr>
          <tr><td><kbd>?</kbd></td>
              <td>操作ガイドを表示</td></tr>
          <tr><td><kbd>Esc</kbd></td>
              <td>ダイアログを閉じる</td></tr>
        </table>
      </div>
    `;

    const guideTable = guide.querySelector('.egov-ext-guide-table');
    const npRow = [...guideTable.querySelectorAll('tr')].find((tr) => tr.querySelector('td')?.textContent.includes('n'));
    if (npRow) {
      npRow.insertAdjacentHTML('beforebegin', `
        <tr><td><kbd>b</kbd></td><td>ピン状態の常時表示切り替え</td></tr>
        <tr><td><kbd>i</kbd> <kbd>o</kbd> <kbd>j</kbd> <kbd>k</kbd> <kbd>m</kbd></td><td>対応色のピンを設定 / 解除 / 移動</td></tr>
      `);
    }

    const sRow = [...guideTable.querySelectorAll('tr')].find((tr) => tr.querySelector('td')?.textContent.trim() === 's');
    if (sRow) {
      sRow.insertAdjacentHTML('beforebegin', `
        <tr><td><kbd>f</kbd></td><td>お気に入りに追加 / 解除</td></tr>
      `);
    }

    document.body.appendChild(guide);

    // ガイドボタンクリックで有効/無効トグル
    guide.querySelector('.egov-ext-guide-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      extensionEnabled = !extensionEnabled;
      updateGuideButtonState();
    });
  }

  function ensureShortcutGuide() {
    if (document.getElementById('egov-ext-guide')) return;
    if (document.querySelector('#provisionview')) {
      addShortcutGuide();
      return;
    }

    const observer = new MutationObserver(() => {
      if (!document.querySelector('#provisionview')) return;
      observer.disconnect();
      addShortcutGuide();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 10000);
  }

  function setupColorPinFeatures() {
    refreshColorPinHighlights();
    chrome.storage.local.get(['pinToastDefaultVisible'], (data) => {
      pinToastDefaultVisible = typeof data.pinToastDefaultVisible === 'boolean' ? data.pinToastDefaultVisible : true;
      pinToastPinned = pinToastDefaultVisible;
      if (pinToastPinned) showPinToast(false);
      else hidePinToast(true);
    });
    if (getAllArticles().length > 0) return;

    const observer = new MutationObserver(() => {
      if (getAllArticles().length === 0) return;
      observer.disconnect();
      refreshColorPinHighlights();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 10000);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'egov-perform-color-pin-jump') return undefined;

    jumpToStoredColorPin(message.pin)
      .then((ok) => {
        if (ok) refreshColorPinHighlights();
        sendResponse({ ok });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  });

  async function initializeLawPageFeatures() {
    invalidateArticleCache();
    const articleCacheObserver = new MutationObserver(() => {
      invalidateArticleCache();
    });
    articleCacheObserver.observe(document.documentElement, { childList: true, subtree: true });
    ensureShortcutGuide();
    setupFavoriteHeaderBadge();
    setupColorPinFeatures();
    await restoreFavoriteScrollOnLoad();
    moveToFirstArticleOnLoad();
    setupFavoriteScrollPersistence();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initializeLawPageFeatures();
    });
  } else {
    setTimeout(() => {
      initializeLawPageFeatures();
    }, 800);
  }
})();
