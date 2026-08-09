/**
 * e-Gov法令検索 拡張機能 - コンテンツスクリプト
 *
 * キーボードショートカット（入力欄フォーカス外）:
 *   0-9    : 条文ジャンプ（3.2.1 で 第3条第2項第1号 指定）
 *   h / l  : 条文ジャンプ履歴を前後に移動
 *   n / p  : 次/前の条文を画面上端に表示
 *   d / u  : 下/上へ80%スクロール
 *   s      : ページ内検索
 *   r      : ジャンプ前の位置に戻る
 *   Alt+R  : 現在の法令名で法令検索
 *   c      : 条文番号の漢数字/アラビア数字の切り替え
 *   Esc    : ダイアログを閉じる
 */
(function () {
  'use strict';

  const shared = globalThis.EgovShared;
  const app = globalThis.EgovApp;
  const {
    applyReferenceLinksInBatches,
    buildLawUrl,
    buildProvisionCopyPayload: buildSharedProvisionCopyPayload,
    cloneDefinitionPatterns,
    cleanLawNameForSearch,
    collectSearchTextSegments,
    collectInternalLawReferences,
    configureReferenceClickable,
    escapeHtml,
    extractInlineAliasDefinition: extractSharedInlineAliasDefinition,
    extractTermBeforeParentheticalDefinition: extractSharedTermBeforeParentheticalDefinition,
    formatProvisionNumber: formatSharedProvisionNumber,
    formatProvisionSourcePathFromEgovUrl,
    getLawReferencesData,
    getLawFields,
    getReferenceDomParts,
    getReverseReferenceScopeFlags,
    isTermBoundarySafe: isSharedTermBoundarySafe,
    mergeLawReferences,
    normalizeLawNameForCopy,
    normalizeReverseReferenceScope,
    rangeFromSearchOffsets,
    sortReferenceSources,
    splitReferenceTargetKey,
    REVERSE_REFERENCE_SCOPE_KEY,
  } = shared;
  const {
    FAVORITES_MAX,
    createFavoritesStore,
    createReferencePopup,
    getReferenceTargetLabel,
    persistLocal,
    pushHistory: pushSharedHistory,
    readFavorites,
    runWhenIdle,
    toggleFavoriteRecord,
  } = app;
  const favoritesStore = createFavoritesStore();
  const {
    observeArticleChanges,
    runAfterPageLoadWhenIdle,
    shouldInvalidateArticleCache,
    startWhenDomReady,
  } = globalThis.EgovContentController;
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
  let guideTooltipHoverHideTimer = null;
  let autoMovedToFirstArticle = false;
  let activeFlashEl = null;
  let activeFlashOrigBg = '';
  let activeFlashOrigTr = '';
  let activeFlashTimer = null;
  let activeFlashTransitionTimer = null;
  let favoriteScrollSaveTimer = null;
  let favoriteScrollRestored = false;
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
  const mutedParenGroupElements = new Map();
  let articleElementsCache = null;
  let lawReferenceHoverTimer = null;
  let lawReferenceHoverAnchor = null;
  let lawReferenceHoverPoint = null;
  let lawReferencePointerPoint = null;
  let lawReferenceShieldEl = null;
  let lawReferenceShieldAnchor = null;
  let lawReferenceOpenLockUntil = 0;
  let lawRefClickEnabled = true;
  let lawRefHoverPopupEnabled = false;
  let lawRefOtherLawPopupEnabled = true;
  let reverseReferenceScope = 'both';
  let lawReferenceInteractionsInitialized = false;
  let defTooltipEnabled = true;
  let defTooltipClickOnly = true;
  let definitionTooltipInitialized = false;
  let postLoadEnrichmentReady = false;
  let definitionApplyScheduled = false;
  let definitionApplyNotify = false;
  let definitionApplySignature = '';
  let definitionMap = new Map();
  let activeDefinitionTooltip = null;
  let definitionTooltipPinned = false;
  let definitionTooltipShowTimer = 0;
  let definitionTooltipHideTimer = 0;
  let jumpReturnButtonTimer = 0;
  let activeJumpReturnPosition = null;
  let lawRevisionAreaExpanded = false;
  let lawRevisionAreaOriginalStyle = null;
  let articleLinkCopyLastSelection = '';
  let externalReferencesEnabled = false;
  let externalReferencesLoading = false;
  let referenceAnalysisGeneration = 0;
  let activeReferencesPopup = null;
  let inyoDialogBridgeInjected = false;
  let inyoDialogBridgeReadyPromise = null;
  const externalReferencesByElement = new WeakMap();
  let activeProvisionSelectionEl = null;
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
  chrome.storage.local.get(['scrollBehavior', 'pinToastDefaultVisible'], (data) => {
    if (data.scrollBehavior === 'smooth') scrollBehavior = 'smooth';
    if (typeof data.pinToastDefaultVisible === 'boolean') pinToastDefaultVisible = data.pinToastDefaultVisible;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.scrollBehavior) scrollBehavior = changes.scrollBehavior.newValue;
      if (changes.favorites) {
        favoritesStore.replace(changes.favorites.newValue);
        refreshFavoriteHeaderBadge();
      }
      if (changes.pinToastDefaultVisible) {
        pinToastDefaultVisible = !!changes.pinToastDefaultVisible.newValue;
        if (pinToastDefaultVisible) {
          pinToastPinned = true;
          showPinToast(false);
        } else if (pinToastPinned) {
          pinToastPinned = false;
          hidePinToast(true);
        }
      }
      if (changes.lawRefOtherLawPopup) {
        lawRefOtherLawPopupEnabled = changes.lawRefOtherLawPopup.newValue !== false;
      }
      if (changes.lawRefClickEnabled) {
        lawRefClickEnabled = changes.lawRefClickEnabled.newValue !== false;
        if (!lawRefClickEnabled) hideLawReferencePreview();
      }
      if (changes.lawRefHoverPopup) {
        lawRefHoverPopupEnabled = changes.lawRefHoverPopup.newValue === true;
      }
      if (changes[REVERSE_REFERENCE_SCOPE_KEY]) {
        reverseReferenceScope = normalizeReverseReferenceScope(changes[REVERSE_REFERENCE_SCOPE_KEY].newValue);
      }
      if (changes.liteDefTooltipEnabled) {
        defTooltipEnabled = changes.liteDefTooltipEnabled.newValue !== false;
        if (defTooltipEnabled && postLoadEnrichmentReady) scheduleApplyDefinitionTooltips({ notify: true });
        else clearDefinitionTooltips();
        updateHeaderToggleButtonStates();
      }
      if (changes.defTooltipClickOnly) {
        defTooltipClickOnly = changes.defTooltipClickOnly.newValue !== false;
        hideDefinitionTooltip(true);
      }
      if (changes.hideLawSidebarDefault) {
        setLawRevisionAreaExpanded(changes.hideLawSidebarDefault.newValue === true);
      }
    } else if (area === 'session') {
      if (changes.colorPins) {
        refreshColorPinHighlights();
        if (pinToastVisible) schedulePinToastRender();
      }
    }
  });
  window.addEventListener('resize', () => { if (pinToastVisible) schedulePinToastRender(); });
  window.addEventListener('scroll', () => { if (pinToastVisible) schedulePinToastRender(); }, { passive: true });

  // ==================
  // 履歴ユーティリティ
  // ==================
  function pushHistory(history, value) {
    pushSharedHistory(history, value, HISTORY_MAX);
  }

  function pushJumpHistory(num) {
    if (!num) return;
    // カーソル位置の条文と同じなら何もしない
    if (articleJumpCursor >= 0 && articleJumpHistory[articleJumpCursor] === num) return;

    // カーソルの直後に挿入（先の履歴は維持）
    const insertAt = articleJumpCursor + 1;
    articleJumpHistory.splice(insertAt, 0, num);
    articleJumpCursor = insertAt;

    // 上限200件（先頭から削除してカーソルを補正）
    if (articleJumpHistory.length > 200) {
      articleJumpHistory.shift();
      articleJumpCursor = Math.max(0, articleJumpCursor - 1);
    }
  }

  function buildJumpHistoryKey(parts) {
    if (!parts?.article) return '';
    let jumpKey = parts.article;
    if (parts.paragraph) jumpKey += '.' + parts.paragraph;
    if (parts.item) jumpKey += '.' + parts.item;
    return jumpKey;
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
    // 枝番号は「第3条の2」「第3号の2」の順で表示する（単位の後に「の2」）
    const branch = (value, unit) => {
      const [base, ...suffixes] = String(value).split(/[-－‐ー_]/).filter(Boolean);
      return base ? `第${base}${unit}${suffixes.map((s) => `の${s}`).join('')}` : '';
    };
    let s = branch(parts[0], '条');
    if (parts[1]) s += branch(parts[1], '項');
    if (parts[2]) s += branch(parts[2], '号');
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

  async function copyTextToClipboard(text) {
    const value = String(text || '');
    if (!value) return false;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) {}

    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    } catch (_) {
      return false;
    }
  }

  function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function toFullWidth(s) {
    return String(s).replace(/[0-9]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
  }

  function isWithinMutedParen(node) {
    return !!node.parentElement?.closest('.egov-ext-muted-paren');
  }

  function isParenProcessingContainer(el) {
    if (!(el instanceof Element)) return false;
    if (el.classList.contains('sentence')) return true;
    return [...el.classList].some((className) => (
      /^_div_.*Sentence$/.test(className) ||
      className === '_div_ArticleTitle'
    ));
  }

  function getParenProcessingContainer(el) {
    let current = el instanceof Element ? el : null;
    while (current) {
      if (isParenProcessingContainer(current)) return current;
      current = current.parentElement;
    }
    return null;
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
    if (groupId) {
      const elements = mutedParenGroupElements.get(groupId);
      if (elements) elements.push(span);
      else mutedParenGroupElements.set(groupId, [span]);
    }
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

  function getMutedParenGroupElements(groupId) {
    if (!groupId) return [];
    const elements = mutedParenGroupElements.get(groupId);
    if (!elements?.length) return [];
    const connected = elements.filter((el) => el?.isConnected);
    if (connected.length !== elements.length) {
      if (connected.length > 0) mutedParenGroupElements.set(groupId, connected);
      else mutedParenGroupElements.delete(groupId);
    }
    return connected;
  }

  function setMutedParenHoverGroup(groupId) {
    if (activeMutedParenGroup === groupId) return;
    if (activeMutedParenGroup) {
      getMutedParenGroupElements(activeMutedParenGroup).forEach((el) => {
        el.classList.remove('egov-ext-muted-paren-hover');
      });
    }
    activeMutedParenGroup = groupId || '';
    if (!activeMutedParenGroup) return;
    getMutedParenGroupElements(activeMutedParenGroup).forEach((el) => {
      el.classList.add('egov-ext-muted-paren-hover');
    });
  }

  function getMutedParenGroupAtPoint(clientX, clientY) {
    if (lawReferenceShieldEl) lawReferenceShieldEl.style.pointerEvents = 'none';
    const el = document.elementFromPoint(clientX, clientY);
    if (lawReferenceShieldEl) lawReferenceShieldEl.style.pointerEvents = 'auto';
    return el instanceof Element ? (el.closest('.egov-ext-muted-paren[data-group]')?.dataset.group || '') : '';
  }

  function muteFullWidthParenthesesInBody(root = document.querySelector('#provisionview') || document.body) {
    if (!root) return;
    const container = root.nodeType === Node.ELEMENT_NODE ? getParenProcessingContainer(root) : null;
    if (container) {
      processSentenceElement(container);
      return;
    }
    root.querySelectorAll?.('.sentence, [class*="Sentence"], ._div_ArticleTitle').forEach((sentence) => {
      if (isParenProcessingContainer(sentence)) processSentenceElement(sentence);
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
          const sentence = getParenProcessingContainer(node);
          if (sentence) {
            processSentenceElement(sentence);
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
    updateHeaderToggleButtonStates();
  }

  function getCurrentLawIdFromUrl() {
    const m = location.pathname.match(/\/law\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function getLawIdFromLawUrl(url) {
    try {
      const match = new URL(url, location.href).pathname.match(/^\/law\/([^/?#]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    } catch (_) {
      return '';
    }
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

  async function setCurrentLawFavorite(shouldFavorite) {
    const law = getCurrentLawInfo();
    if (!law.lawId) return false;

    const favorites = await getFavoritesCache();
    const idx = favorites.findIndex((f) => f.lawId === law.lawId);
    const isFavorite = idx !== -1;
    if (shouldFavorite === isFavorite) return isFavorite;

    if (shouldFavorite) {
      favorites.unshift(law);
      if (favorites.length > FAVORITES_MAX) favorites.length = FAVORITES_MAX;
    } else {
      favorites.splice(idx, 1);
    }

    favoritesStore.replace(favorites);
    await saveFavoritesCache();
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
      const favorites = await getFavoritesCache();
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

  function setHeaderToggleButtonState(button, active, title) {
    if (!button) return;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.title = title;
    button.setAttribute('aria-label', title);
  }

  function updateHeaderToggleButtonStates() {
    setHeaderToggleButtonState(
      document.getElementById('egov-ext-wide-button'),
      lawRevisionAreaExpanded,
      lawRevisionAreaExpanded ? 'ワイド表示を解除' : 'ワイド表示に切り替え'
    );
    setHeaderToggleButtonState(
      document.getElementById('egov-ext-paren-button'),
      parenthesesMuteMode === 'nested',
      parenthesesMuteMode === 'nested' ? 'かっこ消しを解除' : 'かっこをほぼ非表示にする'
    );
    const externalButton = document.getElementById('egov-ext-external-references-button');
    setHeaderToggleButtonState(
      externalButton,
      externalReferencesEnabled,
      externalReferencesEnabled ? '逆参照リンクを無効化' : '逆参照リンクを有効化'
    );
    if (externalButton) {
      externalButton.disabled = externalReferencesLoading;
      externalButton.setAttribute('aria-busy', String(externalReferencesLoading));
    }
    setHeaderToggleButtonState(
      document.getElementById('egov-ext-definition-button'),
      defTooltipEnabled,
      defTooltipEnabled ? '定義語リンクを無効化' : '定義語リンクを有効化'
    );
  }

  function toggleDefinitionHeaderLinks() {
    defTooltipEnabled = !defTooltipEnabled;
    if (defTooltipEnabled && postLoadEnrichmentReady) scheduleApplyDefinitionTooltips({ notify: true });
    else clearDefinitionTooltips();
    updateHeaderToggleButtonStates();
    chrome.storage.local.set({ liteDefTooltipEnabled: defTooltipEnabled }).catch(() => {});
  }

  function ensureHeaderToggleButtons() {
    const host = ensureHeaderControlHost();
    if (!host) return [];
    const configs = [
      { id: 'egov-ext-wide-button', label: 'ワイド', onClick: () => toggleLawRevisionArea() },
      { id: 'egov-ext-paren-button', label: 'かっこ', onClick: () => toggleParenthesesMute('nested') },
      { id: 'egov-ext-external-references-button', label: '逆リンク', onClick: () => toggleExternalReferenceLinks() },
      { id: 'egov-ext-definition-button', label: '定義', onClick: toggleDefinitionHeaderLinks },
    ];
    const buttons = configs.map(({ id, label, onClick }) => {
      let button = document.getElementById(id);
      if (button) return button;
      button = document.createElement('button');
      button.id = id;
      button.type = 'button';
      button.className = 'egov-ext-lightweight-viewer-button egov-ext-header-toggle-button';
      button.textContent = label;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      return button;
    });

    let anchor = document.getElementById('egov-ext-favorite-header-badge');
    buttons.forEach((button) => {
      if (anchor?.parentElement === host) anchor.insertAdjacentElement('afterend', button);
      else host.appendChild(button);
      anchor = button;
    });
    updateHeaderToggleButtonStates();
    return buttons;
  }

  function ensureLightweightViewerButton() {
    const host = ensureHeaderControlHost();
    if (!host) return null;

    let button = document.getElementById('egov-ext-lightweight-viewer-button');
    if (!button) {
      button = document.createElement('button');
      button.id = 'egov-ext-lightweight-viewer-button';
      button.type = 'button';
      button.className = 'egov-ext-lightweight-viewer-button';
      button.textContent = 'Lite';
      button.title = 'Liteモードで開く';
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.isTrusted) return;
        await openLightweightViewerFromPage();
      });
    }

    const toggles = ensureHeaderToggleButtons();
    const lastToggle = toggles[toggles.length - 1];
    const favorite = document.getElementById('egov-ext-favorite-header-badge');
    if (lastToggle?.parentElement === host) lastToggle.insertAdjacentElement('afterend', button);
    else if (favorite?.parentElement === host) favorite.insertAdjacentElement('afterend', button);
    else host.appendChild(button);
    return button;
  }

  function getLightweightViewerUrl(lawId = getCurrentLawIdFromUrl()) {
    if (!lawId) return '';
    const params = new URLSearchParams();
    params.set('lawId', lawId);
    params.set('lawName', getCurrentLawName());
    params.set('sourceUrl', location.href);
    return chrome.runtime.getURL(`viewer.html?${params.toString()}`);
  }

  function openLightweightViewerDirectly(lawId = getCurrentLawIdFromUrl()) {
    const url = getLightweightViewerUrl(lawId);
    if (!url) return false;
    chrome.runtime.sendMessage({ type: 'egov-prefetch-lite-law', lawId }).catch(() => {});
    location.assign(url);
    return true;
  }

  function openLightweightViewerFromPage() {
    const lawId = getCurrentLawIdFromUrl();
    if (!lawId) {
      showPinIndicator('\u6cd5\u4ee4ID\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f');
      return;
    }
    if (!openLightweightViewerDirectly(lawId)) {
      showPinIndicator('\u8efd\u91cf\u30d3\u30e5\u30fc\u30a2\u3092\u958b\u3051\u307e\u305b\u3093\u3067\u3057\u305f');
    }
  }

  async function refreshFavoriteHeaderBadge() {
    const lawId = getCurrentLawIdFromUrl();
    if (!lawId) return;
    const badge = ensureFavoriteHeaderBadge();
    if (!badge) return;

    const favorites = await getFavoritesCache();
    updateFavoriteHeaderBadgeState(badge, favorites.some((f) => f.lawId === lawId));
  }

  function setupFavoriteHeaderBadge() {
    if (ensureFavoriteHeaderBadge()) {
      ensureHeaderToggleButtons();
      ensureLightweightViewerButton();
      refreshFavoriteHeaderBadge();
      return;
    }

    const observer = new MutationObserver(() => {
      if (!ensureFavoriteHeaderBadge()) return;
      ensureHeaderToggleButtons();
      ensureLightweightViewerButton();
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
    return getArticleAtViewportRatio(0.25);
  }

  function getArticleAtViewportRatio(ratio = 1 / 3) {
    const articles = getAllArticles();
    if (articles.length === 0) return null;

    const container = getScrollContainer();
    const containerRect = container ? container.getBoundingClientRect() : null;
    const normalizedRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
    const anchorTop = container ? container.clientHeight * normalizedRatio : window.innerHeight * normalizedRatio;
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
      const root = document.querySelector('#provisionview') || document.documentElement;
      const observer = new MutationObserver(() => {
        if (getAllArticles().length === 0) return;
        observer.disconnect();
        resolve(true);
      });
      observer.observe(root, { childList: true, subtree: true });
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
  function scrollToElementAtRatio(el, ratio = 0.25) {
    const container = getScrollContainer();
    const rect = el.getBoundingClientRect();
    const targetRatio = Math.max(0, Math.min(1, ratio));
    if (container) {
      const cRect  = container.getBoundingClientRect();
      const absTop = rect.top - cRect.top + container.scrollTop;
      container.scrollTo({ top: Math.max(0, absTop - container.clientHeight * targetRatio), behavior: scrollBehavior });
    } else {
      const absTop = rect.top + window.scrollY;
      window.scrollTo({ top: Math.max(0, absTop - window.innerHeight * targetRatio), behavior: scrollBehavior });
    }
  }

  function scrollToElement25pct(el) {
    scrollToElementAtRatio(el, 0.25);
  }

  function setLawRevisionAreaExpanded(expanded) {
    const sidebar = document.getElementById('sidebar');
    const revision = document.getElementById('revision');
    const footer = document.querySelector('footer.toolbar-main');
    if (!sidebar || !revision) return false;

    if (!lawRevisionAreaOriginalStyle) {
      lawRevisionAreaOriginalStyle = {
        sidebarDisplay: sidebar.style.display,
        revisionMarginLeft: revision.style.marginLeft,
        revisionWidth: revision.style.width,
        footerWidth: footer?.style.width || '',
      };
    }

    if (expanded) {
      sidebar.style.display = 'none';
      revision.style.marginLeft = '0px';
      revision.style.width = '100%';
      if (footer) footer.style.width = '100%';
    } else {
      sidebar.style.display = lawRevisionAreaOriginalStyle.sidebarDisplay;
      revision.style.marginLeft = lawRevisionAreaOriginalStyle.revisionMarginLeft;
      revision.style.width = lawRevisionAreaOriginalStyle.revisionWidth;
      if (footer) footer.style.width = lawRevisionAreaOriginalStyle.footerWidth;
    }

    lawRevisionAreaExpanded = expanded;
    updateHeaderToggleButtonStates();
    return true;
  }

  function toggleLawRevisionArea() {
    return setLawRevisionAreaExpanded(!lawRevisionAreaExpanded);
  }

  function openManualPageFromGuide() {
    chrome.runtime.sendMessage({ type: 'egov-open-manual-page' })
      .catch(() => {});
  }

  // ==================
  // キーボードイベント
  // ==================
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
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
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'h' || e.key === 'H') && !activeDialog) {
      e.preventDefault();
      convertKatakanaToHiragana();
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'l' || e.key === 'L' || e.code === 'KeyL') && !activeDialog) {
      e.preventDefault();
      openLightweightViewerFromPage();
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'r' || e.key === 'R' || e.code === 'KeyR')) {
      e.preventDefault();
      closeDialog();
      showLawSearchDialog();
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

    const lowerKey = e.key.toLowerCase();
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key.length > 1) return;
    if (activeDialog && e.target instanceof Element && (
      (e.target.closest('#egov-article-link-panel') && (e.key === 'n' || e.key === 'p')) ||
      (e.target.closest('#egov-law-toc-panel') && ['n', 'p', 'd', 'u'].includes(e.key))
    )) return;

    // ダイアログ非表示時のみ有効なキー
    if (!activeDialog) {
      if (e.shiftKey && lowerKey === 'g') { e.preventDefault(); toggleParenthesesMute('nested'); return; }
      if (e.shiftKey && PIN_SLOT_ORDER.includes(lowerKey)) { e.preventDefault(); forceRemoveColorPinSlot(lowerKey); return; }
      if (e.shiftKey && lowerKey === 't') { e.preventDefault(); showLawTocDialog({ initialFocus: 'natural' }); return; }
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
      if (e.key === 'r') { e.preventDefault(); returnToJumpStart(); return; }
      if (lowerKey === 'e') { e.preventDefault(); toggleExternalReferenceLinks(); return; }
      if (e.key === 'a') { e.preventDefault(); showArticleLinkCopyDialog(); return; }
      if (e.key === 't') { e.preventDefault(); showLawTocDialog(); return; }
      if (lowerKey === 'w') {
        if (toggleLawRevisionArea()) e.preventDefault();
        return;
      }
    }

    const wasTocDialog = !!(activeDialog && activeDialog.classList.contains('egov-ext-toc-mode'));
    e.preventDefault();
    closeDialog();

    if (/^[0-9]$/.test(e.key)) {
      showArticleDialog(e.key);
    } else if (e.key === 's') {
      showSearchDialog();
    } else if (e.key === 'r') {
      returnToJumpStart();
    } else if (lowerKey === 't') {
      if (wasTocDialog) return;
      showLawTocDialog({ initialFocus: e.shiftKey ? 'natural' : 'top' });
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

    const favorites = await getFavoritesCache();
    const isFavorite = favorites.some((f) => f.lawId === law.lawId);
    const nextFavorite = !isFavorite;
    await setCurrentLawFavorite(nextFavorite);
    showPinIndicator(nextFavorite ? 'お気に入りに追加しました' : 'お気に入りから外しました');
  }

  function getArticleLinkLabel(articleEl, index) {
    const parsed = parseProvisionPath(articleEl?.id || '');
    if (parsed) return formatProvisionNumber(parsed);
    return `条文 ${index + 1}`;
  }

  function buildArticleLinkUrl(articleEl) {
    const lawId = getCurrentLawIdFromUrl();
    if (!lawId || !articleEl?.id) return '';
    return `${buildLawUrl(lawId)}#${encodeURIComponent(articleEl.id)}`;
  }

  function parseProvisionPath(id) {
    const rawId = String(id || '');
    const articleMatch = rawId.match(/-At_([\d_]+)/);
    const article = articleMatch?.[1] || '';
    if (!article) return null;

    // Only look for paragraph/item markers in the suffix after the article marker,
    // so that structural prefixes like "-Pa_1" (Part/編) are not mistaken for paragraphs.
    const suffix = rawId.slice((articleMatch.index ?? 0) + articleMatch[0].length);
    const paragraph = suffix.match(/^-(?:Co|Pa|Pr)_(\d+)/)?.[1] || '';
    // 号は枝番号を保持する（It_3_2 → "3_2"。「第3号の2」と「第3号」を区別するため）
    const item = suffix.match(/-(?:It|Sg)_([\d_]+)/)?.[1] || '';
    return { article, paragraph, item };
  }

  function getProvisionJumpKeyFromNode(node) {
    const provisionRoot = document.querySelector('#provisionview');
    let el = node instanceof Element ? node : node?.parentElement;

    while (el && el instanceof Element && el !== provisionRoot) {
      const parts = parseProvisionPath(el.id || '');
      if (parts?.article) return buildJumpHistoryKey(parts);
      el = el.parentElement;
    }

    if (provisionRoot instanceof Element) {
      const parts = parseProvisionPath(provisionRoot.id || '');
      if (parts?.article) return buildJumpHistoryKey(parts);
    }

    return '';
  }

  function getJumpHistoryKeyFromTargetElement(target, provisionRoot = null) {
    if (!(target instanceof Element)) return '';

    const directParts = parseProvisionPath(target.id || '');
    if (directParts?.article) return buildJumpHistoryKey(directParts);

    const nestedArticle = target.querySelector('section[id*="-At_"], article[id*="-At_"]');
    if (nestedArticle instanceof Element) {
      const articleParts = parseProvisionPath(nestedArticle.id || '');
      return articleParts?.article ? buildJumpHistoryKey(articleParts) : '';
    }

    const articles = getAllArticles();
    const firstFollowingArticle = articles.find((article) => {
      if (!(article instanceof Element)) return false;
      if (article === target) return false;
      const relation = target.compareDocumentPosition(article);
      return !!(relation & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    if (!(firstFollowingArticle instanceof Element)) return '';

    const articleParts = parseProvisionPath(firstFollowingArticle.id || '');
    return articleParts?.article ? buildJumpHistoryKey(articleParts) : '';
  }

  function isArticleLevelProvision(el, parts) {
    if (!parts?.article) return false;
    if (!parts.paragraph) return true;
    if (parts.item) return false;
    if (parts.paragraph !== '1') return false;
    return !!el?.querySelector?.('em.articleheading, .articleheading');
  }

  function formatProvisionNumber(parts, el = null) {
    return formatSharedProvisionNumber(parts, { isArticleLevel: isArticleLevelProvision(el, parts) });
  }

  function formatProvisionNumberForCopy(parts, el = null, articleParagraphs = new Map()) {
    return formatSharedProvisionNumber(parts, {
      isArticleLevel: isArticleLevelProvision(el, parts),
      omitSingleParagraphFirst: articleParagraphs.get(parts?.article)?.size === 1,
    });
  }

  function normalizeProvisionText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/[ \u3000]+/g, ' ')
      .trim();
  }

  function removeRubyAnnotations(root) {
    root.querySelectorAll('rt,rp').forEach((node) => node.remove());
  }

  function getTextWithoutRubyAnnotations(el) {
    if (!(el instanceof Element)) return '';
    const clone = el.cloneNode(true);
    removeRubyAnnotations(clone);
    return clone.textContent || '';
  }

  function extractProvisionText(el, parts = null) {
    if (!(el instanceof Element)) return '';

    const clone = el.cloneNode(true);
    removeRubyAnnotations(clone);
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));

    return String(clone.textContent || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  }

  const PROVISION_SUB_BLOCK_SELECTOR = [
    '.item',
    '.list',
    '.portion',
    '.subitem',
    '[id*="-It_"]',
    '[id*="-Sg_"]',
    '[class*="ItemSentence"]',
    '[class*="Subitem"]',
  ].join(',');

  function getDirectProvisionSubBlocks(root) {
    if (!(root instanceof Element)) return [];
    return [...root.querySelectorAll(PROVISION_SUB_BLOCK_SELECTOR)].filter((sub) => {
      let ancestor = sub.parentElement;
      while (ancestor && ancestor !== root) {
        if (ancestor.matches(PROVISION_SUB_BLOCK_SELECTOR)) return false;
        ancestor = ancestor.parentElement;
      }
      return ancestor === root;
    });
  }

  function getProvisionOwnLineText(block) {
    if (!(block instanceof Element)) return '';
    const subBlocks = getDirectProvisionSubBlocks(block);
    const titleEl = block.querySelector(':scope > .paragraphtitle, :scope > .itemtitle, :scope > .listtitle, :scope > .portiontitle');
    if (titleEl) {
      const title = getTextWithoutRubyAnnotations(titleEl).replace(/[\r\n\t]+/g, '');
      // 定義型の号などで用語と定義が .column に分かれている場合は全角空白で区切る
      // （例: 「四　不利益処分　行政庁が…」）。
      const columns = [...block.querySelectorAll(':scope > .column')];
      if (columns.length && !subBlocks.some((sub) => columns.some((col) => col.contains(sub)))) {
        const columnParts = columns
          .map((col) => normalizeProvisionText(getTextWithoutRubyAnnotations(col)))
          .filter(Boolean);
        return [title, columnParts.join('　')].join('');
      }
      const sentenceParts = [...block.querySelectorAll('.sentence, .itemsentence, .listsentence')]
        .filter((node) => !subBlocks.some((sub) => sub.contains(node)))
        .map((node) => normalizeProvisionText(getTextWithoutRubyAnnotations(node)))
        .filter(Boolean);
      return [title, ...sentenceParts].join('');
    }

    const clone = block.cloneNode(true);
    removeRubyAnnotations(clone);
    clone.querySelectorAll(PROVISION_SUB_BLOCK_SELECTOR).forEach((node) => node.remove());
    return String(clone.textContent || '').replace(/[\r\n\t]+/g, '').trim();
  }

  function buildProvisionBlockLines(root) {
    if (!(root instanceof Element)) return [];
    const lines = [];
    const ownLine = getProvisionOwnLineText(root);
    if (ownLine) lines.push(ownLine);
    for (const subBlock of getDirectProvisionSubBlocks(root)) {
      lines.push(...buildProvisionBlockLines(subBlock));
    }
    return lines;
  }

  // parseProvisionPath は号の枝番号（It_3_2 → 「3」）を切り捨てるため、
  // 号同士の境界判定にはIDの生トークン（「3_2」を保持）を使う。
  function getProvisionItemIdToken(id) {
    return String(id || '').match(/-(?:It|Sg)_([\d_]+)/)?.[1] || '';
  }

  function collectFollowingProvisionSiblingLines(el, parts) {
    if (!(el instanceof Element) || !parts) return [];
    const lines = [];
    let sibling = el.nextElementSibling;
    while (sibling instanceof Element && sibling.matches(PROVISION_SUB_BLOCK_SELECTOR)) {
      const siblingParts = parseProvisionPath(sibling.id || '');
      if (siblingParts) {
        if (siblingParts.article !== parts.article) break;
        if (siblingParts.paragraph !== parts.paragraph) break;
        if (parts.item && getProvisionItemIdToken(sibling.id) !== getProvisionItemIdToken(el.id)) break;
      }
      lines.push(...buildProvisionBlockLines(sibling));
      sibling = sibling.nextElementSibling;
    }
    return lines;
  }

  function buildArticleBodyText(articleEl) {
    if (!(articleEl instanceof Element)) return '';

    const blocks = [];
    const contentRoot = articleEl.querySelector('.articlecontent') || articleEl;
    for (const child of Array.from(contentRoot.children)) {
      if (!(child instanceof Element)) continue;

      // Heading — old rendering: em.articleheading / new rendering: ._div_ArticleCaption
      if (child.matches('em.articleheading, .articleheading, ._div_ArticleCaption')) {
        const heading = normalizeProvisionText(getTextWithoutRubyAnnotations(child));
        if (heading) blocks.push(heading);
        continue;
      }

      // New rendering paragraphs: ._div_ArticleTitle = 第1項, ._div_ParagraphSentence = 第2項以降.
      if (child.matches('._div_ArticleTitle, ._div_ParagraphSentence')) {
        blocks.push(...buildProvisionBlockLines(child));
        continue;
      }

      // Old rendering paragraphs. [id*="-Pr_"] is intentionally omitted here to avoid
      // false matches on new-rendering ._div_ArticleTitle whose ID also contains "-Pr_".
      if (child.matches('.paragraph, [id*="-Pa_"], [id*="-Co_"]')) {
        blocks.push(...buildProvisionBlockLines(child));
        continue;
      }

      if (child.matches(PROVISION_SUB_BLOCK_SELECTOR)) {
        blocks.push(...buildProvisionBlockLines(child));
      }
    }

    return blocks.join('\n').trim();
  }

  function normalizeProvisionMultilineText(text) {
    const normalized = String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t\u3000]+\n/g, '\n')
      .replace(/\n[ \t\u3000]+/g, '\n')
      .replace(/[ \t\u3000]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return joinProvisionLeadLine(
      normalized.replace(/^(（[^）]+）)(第[0-9０-９一二三四五六七八九十百千〇零]+条(?:の[0-9０-９一二三四五六七八九十百千〇零]+)*)/, '$1\n$2')
    );
  }

  function joinProvisionLeadLine(text) {
    const normalized = String(text || '').trim();
    const lines = normalized.split('\n');
    if (lines.length >= 2) {
      const first = lines[0].trim();
      let secondIndex = 1;
      while (secondIndex < lines.length && !lines[secondIndex].trim()) secondIndex += 1;
      if (/^(?:第)?[0-9０-９一二三四五六七八九十百千〇零]+(?:条(?:の[0-9０-９一二三四五六七八九十百千〇零]+)*)?$/.test(first) && secondIndex < lines.length) {
        const merged = `${first}　${lines[secondIndex].trim()}`;
        const nextLines = [merged, ...lines.slice(secondIndex + 1)];
        return nextLines.join('\n').trim();
      }
    }

    return normalized;
  }

  function normalizeDefinitionText(value) {
    return normalizeProvisionText(value).replace(/\s+([。、，．；;])/g, '$1');
  }

  function formatJumpReturnArticleGuide() {
    const article = getArticleAtViewportRatio(1 / 3);
    const parts = parseProvisionPath(article?.id || '');
    if (!parts?.article) return '';
    const articleParts = String(parts.article).split(/[-_]+/).filter(Boolean);
    if (!articleParts.length) return '';
    return articleParts.length > 1
      ? `第${articleParts[0]}条の${articleParts.slice(1).join('の')}近辺`
      : `第${articleParts[0]}条近辺`;
  }

  function getCurrentJumpReturnPosition() {
    const container = getScrollContainer();
    return {
      type: container ? 'container' : 'window',
      top: container ? container.scrollTop : window.scrollY,
      guide: formatJumpReturnArticleGuide(),
    };
  }

  function scrollToJumpReturnPosition(position) {
    if (!position) return;
    const container = position.type === 'container' ? getScrollContainer() : null;
    if (container) {
      container.scrollTo({ top: Math.max(0, position.top || 0), behavior: scrollBehavior });
      return;
    }
    window.scrollTo({ top: Math.max(0, position.top || 0), behavior: scrollBehavior });
  }

  function hideJumpReturnButton() {
    clearTimeout(jumpReturnButtonTimer);
    jumpReturnButtonTimer = 0;
    activeJumpReturnPosition = null;
    document.getElementById('egov-ext-jump-return')?.remove();
  }

  function returnToJumpStart() {
    if (!activeJumpReturnPosition) return false;
    scrollToJumpReturnPosition(activeJumpReturnPosition);
    hideJumpReturnButton();
    return true;
  }

  function showJumpReturnButton(position) {
    if (!position) return;
    hideJumpReturnButton();
    activeJumpReturnPosition = position;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'egov-ext-jump-return';
    button.textContent = `Rでジャンプ前の位置に戻る${position.guide ? `（${position.guide}）` : ''}`;
    button.addEventListener('click', () => {
      returnToJumpStart();
    });
    document.body.appendChild(button);
    jumpReturnButtonTimer = setTimeout(hideJumpReturnButton, 10 * 60 * 1000);
  }

  function getDefinitionRoot() {
    return document.querySelector('#provisionview') || document.body;
  }

  function getDefinitionTargetDepth(el) {
    const parts = parseProvisionPath(el?.id || '');
    if (parts?.item) return 3;
    if (parts?.paragraph) return 2;
    if (parts?.article) return 1;
    return 0;
  }

  function getDefinitionTargetKey(el) {
    const parts = parseProvisionPath(el?.id || '');
    return parts?.article ? buildJumpHistoryKey(parts) : '';
  }

  function getDefinitionLocationLabel(definition) {
    const key = definition?.key || '';
    return key ? getReferenceTargetLabel(key) : '';
  }

  function getDefinitionTargetText(el) {
    if (!(el instanceof Element)) return '';
    const parts = parseProvisionPath(el.id || '');
    if (parts?.article && !parts.paragraph && !parts.item) return buildArticleBodyText(el);
    return normalizeProvisionMultilineText(extractProvisionText(el, parts));
  }

  function buildDefinitionCandidateCache() {
    const groups = new Map();
    for (const el of collectProvisionLinkTargets()) {
      if (!(el instanceof Element)) continue;
      const article = parseProvisionPath(el.id || '')?.article || '';
      if (!article) continue;
      if (!groups.has(article)) groups.set(article, { raw: [], normalized: null });
      groups.get(article).raw.push(el);
    }
    return groups;
  }

  function getDefinitionCandidateGroup(candidateCache, article) {
    const articleKey = parseProvisionPath(article?.id || '')?.article || '';
    return candidateCache.get(articleKey) || null;
  }

  function getNormalizedDefinitionCandidates(group) {
    if (!group) return [];
    if (!group.normalized) {
      group.normalized = group.raw
        .map((el) => ({ el, text: normalizeDefinitionText(el.textContent || '') }))
        .filter((item) => item.text)
        .sort((a, b) => a.text.length - b.text.length);
    }
    return group.normalized;
  }

  function getDefinitionSourceElement(matchText, group) {
    const needle = normalizeDefinitionText(matchText);
    if (!needle) return null;
    for (const item of getNormalizedDefinitionCandidates(group)) {
      if (item.text.includes(needle)) return item.el;
    }
    return null;
  }

  function addDefinition(definitions, item) {
    const term = normalizeDefinitionText(item.term);
    const targetEl = item.anchorEl instanceof Element ? item.anchorEl : null;
    const definition = getDefinitionTargetText(targetEl) || normalizeDefinitionText(item.definition);
    const depth = getDefinitionTargetDepth(targetEl);
    if (term.length < 2 || term.length > 40 || !definition || !targetEl || !depth) return;
    const existing = definitions.get(term);
    const next = {
      term,
      definition,
      anchorEl: targetEl,
      sourceEl: targetEl,
      excludeEl: targetEl,
      key: getDefinitionTargetKey(targetEl),
      targetDepth: depth,
      sourceType: item.sourceType || 'patternA',
    };
    if (!existing || next.targetDepth > (existing.targetDepth || 0) || (next.targetDepth === existing.targetDepth && next.definition.length > existing.definition.length)) {
      definitions.set(term, next);
    }
  }

  function extractTermBeforeParentheticalDefinition(text, matchIndex, cleanupPatterns = []) {
    return extractSharedTermBeforeParentheticalDefinition(text, matchIndex, cleanupPatterns, normalizeDefinitionText);
  }

  function extractInlineAliasDefinition(text, matchIndex, cleanupPatterns = []) {
    return extractSharedInlineAliasDefinition(text, matchIndex, cleanupPatterns, normalizeDefinitionText);
  }

  function extractListedDefinitionFromTarget(el) {
    const text = normalizeDefinitionText(getDefinitionTargetText(el));
    const withoutNumber = text.replace(/^(?:[一二三四五六七八九十百千]+|[0-9０-９]+)[ 　、.]*/, '');
    const match = withoutNumber.match(/^([^ 　、。]{2,40})[ 　]+(.{2,})$/);
    if (!match) return null;
    const term = match[1].trim();
    const definition = match[2].trim();
    if (!term || !definition || /[。、]$/.test(term)) return null;
    return { term, definition };
  }

  function extractDefinitions() {
    const definitions = new Map();
    const { patternA, patternC, patternD } = cloneDefinitionPatterns();
    const candidateCache = buildDefinitionCandidateCache();

    for (const article of getAllArticles()) {
      const text = normalizeDefinitionText(getTextWithoutRubyAnnotations(article));
      const articleCandidates = getDefinitionCandidateGroup(candidateCache, article);
      let match;
      patternA.lastIndex = 0;
      while ((match = patternA.exec(text))) {
        addDefinition(definitions, {
          term: match[2],
          definition: `${match[2]}とは、${match[3]}をいう。`,
          anchorEl: getDefinitionSourceElement(match[0], articleCandidates) || article,
          sourceType: 'patternA',
        });
      }
      patternD.lastIndex = 0;
      while ((match = patternD.exec(text))) {
        addDefinition(definitions, {
          term: extractTermBeforeParentheticalDefinition(text, match.index, [patternC, patternD]),
          definition: match[1].replace(/以下同じ。$/, ''),
          anchorEl: getDefinitionSourceElement(match[0], articleCandidates) || article,
          sourceType: 'patternD',
        });
      }
      patternC.lastIndex = 0;
      while ((match = patternC.exec(text))) {
        addDefinition(definitions, {
          term: match[1],
          definition: extractInlineAliasDefinition(text, match.index, [patternC, patternD]),
          anchorEl: getDefinitionSourceElement(match[0], articleCandidates) || article,
          sourceType: 'patternC',
        });
      }
      if (/用語の意義は、?当該各号に定めるところによる/.test(text)) {
        (articleCandidates?.raw || [])
          .filter((el) => getDefinitionTargetDepth(el) >= 3)
          .forEach((el) => {
            const listed = extractListedDefinitionFromTarget(el);
            if (!listed) return;
            addDefinition(definitions, {
              term: listed.term,
              definition: `${listed.term}とは、${listed.definition}`,
              anchorEl: el,
              sourceType: 'patternB',
            });
          });
      }
    }
    return definitions;
  }

  function shouldSkipDefinitionTextNode(node, definition) {
    const parent = node.parentElement;
    if (!parent) return true;
    if (parent.closest('a, button, input, textarea, select, script, style, mark, .egov-ext-defined-term, .egov-ext-definition-tooltip, #egov-ext-guide, .egov-ext-dialog, .egov-ext-reference-popup')) return true;
    if (!getDefinitionRoot().contains(parent)) return true;
    if (definition?.excludeEl?.contains(parent)) return true;
    if (definition?.sourceType === 'patternC' && definition.sourceEl) {
      const pos = parent.compareDocumentPosition(definition.sourceEl);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return true;
    }
    return false;
  }

  function isTermBoundarySafe(text, start, end) {
    return isSharedTermBoundarySafe(text, start, end);
  }

  function unwrapDefinitionTerms() {
    document.querySelectorAll('.egov-ext-defined-term').forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    });
  }

  function clearDefinitionTooltipTimers() {
    clearTimeout(definitionTooltipShowTimer);
    clearTimeout(definitionTooltipHideTimer);
    definitionTooltipShowTimer = 0;
    definitionTooltipHideTimer = 0;
  }

  function hideDefinitionTooltip(immediate = false) {
    clearTimeout(definitionTooltipShowTimer);
    const remove = () => {
      activeDefinitionTooltip?.remove();
      activeDefinitionTooltip = null;
      definitionTooltipPinned = false;
    };
    if (immediate) {
      clearTimeout(definitionTooltipHideTimer);
      remove();
      return;
    }
    clearTimeout(definitionTooltipHideTimer);
    definitionTooltipHideTimer = setTimeout(remove, 200);
  }

  function positionDefinitionTooltip(popup, point) {
    const margin = 10;
    const rect = popup.getBoundingClientRect();
    popup.style.left = `${Math.min(Math.max(margin, point.x + 8), Math.max(margin, window.innerWidth - rect.width - margin))}px`;
    popup.style.top = `${Math.min(Math.max(margin, point.y + 8), Math.max(margin, window.innerHeight - rect.height - margin))}px`;
  }

  function buildDefinitionBodyHtml(term, definitionText) {
    const escaped = escapeHtml(definitionText);
    const escapedTerm = escapeHtml(term);
    if (!escapedTerm) return escaped;
    return escaped.replace(new RegExp(escapeRegex(escapedTerm), 'g'), `<mark class="egov-ext-definition-term-highlight">${escapedTerm}</mark>`);
  }

  function moveToDefinitionSource(definition) {
    hideDefinitionTooltip(true);
    const sourceJumpKey = buildJumpHistoryKey(parseProvisionPath(getArticleAtViewport25pct()?.id || ''));
    if (sourceJumpKey) pushJumpHistory(sourceJumpKey);
    if (definition.key) pushJumpHistory(definition.key);
    highlightAndScroll(definition.anchorEl, 0.25, { showReturnButton: true });
  }

  function showDefinitionTooltip(trigger, activation = 'click') {
    if (!defTooltipEnabled || (defTooltipClickOnly && activation !== 'click')) return;
    const term = trigger?.dataset?.term || '';
    const definition = definitionMap.get(term);
    if (!definition) return;
    const locationLabel = getDefinitionLocationLabel(definition) || '定義箇所';
    hideDefinitionTooltip(true);
    const popup = document.createElement('div');
    popup.className = 'egov-ext-definition-tooltip';
    popup.setAttribute('role', 'tooltip');
    definitionTooltipPinned = activation === 'click';
    popup.innerHTML = `
      <div class="egov-ext-definition-tooltip-head">
        <button type="button" class="egov-ext-definition-location">定義箇所の${escapeHtml(locationLabel)}に移動する</button>
      </div>
      <div class="egov-ext-definition-body">${buildDefinitionBodyHtml(term, definition.definition)}</div>
    `;
    document.body.appendChild(popup);
    activeDefinitionTooltip = popup;
    const rect = trigger.getBoundingClientRect();
    positionDefinitionTooltip(popup, { x: rect.left, y: rect.bottom });
    popup.addEventListener('mouseenter', clearDefinitionTooltipTimers);
    popup.addEventListener('mouseleave', () => {
      if (!definitionTooltipPinned) hideDefinitionTooltip();
    });
    popup.querySelector('.egov-ext-definition-location')?.addEventListener('click', (event) => {
      event.preventDefault();
      moveToDefinitionSource(definition);
    });
  }

  function scheduleDefinitionTooltip(trigger) {
    if (defTooltipClickOnly) return;
    clearDefinitionTooltipTimers();
    definitionTooltipShowTimer = setTimeout(() => showDefinitionTooltip(trigger, 'hover'), 300);
  }

  function markDefinedTerms(definitions) {
    const defs = Array.from(definitions.values()).sort((a, b) => b.term.length - a.term.length);
    if (!defs.length) return 0;
    const byTerm = new Map(defs.map((def) => [def.term, def]));
    const pattern = new RegExp(defs.map((def) => escapeRegex(def.term)).join('|'), 'g');
    let markedCount = 0;
    const walker = document.createTreeWalker(getDefinitionRoot(), NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !pattern.test(node.nodeValue)) {
          pattern.lastIndex = 0;
          return NodeFilter.FILTER_REJECT;
        }
        pattern.lastIndex = 0;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const textNode of nodes) {
      const text = textNode.nodeValue || '';
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let changed = false;
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const term = match[0];
        const definition = byTerm.get(term);
        const start = match.index;
        const end = start + term.length;
        if (!definition || shouldSkipDefinitionTextNode(textNode, definition) || !isTermBoundarySafe(text, start, end)) continue;
        if (start > lastIndex) fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
        const span = document.createElement('span');
        span.className = 'egov-ext-defined-term';
        span.dataset.term = term;
        span.tabIndex = 0;
        span.textContent = term;
        fragment.appendChild(span);
        lastIndex = end;
        changed = true;
        markedCount += 1;
      }
      if (!changed) continue;
      if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      textNode.parentNode.replaceChild(fragment, textNode);
    }
    return markedCount;
  }

  function clearDefinitionTooltips() {
    hideDefinitionTooltip(true);
    definitionMap = new Map();
    definitionApplySignature = '';
    unwrapDefinitionTerms();
  }

  function getDefinitionApplySignature() {
    const articles = getAllArticles();
    const firstId = articles[0]?.id || '';
    const lastId = articles[articles.length - 1]?.id || '';
    return `${articles.length}:${firstId}:${lastId}`;
  }

  async function applyDefinitionTooltips() {
    definitionApplyScheduled = false;
    const notify = definitionApplyNotify;
    definitionApplyNotify = false;
    if (!defTooltipEnabled) return;
    try {
      const ready = await waitForArticles(10000);
      if (!ready || getAllArticles().length === 0) {
        if (notify) showPinIndicator('定義用語ガイド: 条文の読み込み完了後にもう一度試してください');
        return;
      }
      const signature = getDefinitionApplySignature();
      if (!notify && signature && signature === definitionApplySignature && document.querySelector('.egov-ext-defined-term')) return;
      clearDefinitionTooltips();
      const startedAt = performance.now();
      if (notify) showPinIndicator('定義用語ガイドを解析しています');
      definitionMap = extractDefinitions();
      if (!definitionMap.size) {
        if (notify) showPinIndicator('定義用語ガイド: 定義用語は見つかりませんでした');
        return;
      }
      const markedCount = markDefinedTerms(definitionMap);
      definitionApplySignature = signature;
      console.debug(`[e-Gov Enhancer] 定義用語ガイド: extract+mark ${(performance.now() - startedAt).toFixed(1)}ms (${definitionMap.size} terms / ${markedCount} marks)`);
      if (notify) {
        showPinIndicator(
          markedCount > 0
            ? `定義用語ガイドを有効化しました（${definitionMap.size}語 / ${markedCount}箇所）`
            : `定義用語は${definitionMap.size}語見つかりましたが、本文中の表示箇所はありませんでした`
        );
      }
    } catch (error) {
      console.warn('[e-Gov Enhancer] 定義用語ガイドの解析に失敗しました', error);
      showPinIndicator('定義用語ガイドの解析に失敗しました');
    }
  }

  function scheduleApplyDefinitionTooltips({ notify = false } = {}) {
    if (notify) definitionApplyNotify = true;
    if (definitionApplyScheduled) return;
    definitionApplyScheduled = true;
    runWhenIdle(applyDefinitionTooltips, 1200);
  }

  function setupDefinitionTooltipInteractions() {
    if (definitionTooltipInitialized) return;
    definitionTooltipInitialized = true;
    document.addEventListener('mouseover', (event) => {
      const term = event.target.closest?.('.egov-ext-defined-term[data-term]');
      if (!defTooltipClickOnly && term) scheduleDefinitionTooltip(term);
    });
    document.addEventListener('mouseout', (event) => {
      if (defTooltipClickOnly) return;
      if (definitionTooltipPinned) return;
      const term = event.target.closest?.('.egov-ext-defined-term[data-term]');
      if (!term) return;
      if (event.relatedTarget?.closest?.('.egov-ext-definition-tooltip, .egov-ext-defined-term[data-term]')) return;
      hideDefinitionTooltip();
    });
    document.addEventListener('focusin', (event) => {
      const term = event.target.closest?.('.egov-ext-defined-term[data-term]');
      if (!defTooltipClickOnly && term) scheduleDefinitionTooltip(term);
    });
    document.addEventListener('focusout', (event) => {
      if (defTooltipClickOnly) return;
      if (definitionTooltipPinned) return;
      const term = event.target.closest?.('.egov-ext-defined-term[data-term]');
      if (!term || event.relatedTarget?.closest?.('.egov-ext-definition-tooltip')) return;
      hideDefinitionTooltip();
    });
    document.addEventListener('click', (event) => {
      const term = event.target.closest?.('.egov-ext-defined-term[data-term]');
      if (term) {
        event.preventDefault();
        event.stopPropagation();
        clearDefinitionTooltipTimers();
        showDefinitionTooltip(term);
        return;
      }
      if (activeDefinitionTooltip && !event.target.closest?.('.egov-ext-definition-tooltip')) {
        hideDefinitionTooltip(true);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideDefinitionTooltip(true);
        return;
      }
      const term = event.target.closest?.('.egov-ext-defined-term[data-term]');
      if (term && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        clearDefinitionTooltipTimers();
        showDefinitionTooltip(term);
      }
    });
  }

  function setProvisionSelectionHighlight(el) {
    if (activeProvisionSelectionEl && activeProvisionSelectionEl !== el) {
      activeProvisionSelectionEl.classList.remove('egov-ext-provision-selected');
    }
    activeProvisionSelectionEl = el instanceof Element ? el : null;
    activeProvisionSelectionEl?.classList.add('egov-ext-provision-selected');
  }

  function getProvisionBodyText(item) {
    if (!item) return '';
    if (typeof item.bodyText === 'string') return item.bodyText;
    const isWholeArticle = item.parts?.article && !item.parts.paragraph && !item.parts.item;
    let bodyText;
    if (isWholeArticle) {
      bodyText = buildArticleBodyText(item.articleEl);
    } else {
      const lines = [
        ...buildProvisionBlockLines(item.articleEl),
        ...collectFollowingProvisionSiblingLines(item.articleEl, item.parts),
      ];
      bodyText = lines.length > 1
        ? lines.join('\n')
        : normalizeProvisionMultilineText(extractProvisionText(item.articleEl, item.parts));
    }
    item.bodyText = bodyText;
    return bodyText;
  }

  function collectProvisionLinkTargets() {
    const selectors = [
      '[id*="-At_"]',
      '[id*="-Pr_"]',
      '[id*="-Pa_"]',
      '[id*="-Co_"]',
      '[id*="-It_"]',
      '[id*="-Sg_"]',
    ];
    const seen = new Set();
    return [...document.querySelectorAll(selectors.join(','))]
      .filter((el) => el?.id && parseProvisionPath(el.id))
      .filter((el) => {
        if (seen.has(el.id)) return false;
        seen.add(el.id);
        return true;
      });
  }

  function getProvisionLinkCopyItems() {
    const parsedTargets = collectProvisionLinkTargets()
      .map((el, index) => ({ el, index, parts: parseProvisionPath(el.id) }))
      .filter((item) => item.parts);
    const articleParagraphs = new Map();

    for (const { parts } of parsedTargets) {
      if (!parts.article || !parts.paragraph || parts.item) continue;
      if (!articleParagraphs.has(parts.article)) articleParagraphs.set(parts.article, new Set());
      articleParagraphs.get(parts.article).add(parts.paragraph);
    }

    return parsedTargets
      .map(({ el, index, parts }) => {
        const numberLabel = formatProvisionNumber(parts, el) || getArticleLinkLabel(el, index);
        const copyNumberLabel = formatProvisionNumberForCopy(parts, el, articleParagraphs) || numberLabel;
        return {
          articleEl: el,
          id: el.id,
          parts,
          numberLabel,
          copyNumberLabel,
          url: buildArticleLinkUrl(el),
        };
      })
      .filter((item) => item?.url);
  }

  function getLawNameForCopy() {
    return normalizeLawNameForCopy(getCurrentLawName());
  }

  function getProvisionAtViewport25pct(items) {
    if (!Array.isArray(items) || items.length === 0) return null;
    const container = getScrollContainer();
    const containerRect = container ? container.getBoundingClientRect() : null;
    const anchorTop = container ? container.clientHeight * 0.25 : window.innerHeight * 0.25;
    let current = items[0];

    for (const item of items) {
      const rect = item.articleEl.getBoundingClientRect();
      const top = containerRect ? rect.top - containerRect.top : rect.top;
      if (top <= anchorTop + 1) current = item;
      else break;
    }
    return current;
  }

  function buildProvisionCopyPayload(item, mode) {
    return buildSharedProvisionCopyPayload({
      lawName: getLawNameForCopy(),
      numberLabel: item.copyNumberLabel || item.numberLabel,
      bodyText: joinProvisionLeadLine(getProvisionBodyText(item)),
      url: item.url,
    }, mode);
  }

  async function showArticleLinkCopyDialog() {
    const ready = await waitForArticles();
    if (!ready) {
      showPinIndicator('条文の読み込み完了後にもう一度試してください');
      return;
    }

    const items = getProvisionLinkCopyItems();
    if (items.length === 0) {
      showPinIndicator('コピーできる条文リンクが見つかりません');
      return;
    }

    const currentItem = getProvisionAtViewport25pct(items);
    let selectedIndex = items.findIndex((item) => item === currentItem);
    if (selectedIndex < 0 && articleLinkCopyLastSelection) {
      selectedIndex = items.findIndex((item) => item.id === articleLinkCopyLastSelection);
    }
    selectedIndex = Math.max(0, selectedIndex);

    const dialog = createDialog(`
      <div class="egov-ext-dialog-header">
        <div class="egov-ext-dialog-title">
          <span class="egov-ext-title-icon">🔗</span> 条文リンクコピー
        </div>
        <button class="egov-ext-close" aria-label="閉じる">×</button>
      </div>
      <div class="egov-ext-dialog-body">
        <div class="egov-ext-article-link-panel" id="egov-article-link-panel" tabindex="0">
          <div class="egov-ext-article-link-section">
            <div class="egov-ext-article-link-heading">Enterでコピーされる内容</div>
            <div class="egov-ext-article-link-preview-box" id="egov-article-link-preview-url"></div>
          </div>
          <div class="egov-ext-article-link-section">
            <div class="egov-ext-article-link-heading">Shift+Enterでコピーされる内容</div>
            <div class="egov-ext-article-link-preview-box" id="egov-article-link-preview-shift"></div>
          </div>
          <div class="egov-ext-article-link-section">
            <div class="egov-ext-article-link-heading">Ctrl+Enterでコピーされる内容</div>
            <div class="egov-ext-article-link-preview-box" id="egov-article-link-preview-ctrl"></div>
          </div>
          <hr class="egov-ext-article-link-divider">
          <div class="egov-ext-article-link-section">
            <div class="egov-ext-article-link-heading">操作ガイド</div>
            <div class="egov-ext-article-link-guide"><kbd>↑</kbd><kbd>↓</kbd> / <kbd>p</kbd><kbd>n</kbd> で選択｜<kbd>Esc</kbd>でキャンセル</div>
          </div>
        </div>
      </div>
    `, 'egov-ext-article-link-mode');

    const panel = dialog.querySelector('#egov-article-link-panel');
    const urlPreviewEl = dialog.querySelector('#egov-article-link-preview-url');
    const shiftPreviewEl = dialog.querySelector('#egov-article-link-preview-shift');
    const ctrlPreviewEl = dialog.querySelector('#egov-article-link-preview-ctrl');

    function refocusPanel() {
      try { panel.focus({ preventScroll: true }); }
      catch (_) { panel.focus(); }
    }

    function renderPreviews(item) {
      urlPreviewEl.textContent = buildProvisionCopyPayload(item, 'url');
      shiftPreviewEl.textContent = buildProvisionCopyPayload(item, 'law-number-url');
      ctrlPreviewEl.textContent = buildProvisionCopyPayload(item, 'text-url');
    }

    function updateSelection(nextIndex, scrollArticle = false) {
      selectedIndex = Math.max(0, Math.min(items.length - 1, nextIndex));
      const selected = items[selectedIndex];
      articleLinkCopyLastSelection = selected.id;
      renderPreviews(selected);

      if (scrollArticle) {
        clearHighlights();
        setProvisionSelectionHighlight(selected.articleEl);
        scrollToElementAtRatio(selected.articleEl, 0.6);
      } else {
        setProvisionSelectionHighlight(selected.articleEl);
      }
    }

    async function copySelection(mode) {
      const selected = items[selectedIndex];
      const copied = await copyTextToClipboard(buildProvisionCopyPayload(selected, mode));
      if (copied) {
        showPinIndicator('条文リンクをコピーしました', selected.articleEl);
        closeDialog();
      } else {
        showPinIndicator('クリップボードへのコピーに失敗しました', selected.articleEl);
      }
    }

    function moveSelection(delta) {
      const nextIndex = (selectedIndex + delta + items.length) % items.length;
      updateSelection(nextIndex, true);
    }

    panel.addEventListener('keydown', async (e) => {
      if (e.key === 'ArrowDown' || e.key === 'n') {
        e.preventDefault();
        moveSelection(+1);
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'p') {
        e.preventDefault();
        moveSelection(-1);
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        updateSelection(0, true);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        updateSelection(items.length - 1, true);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.ctrlKey) {
          await copySelection('text-url');
          return;
        }
        if (e.shiftKey) {
          await copySelection('law-number-url');
          return;
        }
        await copySelection('url');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDialog();
      }
    });

    updateSelection(selectedIndex, true);
    refocusPanel();
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
          highlightAndScroll(target, 0.25, { showReturnButton: true });
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
      if (exactPattern.test(text)) { highlightAndScroll(el, 0.25, { showReturnButton: true }); return true; }
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

    if (!ni) { highlightAndScroll(paraEl, 0.25, { showReturnButton: true }); return true; }

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
      const kanjiN = toKanjiNum(parseInt(ni, 10));
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
    highlightAndScroll(itemEl, 0.25, { showReturnButton: true });
    return true;
  }

  function highlightAndScroll(el, viewportRatio = 0.5, options = {}) {
    const returnPosition = options.showReturnButton ? getCurrentJumpReturnPosition() : null;
    clearHighlights();
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

    requestAnimationFrame(() => {
      flashElementHighlight(el);
    });
    if (returnPosition) showJumpReturnButton(returnPosition);
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

  function jumpToHashTarget(hash, options = {}) {
    const rawHash = String(hash || '');
    if (!rawHash || rawHash === '#') return false;

    // ハッシュ→要素の解決は getHashTargetElement に集約（短縮形/フルパスID対応を共通化）
    const target = getHashTargetElement(rawHash);
    if (!(target instanceof Element)) return false;

    highlightAndScroll(target, 0.25, { showReturnButton: true });
    history.replaceState(null, '', rawHash);

    // 条文ジャンプ履歴に追加（ポップアップ経由でないスクロール移動のみ）
    const provisionRoot = document.querySelector('#provisionview') || document.body;
    if (options.sourceJumpKey) pushJumpHistory(options.sourceJumpKey);
    const jumpKey = getJumpHistoryKeyFromTargetElement(target, provisionRoot);
    if (jumpKey) pushJumpHistory(jumpKey);

    return true;
  }

  function referenceKeyPartToIdToken(value) {
    return String(value || '').trim().replace(/-/g, '_');
  }

  function escapeAttributeSelectorValue(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function findElementBySelectors(selectors) {
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el instanceof Element) return el;
      } catch (_) {}
    }
    return null;
  }

  function findReferenceTargetElement(targetKey) {
    const { scope, article, paragraph, item } = getReferenceDomParts(splitReferenceTargetKey(targetKey));
    if (!article) return null;

    const articleToken = escapeAttributeSelectorValue(referenceKeyPartToIdToken(article));
    const paragraphToken = escapeAttributeSelectorValue(referenceKeyPartToIdToken(paragraph || (item ? '1' : '')));
    const itemToken = escapeAttributeSelectorValue(referenceKeyPartToIdToken(item));
    const scopeToken = escapeAttributeSelectorValue(scope);

    if (scopeToken) {
      const articleSelector = `[id*="-${scopeToken}-At_${articleToken}"]`;
      if (item && paragraphToken) {
        return findElementBySelectors([
          `${articleSelector}[id*="-Pr_${paragraphToken}"][id*="-It_${itemToken}"]`,
          `${articleSelector}[id*="-Pr_${paragraphToken}"][id*="-Sg_${itemToken}"]`,
          `${articleSelector}[id*="-Co_${paragraphToken}"][id*="-It_${itemToken}"]`,
          `${articleSelector}[id*="-Pa_${paragraphToken}"][id*="-It_${itemToken}"]`,
        ]);
      }
      if (item) {
        return findElementBySelectors([
          `${articleSelector}[id*="-It_${itemToken}"]`,
          `${articleSelector}[id*="-Sg_${itemToken}"]`,
        ]);
      }
      if (paragraphToken) {
        return findElementBySelectors([
          `${articleSelector}[id*="-Pr_${paragraphToken}"]`,
          `${articleSelector}[id*="-Co_${paragraphToken}"]`,
          `${articleSelector}[id*="-Pa_${paragraphToken}"]`,
        ]);
      }
      return findElementBySelectors([
        `[id$="-${scopeToken}-At_${articleToken}"]`,
        articleSelector,
      ]);
    }

    if (item && paragraphToken) {
      return findElementBySelectors([
        `[id$="-At_${articleToken}-Pr_${paragraphToken}-It_${itemToken}"]`,
        `[id$="-At_${articleToken}-Pr_${paragraphToken}-Sg_${itemToken}"]`,
        `[id$="-At_${articleToken}-Co_${paragraphToken}-It_${itemToken}"]`,
        `[id$="-At_${articleToken}-Co_${paragraphToken}-Sg_${itemToken}"]`,
        `[id$="-At_${articleToken}-Pa_${paragraphToken}-It_${itemToken}"]`,
        `[id$="-At_${articleToken}-Pa_${paragraphToken}-Sg_${itemToken}"]`,
        `[id*="-At_${articleToken}-"][id*="-Pr_${paragraphToken}-"][id*="-It_${itemToken}"]`,
        `[id*="-At_${articleToken}-"][id*="-Co_${paragraphToken}-"][id*="-It_${itemToken}"]`,
        `[id*="-At_${articleToken}-"][id*="-Pa_${paragraphToken}-"][id*="-It_${itemToken}"]`,
      ]);
    }

    if (item) {
      return findElementBySelectors([
        `[id*="-At_${articleToken}-"][id$="-It_${itemToken}"]`,
        `[id*="-At_${articleToken}-"][id$="-Sg_${itemToken}"]`,
        `[id*="-At_${articleToken}-"][id*="-It_${itemToken}"]`,
        `[id*="-At_${articleToken}-"][id*="-Sg_${itemToken}"]`,
      ]);
    }

    if (paragraph) {
      return findElementBySelectors([
        `[id$="-At_${articleToken}-Pr_${paragraphToken}"]`,
        `[id$="-At_${articleToken}-Co_${paragraphToken}"]`,
        `[id$="-At_${articleToken}-Pa_${paragraphToken}"]`,
        `[id*="-At_${articleToken}-Pr_${paragraphToken}"]`,
        `[id*="-At_${articleToken}-Co_${paragraphToken}"]`,
        `[id*="-At_${articleToken}-Pa_${paragraphToken}"]`,
      ]);
    }

    return findElementBySelectors([
      `[id$="-At_${articleToken}"]`,
      `[id*="-At_${articleToken}-"]`,
    ]);
  }

  function getReferenceNumberCandidates(parts) {
    const level = parts.item ? 'item' : parts.paragraph ? 'paragraph' : 'article';
    const raw = level === 'item' ? parts.item : level === 'paragraph' ? parts.paragraph : parts.article;
    const suffix = level === 'item' ? '号' : level === 'paragraph' ? '項' : '条';
    const candidates = new Set();
    const rawText = String(raw || '').trim();
    if (!rawText) return [];

    const segmentSets = rawText.split('-').map((segment) => getReferenceNumberSegmentVariants(segment));
    const combined = [''];
    for (const variants of segmentSets) {
      const current = combined.splice(0);
      for (const prefix of current) {
        for (const variant of variants) {
          combined.push(prefix ? `${prefix}の${variant}` : variant);
        }
      }
    }

    for (const variant of combined) {
      if (!variant) continue;
      candidates.add(variant);
      candidates.add(`第${variant}${suffix}`);
    }

    if (segmentSets.length > 1) {
      const firstSet = segmentSets[0] || [];
      const restCombined = [''];
      for (const variants of segmentSets.slice(1)) {
        const current = restCombined.splice(0);
        for (const prefix of current) {
          for (const variant of variants) {
            restCombined.push(prefix ? `${prefix}の${variant}` : variant);
          }
        }
      }
      for (const first of firstSet) {
        for (const rest of restCombined) {
          if (!first || !rest) continue;
          candidates.add(`第${first}${suffix}の${rest}`);
        }
      }
    }

    return Array.from(candidates).sort((a, b) => b.length - a.length);
  }

  function getReferenceNumberSegmentVariants(raw) {
    const value = String(raw || '').trim();
    const variants = new Set();
    if (!value) return [];

    variants.add(value);
    variants.add(toFullWidth(value));

    const numeric = /^\d+$/.test(value) ? Number(value) : NaN;
    if (Number.isInteger(numeric) && numeric > 0) {
      variants.add(String(numeric));
      variants.add(toFullWidth(String(numeric)));
      const kanji = numToKanjiStr(numeric);
      if (kanji) variants.add(kanji);
      if (_CIRCLED[numeric]) variants.add(_CIRCLED[numeric]);
    }

    return Array.from(variants);
  }

  function ensureReferenceNumberElement(root, parts) {
    if (!(root instanceof Element)) return null;
    if (root.classList.contains('egov-ext-reference-number')) return root;

    const existing = root.querySelector(':scope > .egov-ext-reference-number') ||
      root.querySelector('.egov-ext-reference-number');
    if (existing instanceof Element) return existing;

    const candidates = getReferenceNumberCandidates(parts).map(escapeRegex);
    if (!candidates.length) return null;

    const pattern = new RegExp(`^(\\s*(?:${candidates.join('|')}))`);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent || !pattern.test(node.textContent)) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('.egov-ext-reference-number, script, style, a, button')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const node = walker.nextNode();
    if (!node) return null;

    const match = node.textContent.match(pattern);
    if (!match?.[1]) return null;

    const text = node.textContent;
    const start = match.index || 0;
    const end = start + match[1].length;
    const span = document.createElement('span');
    span.className = 'egov-ext-reference-number';
    span.textContent = text.slice(start, end);

    const fragment = document.createDocumentFragment();
    if (start > 0) fragment.appendChild(document.createTextNode(text.slice(0, start)));
    fragment.appendChild(span);
    if (end < text.length) fragment.appendChild(document.createTextNode(text.slice(end)));
    node.parentNode.replaceChild(fragment, node);
    return span;
  }

  function findReferenceClickableElement(target, targetKey) {
    if (!(target instanceof Element)) return null;
    const parts = getReferenceDomParts(splitReferenceTargetKey(targetKey));
    const selector = parts.item
      ? ':scope > .itemtitle, :scope > .listtitle, :scope > [class*="ItemTitle"], :scope > [class*="Subitem"][class*="Title"]'
      : parts.paragraph
        ? ':scope > .paragraphtitle, :scope > .paragraphnum, :scope > [class*="ParagraphTitle"], :scope > [class*="ParagraphNum"]'
        : ':scope > .articletitle, :scope > .articleheading, :scope > em.articleheading, :scope > ._div_ArticleTitle, :scope > [class*="ArticleTitle"]';
    try {
      const title = target.querySelector(selector);
      if (title instanceof Element) {
        const clickable = ensureReferenceNumberElement(title, parts);
        if (clickable instanceof Element) return clickable;
      }
    } catch (_) {}
    return ensureReferenceNumberElement(target, parts);
  }

  function getReferenceSourceLabel(source) {
    if (source?.isInternalLawSource) {
      return [source.sourceProvisionLabel, source.sourceProvisionText].filter(Boolean).join(' ');
    }
    const lawTitle = String(source?.sourceLawTitle || source?.sourceLawId || '').trim();
    const path = formatProvisionSourcePathFromEgovUrl(source?.sourceUrl, location.href);
    return [lawTitle, path].filter(Boolean).join(' ');
  }

  function hideReferencesPopup() {
    if (!activeReferencesPopup) return;
    activeReferencesPopup.cleanupReferencePopup?.();
    activeReferencesPopup.remove();
    activeReferencesPopup = null;
  }

  function getReferenceLinkModeText(ctrlKey = false) {
    const sameLawPopup = lawRefClickEnabled === false;
    const otherLawPopup = sameLawPopup || lawRefOtherLawPopupEnabled;
    const effectiveSameLawPopup = ctrlKey ? !sameLawPopup : sameLawPopup;
    const effectiveOtherLawPopup = ctrlKey ? !otherLawPopup : otherLawPopup;
    return `他条文リンクは${effectiveSameLawPopup ? 'ポップアップ' : 'スクロール'}/` +
      `他法令リンクは${effectiveOtherLawPopup ? 'ポップアップ' : '別ウィンドウ'}`;
  }

  function showReferencesPopup({ targetKey, sources, point, ctrlKey = false }) {
    if (!Array.isArray(sources) || !sources.length) return;
    hideReferencesPopup();
    activeReferencesPopup = createReferencePopup({
      targetKey,
      sources,
      currentLawTitle: getCurrentLawName(),
      classPrefix: 'egov-ext',
      point,
      sortSources: sortReferenceSources,
      escapeHtml,
      getSourceLabel: getReferenceSourceLabel,
      getLinkModeText: getReferenceLinkModeText,
      initialCtrlKey: ctrlKey,
      onOpen: openReferenceSource,
      onClose: hideReferencesPopup,
    });
  }

  function createReferenceSourceAnchor(source) {
    const url = String(source?.sourceUrl || '');
    if (!url) return null;
    const provisionRoot = document.querySelector('#provisionview') || document.body;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.textContent = getReferenceSourceLabel(source) || url;
    anchor.className = 'egov-ext-reference-source-proxy';
    provisionRoot.appendChild(anchor);
    return anchor;
  }

  function shouldOpenReferenceSourcePopup(event, anchor) {
    const isDifferentLaw = isAnchorDifferentLaw(anchor);
    let shouldPopup = lawRefClickEnabled === false;
    if (lawRefClickEnabled !== false && lawRefOtherLawPopupEnabled && isDifferentLaw) {
      shouldPopup = true;
    }
    return event?.ctrlKey ? !shouldPopup : shouldPopup;
  }

  function ensureInyoDialogBridge() {
    if (inyoDialogBridgeReadyPromise) return inyoDialogBridgeReadyPromise;
    if (inyoDialogBridgeInjected) return Promise.resolve(true);
    inyoDialogBridgeInjected = true;
    if (document.getElementById('egov-ext-inyo-dialog-bridge')) return Promise.resolve(true);

    inyoDialogBridgeReadyPromise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.id = 'egov-ext-inyo-dialog-bridge';
      script.src = chrome.runtime.getURL('inyo-dialog-bridge.js');
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      (document.head || document.documentElement).appendChild(script);
    });
    return inyoDialogBridgeReadyPromise;
  }

  async function requestEgovInyoDialogOpen(lawId, objectId, point = null) {
    const bridgeReady = await ensureInyoDialogBridge();
    if (!bridgeReady) return false;
    const requestId = `egov-inyo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onResult);
        resolve(false);
      }, 300);

      function onResult(event) {
        if (event.source !== window) return;
        if (event.origin !== window.location.origin) return;
        const data = event.data || {};
        if (data.type !== 'egov-ext-open-inyo-dialog-result' || data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener('message', onResult);
        resolve(data.ok === true);
      }

      window.addEventListener('message', onResult);
      window.postMessage({
        type: 'egov-ext-open-inyo-dialog',
        requestId,
        lawId,
        objectId,
        clientX: point?.x ?? 0,
        clientY: point?.y ?? 0,
      }, window.location.origin);
    });
  }

  async function openEgovInyoDialogForSource(source) {
    let parsed;
    try {
      parsed = new URL(source?.sourceUrl || '', location.href);
    } catch (_) {
      return false;
    }

    const sourceLawId = source?.sourceLawId || getLawIdFromLawUrl(parsed.href);
    const objectId = decodeURIComponent(parsed.hash || '').replace(/^#/, '');
    if (!sourceLawId || !objectId) return false;

    return requestEgovInyoDialogOpen(sourceLawId, objectId, {
      x: lawReferenceHoverPoint?.x ?? 0,
      y: lawReferenceHoverPoint?.y ?? 0,
    });
  }

  async function openReferenceSource(source, event = null) {
    const anchor = createReferenceSourceAnchor(source);
    if (!anchor) return;
    const point = event ? { x: event.clientX, y: event.clientY } : null;
    lawReferenceHoverPoint = point;

    hideReferencesPopup();
    if (shouldOpenReferenceSourcePopup(event || {}, anchor)) {
      if (!await openEgovInyoDialogForSource(source)) {
        triggerLawReferencePopup(anchor, event);
        setTimeout(() => anchor.remove(), 1500);
        return;
      }
      anchor.remove();
      return;
    }

    openLawReferenceTarget(anchor);
    anchor.remove();
  }

  function clearExternalReferenceLinks() {
    hideReferencesPopup();
    document.querySelectorAll('.egov-ext-reference-clickable').forEach((el) => {
      el.classList.remove('egov-ext-reference-clickable');
      delete el.dataset.egovReferenceTargetKey;
      delete el.dataset.egovReferenceSupplementArticle;
      el.removeAttribute('title');
      el.removeAttribute('tabindex');
    });
  }

  function makeReferenceClickable(target, targetKey, sources) {
    if (!(target instanceof Element) || !sources?.length) return;
    const clickable = findReferenceClickableElement(target, targetKey);
    if (!(clickable instanceof Element)) return;
    configureReferenceClickable({
      clickable,
      className: 'egov-ext-reference-clickable',
      targetKey,
      sources,
      sourceMap: externalReferencesByElement,
      isEnabled: () => externalReferencesEnabled,
      showPopup: showReferencesPopup,
    });
  }

  function applyReferenceLinksForLaw(lawReferences, { clear = false } = {}) {
    if (clear) clearExternalReferenceLinks();
    return applyReferenceLinksInBatches(lawReferences, {
      isEnabled: () => externalReferencesEnabled,
      findTarget: findReferenceTargetElement,
      makeClickable: makeReferenceClickable,
      schedule: (step) => runWhenIdle(step, 250),
    });
  }

  function applyExternalReferenceLinksForLaw(lawReferences) {
    const generation = ++referenceAnalysisGeneration;
    const { includeInternal, includeExternal } = getReverseReferenceScopeFlags(reverseReferenceScope);
    const externalReferences = includeExternal ? mergeLawReferences(lawReferences) : {};
    applyReferenceLinksForLaw(externalReferences, { clear: true }).then((applied) => {
      if (!applied || !externalReferencesEnabled || generation !== referenceAnalysisGeneration) return;
      if (!includeInternal) return;
      runWhenIdle(() => {
        if (!externalReferencesEnabled || generation !== referenceAnalysisGeneration) return;
        const provisionRoot = document.querySelector('#provisionview');
        const internalReferences = collectInternalLawReferences(provisionRoot, {
          lawId: getCurrentLawIdFromUrl(),
          lawTitle: getCurrentLawName(),
          baseUrl: location.href,
        });
        if (!externalReferencesEnabled || generation !== referenceAnalysisGeneration) return;
        const mergedReferences = mergeLawReferences(externalReferences, internalReferences);
        applyReferenceLinksForLaw(mergedReferences);
      }, 250);
    });
  }

  function setupExternalReferenceInteractions() {
    document.addEventListener('click', (event) => {
      if (!activeReferencesPopup) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.egov-ext-reference-popup, .egov-ext-reference-clickable')) return;
      hideReferencesPopup();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideReferencesPopup();
    });
  }

  async function enableExternalReferenceLinks({ silent = false } = {}) {
    if (externalReferencesEnabled) return true;
    if (externalReferencesLoading) return false;
    externalReferencesLoading = true;
    updateHeaderToggleButtonStates();
    try {
      const ready = await waitForArticles(10000);
      if (!ready) {
        if (!silent) showPinIndicator('条文の読み込み完了後にもう一度試してください');
        return false;
      }

      const stored = await chrome.storage.local.get([REVERSE_REFERENCE_SCOPE_KEY]).catch(() => ({}));
      reverseReferenceScope = normalizeReverseReferenceScope(
        stored[REVERSE_REFERENCE_SCOPE_KEY] ?? reverseReferenceScope
      );
      const { includeExternal } = getReverseReferenceScopeFlags(reverseReferenceScope);
      const lawReferences = includeExternal
        ? await getLawReferencesData(getCurrentLawIdFromUrl())
        : {};
      externalReferencesEnabled = true;
      applyExternalReferenceLinksForLaw(lawReferences);
      if (!silent) showPinIndicator('逆参照リンクを設定しました');
      return true;
    } finally {
      externalReferencesLoading = false;
      updateHeaderToggleButtonStates();
    }
  }

  function disableExternalReferenceLinks({ silent = false } = {}) {
    if (!externalReferencesEnabled) return;
    externalReferencesEnabled = false;
    referenceAnalysisGeneration += 1;
    clearExternalReferenceLinks();
    updateHeaderToggleButtonStates();
    if (!silent) showPinIndicator('逆参照リンクを無効化しました');
  }

  function toggleExternalReferenceLinks() {
    if (externalReferencesEnabled) {
      disableExternalReferenceLinks();
      return;
    }
    enableExternalReferenceLinks();
  }

  async function autoEnableExternalReferenceLinks() {
    if (externalReferencesEnabled) return;
    await enableExternalReferenceLinks();
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
    return favoritesStore.get();
  }

  async function saveFavoritesCache() {
    await favoritesStore.save();
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
    // Use element-type-qualified selectors to avoid scanning all 4000+ [id*="-At_"] elements
    // (which includes _div_ArticleTitle etc.). section.Article = new rendering,
    // article.article = old rendering. offsetParent filters out display:none revision history.
    articleElementsCache = [...document.querySelectorAll('section[id*="-At_"], article[id*="-At_"]')]
      .filter(el => /\-At_[\d_]+$/.test(el.id) && el.offsetParent !== null);
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

    let low = 0;
    let high = articles.length - 1;
    let currentIdx = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (getViewportTop(articles[mid]) <= anchorTop + 1) {
        currentIdx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
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
      favoritesStore.replace(favorites);
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

  function getLawReferenceAnchor(target) {
    const baseEl =
      target instanceof Element ? target :
      target instanceof Node ? target.parentElement :
      null;
    const anchor = baseEl ? baseEl.closest('a[href]') : null;
    if (!anchor) return null;

    const provisionRoot = document.querySelector('#provisionview');
    if (!(provisionRoot instanceof Element) || !provisionRoot.contains(anchor)) return null;

    let url;
    try {
      url = new URL(anchor.href, location.href);
    } catch (_) {
      return null;
    }

    if (url.origin !== location.origin) return null;
    if (!url.pathname.startsWith('/law/')) return null;
    return anchor;
  }

  function getLawTocElement() {
    const toc = document.querySelector('#TOC');
    if (!(toc instanceof Element)) return null;
    if (!toc.querySelector('a[href], li, ol, ul')) return null;
    return toc;
  }

  function cloneLawTocForDialog(tocEl) {
    const clone = tocEl.cloneNode(true);
    clone.removeAttribute('id');
    clone.removeAttribute('aria-hidden');
    clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    clone.querySelectorAll('[aria-hidden]').forEach((el) => el.removeAttribute('aria-hidden'));
    return clone;
  }

  function getHashTargetElement(hash) {
    const rawHash = String(hash || '');
    if (!rawHash || rawHash === '#') return null;

    const targetId = decodeURIComponent(rawHash.replace(/^#/, ''));
    if (!targetId) return null;

    const provisionRoot = document.querySelector('#provisionview') || document.body;
    const escapedId = globalThis.CSS?.escape
      ? CSS.escape(targetId)
      : targetId.replace(/(["\\#.:[\],=<>+~*^$| ])/g, '\\$1');

    let target = null;
    try {
      target = document.getElementById(targetId) || provisionRoot.querySelector(`#${escapedId}`);
    } catch (_) {
      target = document.getElementById(targetId);
    }

    if (!(target instanceof Element) && targetId.startsWith('Mp-')) {
      const suffix = targetId.slice(2);
      try {
        target = provisionRoot.querySelector(`[id$="${suffix}"]`);
      } catch (_) {}
    }

    return target instanceof Element ? target : null;
  }

  function getNaturalTocFocusIndex(tocAnchors) {
    if (!Array.isArray(tocAnchors) || tocAnchors.length === 0) return -1;

    const currentArticle = getArticleAtViewport25pct();
    if (!(currentArticle instanceof Element)) return 0;
    const currentTop = getArticleAbsoluteTop(currentArticle);

    let bestIdx = -1;
    let bestTop = -Infinity;
    let fallbackIdx = -1;
    let fallbackTop = Infinity;

    tocAnchors.forEach((anchor, idx) => {
      let url;
      try {
        url = new URL(anchor.href, location.href);
      } catch (_) {
        return;
      }
      if (!url.hash || url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search) return;
      const target = getHashTargetElement(url.hash);
      if (!(target instanceof Element)) return;

      const top = getArticleAbsoluteTop(target);
      if (top <= currentTop + 1 && top > bestTop) {
        bestTop = top;
        bestIdx = idx;
      }
      if (top >= currentTop - 1 && top < fallbackTop) {
        fallbackTop = top;
        fallbackIdx = idx;
      }
    });

    if (bestIdx >= 0) return bestIdx;
    if (fallbackIdx >= 0) return fallbackIdx;
    return 0;
  }

  function showLawTocDialog(options = {}) {
    const tocEl = getLawTocElement();
    if (!tocEl) return;

    const dialog = createDialog(`
      <div class="egov-ext-dialog-header">
        <div class="egov-ext-dialog-title">
          <span class="egov-ext-title-icon">≡</span> 目次
        </div>
        <button class="egov-ext-close" aria-label="閉じる">×</button>
      </div>
      <div class="egov-ext-dialog-body">
        <div class="egov-ext-toc-panel" id="egov-law-toc-panel"></div>
        <p class="egov-ext-hint">
          <kbd>↑</kbd><kbd>↓</kbd> / <kbd>n</kbd><kbd>p</kbd> で項目移動 ・ <kbd>d</kbd><kbd>u</kbd> でページ移動 ・ <kbd>Enter</kbd> で選択
        </p>
      </div>
    `, 'egov-ext-toc-mode');

    const panel = dialog.querySelector('#egov-law-toc-panel');
    if (!(panel instanceof Element)) return;

    const tocClone = cloneLawTocForDialog(tocEl);
    panel.appendChild(tocClone);

    const tocAnchors = Array.from(panel.querySelectorAll('a[href]'));
    let focusedIdx = -1;

    function setFocusedTocItem(nextIdx, scrollBlock = 'nearest') {
      tocAnchors.forEach((anchor, idx) => {
        anchor.classList.toggle('egov-ext-toc-link-focused', idx === nextIdx);
      });
      focusedIdx = nextIdx;
      if (focusedIdx >= 0 && tocAnchors[focusedIdx]) {
        tocAnchors[focusedIdx].scrollIntoView({ block: scrollBlock });
      }
    }

    function moveFocusedTocItem(direction) {
      if (tocAnchors.length === 0) return;
      const nextIdx = focusedIdx < 0
        ? (direction > 0 ? 0 : tocAnchors.length - 1)
        : (focusedIdx + direction + tocAnchors.length) % tocAnchors.length;
      setFocusedTocItem(nextIdx);
    }

    function pageMoveFocusedTocItem(direction) {
      if (tocAnchors.length === 0) return;
      const currentAnchor = tocAnchors[Math.max(0, focusedIdx)];
      if (!(currentAnchor instanceof Element)) {
        setFocusedTocItem(direction > 0 ? 0 : tocAnchors.length - 1);
        return;
      }

      const panelRect = panel.getBoundingClientRect();
      const pageDelta = panel.clientHeight * 0.8 * direction;
      const maxScrollTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
      const targetScrollTop = Math.max(0, Math.min(maxScrollTop, panel.scrollTop + pageDelta));
      const currentY = currentAnchor.getBoundingClientRect().top - panelRect.top + panel.scrollTop;
      const targetY = currentY + pageDelta;

      let nextIdx = focusedIdx;
      let nearestDiff = Infinity;
      for (let i = 0; i < tocAnchors.length; i++) {
        const anchor = tocAnchors[i];
        const anchorY = anchor.getBoundingClientRect().top - panelRect.top + panel.scrollTop;
        const diff = Math.abs(anchorY - targetY);
        if (diff < nearestDiff) {
          nearestDiff = diff;
          nextIdx = i;
        }
      }

      panel.scrollTo({ top: targetScrollTop, behavior: scrollBehavior });
      setFocusedTocItem(Math.max(0, Math.min(tocAnchors.length - 1, nextIdx)));
    }

    if (tocAnchors.length > 0) {
      const initialIdx = options.initialFocus === 'natural'
        ? getNaturalTocFocusIndex(tocAnchors)
        : 0;
      setFocusedTocItem(Math.max(0, initialIdx), options.initialFocus === 'natural' ? 'center' : 'nearest');
    }

    panel.addEventListener('click', (event) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      event.preventDefault();
      openLawReferenceTarget(anchor);
      closeDialog();
    });

    panel.addEventListener('mousemove', (event) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      const idx = tocAnchors.indexOf(anchor);
      if (idx >= 0 && idx !== focusedIdx) setFocusedTocItem(idx);
    });

    panel.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'n') {
        event.preventDefault();
        moveFocusedTocItem(+1);
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'p') {
        event.preventDefault();
        moveFocusedTocItem(-1);
        return;
      }
      if (event.key === 'Enter') {
        const anchor = tocAnchors[focusedIdx];
        if (!anchor) return;
        event.preventDefault();
        openLawReferenceTarget(anchor);
        closeDialog();
        return;
      }
      if (event.key === 'd') {
        event.preventDefault();
        pageMoveFocusedTocItem(+1);
        return;
      }
      if (event.key === 'u') {
        event.preventDefault();
        pageMoveFocusedTocItem(-1);
      }
    });

    panel.tabIndex = 0;
    panel.focus();
  }

  function clearLawReferenceHoverTimer() {
    if (lawReferenceHoverTimer) {
      clearTimeout(lawReferenceHoverTimer);
      lawReferenceHoverTimer = null;
    }
    lawReferenceHoverAnchor = null;
  }

  function ensureLawReferenceShield() {
    if (lawReferenceShieldEl) return lawReferenceShieldEl;
    const shield = document.createElement('div');
    shield.id = 'egov-ext-lawref-shield';
    shield.addEventListener('mousemove', (event) => {
      lawReferenceHoverPoint = { x: event.clientX, y: event.clientY };
      setMutedParenHoverGroup(getMutedParenGroupAtPoint(event.clientX, event.clientY));
    });
    shield.addEventListener('mouseleave', () => {
      lawReferenceShieldAnchor = null;
      shield.style.display = 'none';
      clearLawReferenceHoverTimer();
      setMutedParenHoverGroup('');
    });
    shield.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const anchor = lawReferenceShieldAnchor;
      if (!anchor) return;
      if (shouldSuppressLawReferencePopup(event, anchor)) {
        openLawReferenceTarget(anchor);
        return;
      }
      hideLawReferencePreview();
      triggerLawReferencePopup(anchor, event);
    });
    shield.addEventListener('wheel', handleLawReferenceShieldWheel, { passive: false });
    document.body.appendChild(shield);
    lawReferenceShieldEl = shield;
    return shield;
  }

  function getNormalizedWheelDelta(event) {
    let unit = 1;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      unit = parseFloat(window.getComputedStyle(document.body).lineHeight) || 16;
    } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      const container = getScrollContainer();
      unit = container?.clientHeight || window.innerHeight || 800;
    }
    return {
      left: event.deltaX * unit,
      top: event.deltaY * unit,
    };
  }

  function handleLawReferenceShieldWheel(event) {
    const delta = getNormalizedWheelDelta(event);
    hideLawReferencePreview();
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const container = getScrollContainer();
    if (container) {
      container.scrollBy({ left: delta.left, top: delta.top, behavior: 'auto' });
      return;
    }
    window.scrollBy({ left: delta.left, top: delta.top, behavior: 'auto' });
  }

  function hideLawReferencePreview() {
    clearLawReferenceHoverTimer();
    if (lawReferenceShieldEl) lawReferenceShieldEl.style.display = 'none';
    lawReferenceShieldAnchor = null;
  }

  function positionLawReferenceShield(anchor) {
    const shield = ensureLawReferenceShield();
    const rect = anchor.getBoundingClientRect();
    // position: fixed なので viewport 座標をそのまま使う
    shield.style.left = `${Math.max(0, rect.left)}px`;
    shield.style.top = `${Math.max(0, rect.top)}px`;
    shield.style.width = `${Math.max(1, rect.width)}px`;
    shield.style.height = `${Math.max(1, rect.height)}px`;
    shield.style.display = 'block';
    lawReferenceShieldAnchor = anchor;
  }

  function activateLawReferenceAnchorAtPoint(point) {
    if (!point) return false;
    const target = document.elementFromPoint(point.x, point.y);
    const anchor = getLawReferenceAnchor(target);
    if (!anchor) return false;
    if (!shouldSuppressLawReferencePopup({ ctrlKey: true }, anchor)) return false;
    activateLawReferenceAnchor(anchor, point);
    return true;
  }

  function triggerLawReferencePopup(anchor, sourceEvent = null) {
    const point = lawReferenceHoverPoint;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      ctrlKey: !!sourceEvent?.ctrlKey,
      shiftKey: !!sourceEvent?.shiftKey,
      altKey: !!sourceEvent?.altKey,
      metaKey: !!sourceEvent?.metaKey,
      clientX: point?.x ?? 0,
      clientY: point?.y ?? 0,
      screenX: point?.x ?? 0,
      screenY: point?.y ?? 0,
    };

    anchor.dispatchEvent(new MouseEvent('mouseenter', eventInit));
    anchor.dispatchEvent(new MouseEvent('mouseover', eventInit));
    anchor.dispatchEvent(new MouseEvent('mousemove', eventInit));
    anchor.dispatchEvent(new MouseEvent('mousedown', eventInit));
    anchor.dispatchEvent(new MouseEvent('mouseup', eventInit));
    anchor.dispatchEvent(new MouseEvent('click', eventInit));
  }

  function openLawReferenceTarget(anchor) {
    let url;
    try {
      url = new URL(anchor.href, location.href);
    } catch (_) {
      return;
    }

    hideLawReferencePreview();
    lawReferenceOpenLockUntil = Date.now() + 1500;

    const targetLawId = getLawIdFromLawUrl(url.href);
    const isSamePageHashLink =
      !!url.hash &&
      url.origin === location.origin &&
      url.pathname === location.pathname &&
      url.search === location.search;
    if (isSamePageHashLink || (targetLawId && targetLawId === getCurrentLawIdFromUrl())) {
      const sourceJumpKey =
        getProvisionJumpKeyFromNode(anchor) ||
        buildJumpHistoryKey(parseProvisionPath(getArticleAtViewport25pct()?.id || ''));
      if (!jumpToHashTarget(url.hash, { sourceJumpKey })) {
        // getElementById で見つからなかった場合: SPA router に委ねる
        // 同じ hash が既にセットされていると hashchange が発火しないので一旦リセット
        if (location.hash === url.hash) {
          history.replaceState(null, '', location.pathname + location.search);
          requestAnimationFrame(() => { location.hash = url.hash; });
        } else {
          location.hash = url.hash;
        }
      }
      return;
    }

    chrome.runtime.sendMessage({
      type: 'egov-open-law-reference-tab',
      url: url.href,
    }).catch(() => {
      window.open(url.href, '_blank', 'noopener');
    });
  }

  function activateLawReferenceAnchor(anchor, point) {
    if (!anchor) {
      hideLawReferencePreview();
      return;
    }

    lawReferenceHoverPoint = point;
    positionLawReferenceShield(anchor);

    if (lawReferenceHoverAnchor === anchor && lawReferenceHoverTimer) return;
    clearLawReferenceHoverTimer();
    lawReferenceHoverAnchor = anchor;

    // ホバーポップアップが無効、またはクリック直後のロック中はタイマーを起動しない
    if (!lawRefHoverPopupEnabled || Date.now() < lawReferenceOpenLockUntil) return;

    lawReferenceHoverTimer = setTimeout(() => {
      lawReferenceHoverTimer = null;
      if (lawReferenceHoverAnchor !== anchor) return;
      triggerLawReferencePopup(anchor);
    }, 1000);
  }

  function isAnchorDifferentLaw(anchor) {
    const targetLawId = getLawIdFromLawUrl(anchor.href);
    return !!(targetLawId && targetLawId !== getCurrentLawIdFromUrl());
  }

  function shouldSuppressLawReferencePopup(event, anchor) {
    const baseSuppress = lawRefClickEnabled !== false;
    const effectiveSuppress = event?.ctrlKey ? !baseSuppress : baseSuppress;
    if (!effectiveSuppress) return false;
    return !(lawRefOtherLawPopupEnabled && isAnchorDifferentLaw(anchor));
  }

  function setupLawReferenceInteractions() {
    if (lawReferenceInteractionsInitialized) return;
    lawReferenceInteractionsInitialized = true;

    document.addEventListener('mouseover', (event) => {
      if (!event.isTrusted) return;
      lawReferencePointerPoint = { x: event.clientX, y: event.clientY };
      const anchor = getLawReferenceAnchor(event.target);
      if (!anchor) return;
      if (!shouldSuppressLawReferencePopup(event, anchor)) {
        hideLawReferencePreview();
        return;
      }
      activateLawReferenceAnchor(anchor, { x: event.clientX, y: event.clientY });
    }, true);

    document.addEventListener('mouseout', (event) => {
      if (!event.isTrusted) return;
      if (!lawReferenceHoverAnchor) return;

      const fromAnchor = getLawReferenceAnchor(event.target);
      if (!fromAnchor || fromAnchor !== lawReferenceHoverAnchor) return;

      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node) {
        const nextAnchor = getLawReferenceAnchor(nextTarget);
        if (nextAnchor && nextAnchor === lawReferenceHoverAnchor) return;
        if (lawReferenceShieldEl?.contains(nextTarget)) return;
      }

      hideLawReferencePreview();
    }, true);

    document.addEventListener('mousemove', (event) => {
      if (!event.isTrusted) return;
      lawReferencePointerPoint = { x: event.clientX, y: event.clientY };
      const anchor = getLawReferenceAnchor(event.target);
      if (anchor && shouldSuppressLawReferencePopup(event, anchor)) {
        activateLawReferenceAnchor(anchor, lawReferencePointerPoint);
        return;
      }
      if (!lawReferenceShieldAnchor) return;
      lawReferenceHoverPoint = { x: event.clientX, y: event.clientY };
    }, true);

    document.addEventListener('mousedown', (event) => {
      if (!event.isTrusted) return;
      const anchor = getLawReferenceAnchor(event.target);
      if (anchor && shouldSuppressLawReferencePopup(event, anchor)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      const insideShield = lawReferenceShieldEl?.contains(event.target);
      if (!insideShield) hideLawReferencePreview();
    }, true);

    document.addEventListener('mouseup', (event) => {
      if (!event.isTrusted) return;
      const anchor = getLawReferenceAnchor(event.target);
      if (!anchor || !shouldSuppressLawReferencePopup(event, anchor)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }, true);

    document.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const anchor = getLawReferenceAnchor(event.target);
      if (!anchor || !shouldSuppressLawReferencePopup(event, anchor)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      openLawReferenceTarget(anchor);
    }, true);

    document.addEventListener('keydown', (event) => {
      if (!event.isTrusted || event.key !== 'Control' || lawRefClickEnabled !== false) return;
      activateLawReferenceAnchorAtPoint(lawReferencePointerPoint);
    }, true);

    document.addEventListener('keyup', (event) => {
      if (!event.isTrusted || event.key !== 'Control' || lawRefClickEnabled !== false) return;
      hideLawReferencePreview();
    }, true);

    window.addEventListener('scroll', () => hideLawReferencePreview(), { passive: true });
    window.addEventListener('resize', () => hideLawReferencePreview());

    const scrollContainer = getScrollContainer();
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', () => hideLawReferencePreview(), { passive: true });
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
        navigateFromViewportStart(resultEl);
        refocusSearchInput();
      } else {
        navigateFromViewportStart(resultEl);
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
    const regex = new RegExp(escapeRegex(query), 'gi');
    const searchRoot = document.querySelector('#provisionview') || document.body;
    const searchText = collectSearchTextSegments(searchRoot, { excludeSelector: '.egov-ext-overlay, #TOC' });
    let match;
    while ((match = regex.exec(searchText.text)) !== null) {
      const range = rangeFromSearchOffsets(searchText.segments, match.index, match.index + match[0].length);
      if (range) ranges.push(range);
    }
    if (CSS.highlights) {
      CSS.highlights.set('egov-search', new Highlight(...ranges));
      CSS.highlights.set('egov-search-current', new Highlight());
    }
    return ranges;
  }

  function clearHighlights() {
    clearFlashElementHighlight();
    if (activeProvisionSelectionEl) {
      activeProvisionSelectionEl.classList.remove('egov-ext-provision-selected');
      activeProvisionSelectionEl = null;
    }
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

  async function showLawSearchDialog() {
    const favorites = await readFavorites();

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
      toggleFavoriteRecord(
        favorites,
        { lawId: law.lawId, lawName: law.lawName, lawNum: law.lawNum, lawType: law.lawType, folderId: null },
        FAVORITES_MAX
      );
      persistLocal({ favorites: [...favorites] }, { errorLabel: 'お気に入りの保存' });
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
  // カタカナをひらがなに変換（Alt+H / 一方通行）
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

  function clearGuideTooltipHoverHideTimer() {
    if (!guideTooltipHoverHideTimer) return;
    clearTimeout(guideTooltipHoverHideTimer);
    guideTooltipHoverHideTimer = null;
  }

  function showShortcutGuideTooltip() {
    const guide = document.getElementById('egov-ext-guide');
    if (!guide) return;
    clearGuideTooltipHoverHideTimer();
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
        <div class="egov-ext-guide-header">
          <div class="egov-ext-guide-title">キーボードショートカット</div>
          <button type="button" class="egov-ext-guide-manual-button">マニュアル</button>
        </div>
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
          <tr><td><kbd>w</kbd></td>
              <td>サイドバーを隠して本文を全幅表示 / 元に戻す</td></tr>
          <tr><td><kbd>s</kbd></td>
              <td>ページ内検索<br>
                <span class="egov-ext-guide-sub">Ctrl+Enter=現在位置から検索</span></td></tr>
          <tr><td><kbd>r</kbd></td>
              <td>ジャンプ前の位置に戻る</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>R</kbd></td>
              <td>現在の法令名で法令検索（別タブで開く）</td></tr>
          <tr><td><kbd>c</kbd></td>
              <td>条文番号の漢数字/アラビア数字の切り替え<br>
                <span class="egov-ext-guide-sub">号タイトルは丸数字（①②③）</span></td></tr>
          <tr><td><kbd>e</kbd></td>
              <td>逆参照リンクを有効化/無効化する</td></tr>
          <tr><td><kbd>g</kbd></td>
              <td>本文中の括弧書きを薄く表示 / 元に戻す</td></tr>
          <tr><td><kbd>Shift</kbd>+<kbd>G</kbd></td>
              <td>本文中の括弧書きをさらに薄く表示 / 元に戻す</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>H</kbd></td>
              <td>カタカナをひらがなに変換</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>O</kbd></td>
              <td>オプション画面を開く</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>L</kbd></td>
              <td>Liteモードに変更</td></tr>
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
        <tr><td><kbd>a</kbd></td><td>条文リンクコピー<br><span class="egov-ext-guide-sub">Enter=URL / Ctrl+Enter=条項+URL / Shift+Enter=法令名+条文番号+URL</span></td></tr>
      `);
    }

    const tGuideRow = [...guideTable.querySelectorAll('tr')].find((tr) => tr.querySelector('td')?.textContent.trim() === 's');
    if (tGuideRow) {
      tGuideRow.insertAdjacentHTML('beforebegin', `
        <tr><td><kbd>t</kbd></td><td>目次ダイアログを開く</td></tr>
        <tr><td><kbd>Shift</kbd>+<kbd>T</kbd></td><td>現在位置に合わせて目次ダイアログを開く</td></tr>
      `);
    }

    document.body.appendChild(guide);

    // ガイドボタンクリックで有効/無効トグル
    guide.addEventListener('mouseenter', () => {
      clearGuideTooltipHoverHideTimer();
      guide.classList.add('egov-ext-guide-hover');
    });

    guide.addEventListener('mouseleave', () => {
      clearGuideTooltipHoverHideTimer();
      guideTooltipHoverHideTimer = setTimeout(() => {
        guideTooltipHoverHideTimer = null;
        guide.classList.remove('egov-ext-guide-hover');
      }, 500);
    });

    guide.querySelector('.egov-ext-guide-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      extensionEnabled = !extensionEnabled;
      updateGuideButtonState();
    });
    guide.querySelector('.egov-ext-guide-manual-button').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openManualPageFromGuide();
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

  function applyDefaultLawSidebarVisibility() {
    chrome.storage.local.get(['hideLawSidebarDefault'], ({ hideLawSidebarDefault }) => {
      if (hideLawSidebarDefault !== true || setLawRevisionAreaExpanded(true)) return;

      const observer = new MutationObserver(() => {
        if (!setLawRevisionAreaExpanded(true)) return;
        observer.disconnect();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 10000);
    });
  }

  function setupColorPinFeatures() {
    runWhenIdle(() => refreshColorPinHighlights(), 1200);
    // pinToastDefaultVisible は起動時に既に読み込み済み
    pinToastPinned = pinToastDefaultVisible;
    if (pinToastPinned) runWhenIdle(() => showPinToast(false), 1200);
    else hidePinToast(true);
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
    const articleRoot = document.querySelector('#provisionview') || document.documentElement;
    observeArticleChanges({
      root: articleRoot,
      shouldInvalidate: shouldInvalidateArticleCache,
      onInvalidate() {
        invalidateArticleCache();
        if (defTooltipEnabled && postLoadEnrichmentReady) scheduleApplyDefinitionTooltips();
      },
    });
    // 法令参照設定の読み込みを非同期にし、他の初期化をブロックしない
    runWhenIdle(() => {
      chrome.storage.local.get(['lawRefClickEnabled', 'lawRefHoverPopup', 'lawRefOtherLawPopup', REVERSE_REFERENCE_SCOPE_KEY], ({
        lawRefClickEnabled: storedLawRefClickEnabled,
        lawRefHoverPopup,
        lawRefOtherLawPopup,
        reverseReferenceScope: storedReverseReferenceScope,
      }) => {
        lawRefClickEnabled = storedLawRefClickEnabled !== false;
        lawRefHoverPopupEnabled = lawRefHoverPopup === true;
        lawRefOtherLawPopupEnabled = lawRefOtherLawPopup !== false;
        reverseReferenceScope = normalizeReverseReferenceScope(storedReverseReferenceScope);
        setupLawReferenceInteractions();
      });
    }, 1800);
    runWhenIdle(ensureShortcutGuide, 900);
    runWhenIdle(applyDefaultLawSidebarVisibility, 900);
    runWhenIdle(setupFavoriteHeaderBadge, 1200);
    runWhenIdle(setupColorPinFeatures, 1600);
    setupDefinitionTooltipInteractions();
    setupExternalReferenceInteractions();
    runAfterPageLoadWhenIdle(() => {
      postLoadEnrichmentReady = true;
      // Historical key name: this controls the definition guide in both normal and Lite modes.
      chrome.storage.local.get(['liteDefTooltipEnabled', 'defTooltipClickOnly'], ({ liteDefTooltipEnabled, defTooltipClickOnly: storedClickOnly }) => {
        defTooltipEnabled = liteDefTooltipEnabled !== false;
        defTooltipClickOnly = storedClickOnly !== false;
        if (defTooltipEnabled) scheduleApplyDefinitionTooltips();
        else clearDefinitionTooltips();
        updateHeaderToggleButtonStates();
      });
      chrome.storage.local.get(['externalReferencesAutoEnable', REVERSE_REFERENCE_SCOPE_KEY], ({ externalReferencesAutoEnable, reverseReferenceScope: storedReverseReferenceScope }) => {
        reverseReferenceScope = normalizeReverseReferenceScope(storedReverseReferenceScope);
        if (externalReferencesAutoEnable !== false) autoEnableExternalReferenceLinks();
      });
    }, 2500);
    restoreFavoriteScrollOnLoad()
      .then((restored) => {
        if (!restored) moveToFirstArticleOnLoad();
        runWhenIdle(setupFavoriteScrollPersistence, 1800);
      })
      .catch(() => {
        moveToFirstArticleOnLoad();
        runWhenIdle(setupFavoriteScrollPersistence, 1800);
      });
  }

  startWhenDomReady(initializeLawPageFeatures);
})();
