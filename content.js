/**
 * e-Gov法令検索 拡張機能 - コンテンツスクリプト
 *
 * キーボードショートカット（入力欄フォーカス外）:
 *   0-9    : 条文ジャンプ（3.2.1 で 第3条第2項第1号 指定）
 *   h / l  : 条文ジャンプ履歴を前後に移動
 *   n / p  : 次/前の条文を画面上端に表示
 *   d / u  : 下/上へ80%スクロール
 *   Space  : 現在位置の条文ブックマークを追加/削除
 *   b      : 条文ブックマーク一覧を開く/閉じる
 *   m      : ハイライト・メモ一覧を開く/閉じる
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
    canonicalizeReferenceTargetKey,
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
    getNormalizedTextSignature,
    getReferenceDomParts,
    getReverseReferenceScopeFlags,
    getTextRangeClientRects,
    getTextRangeText,
    isTermBoundarySafe: isSharedTermBoundarySafe,
    mergeLawReferences,
    normalizeLawNameForCopy,
    normalizeReverseReferenceScope,
    parseProvisionHash,
    rangeFromSearchOffsets,
    rangeFromNormalizedTextAnchorOffsets,
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
  let favoriteScrollPersistenceSetup = false;
  let pageIndicatorTimer = null;
  let articleBookmarksCache = [];
  let articleBookmarksLoaded = false;
  let articleBookmarkRenderVersion = 0;
  let articleBookmarkGutterSignature = '';
  const articleBookmarkGutterButtons = new Map();
  let articleBookmarkProvisionItemsCache = null;
  const articleBookmarkToggleLocks = new Set();
  const articleBookmarkLastToggleAt = new Map();
  let articleBookmarkGuttersDirty = false;
  let articleBookmarkDialogSessionActive = false;
  let keyboardBookmarkTargetId = '';
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
  // null の間は保存設定を使用し、boolean の間はこの法令画面だけで一時上書きする。
  let lawRefPageScrollOverride = null;
  let lawRefModeCtrlPressed = false;
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
  let referenceTargetElementIndex = new Map();
  let activeReferencesPopup = null;
  let inyoDialogBridgeInjected = false;
  let inyoDialogBridgeReadyPromise = null;
  const externalReferencesByElement = new WeakMap();
  let activeProvisionSelectionEl = null;
  let textHighlightPopup = null;
  let textHighlightTargetOutline = null;
  let textHighlightTargetOutlineRaf = 0;
  let textHighlightMemoTooltip = null;
  let textHighlightMemoTooltipRecordId = '';
  let textHighlightMemoTooltipSource = null;
  let textHighlightMemoHideTimer = 0;
  let textHighlightHitTestCache = null;
  let pendingTextHighlightRange = null;
  let pendingTextHighlightSource = null;
  let textHighlightRangeAdjusting = false;
  let textHighlightRangeButtonResetTimer = 0;
  let textHighlightOverlapNoticeTimer = 0;
  let textHighlightSequence = 0;
  const textHighlightRangeSequence = new WeakMap();
  const textHighlightRangeRecordId = new WeakMap();
  const textHighlightRecords = new Map();
  const textHighlightDirtyRecordIds = new Set();
  const textHighlightDeletedRecordIds = new Set();
  let textHighlightSaveTimer = 0;
  let textHighlightRestoreTimer = 0;
  let textHighlightRestoreNoticeTimer = 0;
  let textHighlightUnrestoredRecords = [];
  let textHighlightUnrestoredSignature = '';
  let textHighlightUnrestoredStablePasses = 0;
  let textHighlightRestoreNoticeIgnored = false;
  let textHighlightPendingStorageRecords = null;
  let textHighlightRecordsLoaded = false;
  let textHighlightLoadPromise = null;
  const TEXT_HIGHLIGHT_STORAGE_PREFIX = 'textHighlights:v1:';
  const TEXT_HIGHLIGHT_ENABLED_KEY = 'textHighlightsEnabled';
  const TEXT_HIGHLIGHT_DISPLAY_LIMIT = 1000;
  const TEXT_HIGHLIGHT_QUOTE_HEAD_LENGTH = 256;
  const TEXT_HIGHLIGHT_QUOTE_TAIL_LENGTH = 128;
  const TEXT_HIGHLIGHT_CONTEXT_LENGTH = 32;
  const TEXT_HIGHLIGHT_MEMO_MAX_LENGTH = 2000;
  let textHighlightFeatureEnabled = true;
  const TEXT_HIGHLIGHT_TEXT_EXCLUDE_SELECTOR =
    '.egov-ext-reference-popup, .egov-ext-definition-tooltip, #egov-ext-text-highlight-popup, ' +
    '#egov-ext-text-highlight-memo-tooltip, #egov-ext-text-highlight-target-outline, ' +
    '#egov-ext-text-highlight-restore-notice, #egov-ext-text-highlight-overlap-notice';
  const TEXT_HIGHLIGHT_PORTABLE_EXCLUDE_SELECTOR =
    `${TEXT_HIGHLIGHT_TEXT_EXCLUDE_SELECTOR}, ._div_ArticleCaption, ` +
    '._div_ArticleTitle > span:first-child, ._div_ParagraphSentence > span:first-child, ' +
    '._div_ItemSentence > span:first-child, ' +
    '[class*="_div_Subitem"][class*="Sentence"] > span:first-child, ' +
    '.articletitle, .paragraphtitle, .paragraphnum, .itemtitle, .listtitle, .portiontitle, rt, rp';
  const textHighlightRanges = {
    yellow: [],
    pink: [],
    green: [],
  };
  const TEXT_HIGHLIGHT_COLORS = [
    { key: 'yellow', label: '薄い黄色' },
    { key: 'pink', label: '薄いピンク' },
    { key: 'green', label: '薄い緑' },
  ];
  const ARTICLE_BOOKMARKS_STORAGE_KEY = 'articleBookmarks';
  const BOOKMARK_SHORTCUT_KEYS = ['f', 'j', 'd', 'k', 's', 'l', 'a'];
  const ARTICLE_BOOKMARK_TOGGLE_DEBOUNCE_MS = 500;

  // スクロール速度（'instant' | 'smooth'、デフォ: instant）
  let scrollBehavior = 'instant';
  chrome.storage.local.get(['scrollBehavior', ARTICLE_BOOKMARKS_STORAGE_KEY], (data) => {
    if (data.scrollBehavior === 'smooth') scrollBehavior = 'smooth';
    articleBookmarksCache = normalizeArticleBookmarks(data[ARTICLE_BOOKMARKS_STORAGE_KEY]);
    articleBookmarksLoaded = true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.scrollBehavior) scrollBehavior = changes.scrollBehavior.newValue;
      if (changes.favorites) {
        favoritesStore.replace(changes.favorites.newValue);
        refreshFavoriteHeaderBadge();
      }
      if (changes[ARTICLE_BOOKMARKS_STORAGE_KEY]) {
        articleBookmarksCache = normalizeArticleBookmarks(changes[ARTICLE_BOOKMARKS_STORAGE_KEY].newValue);
        articleBookmarksLoaded = true;
        const nextGutterSignature = getArticleBookmarkGutterSignature(articleBookmarksCache);
        if (articleBookmarkDialogSessionActive) {
          if (nextGutterSignature !== articleBookmarkGutterSignature) articleBookmarkGuttersDirty = true;
        } else if (nextGutterSignature !== articleBookmarkGutterSignature) {
          renderArticleBookmarkGutters();
        }
      }
      if (changes.lawRefOtherLawPopup) {
        lawRefOtherLawPopupEnabled = changes.lawRefOtherLawPopup.newValue !== false;
      }
      if (changes.lawRefClickEnabled) {
        lawRefClickEnabled = changes.lawRefClickEnabled.newValue !== false;
        if (!lawRefClickEnabled) hideLawReferencePreview();
        updateLawRefModeButton();
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
      const textHighlightStorageKey = getTextHighlightStorageKey();
      if (textHighlightStorageKey && changes[textHighlightStorageKey]) {
        syncTextHighlightRecordsFromStorage(changes[textHighlightStorageKey].newValue);
      }
    }
  });

  // ==================
  // 履歴ユーティリティ
  // ==================
  function pushHistory(history, value) {
    pushSharedHistory(history, value, HISTORY_MAX);
  }

  // ==================
  // 選択テキストの一時ハイライト
  // ==================
  function isTextHighlightMemoEditing() {
    return !!textHighlightPopup?.querySelector('.egov-ext-text-highlight-memo-editor.is-visible');
  }

  function isTextHighlightMemoDirty() {
    const textarea = textHighlightPopup?.querySelector('.egov-ext-text-highlight-memo-editor.is-visible textarea');
    return !!textarea && textarea.value !== (textarea.dataset.initialValue || '');
  }

  function updateTextHighlightMemoDirtyState() {
    const editor = textHighlightPopup?.querySelector('.egov-ext-text-highlight-memo-editor');
    const textarea = editor?.querySelector('textarea');
    const status = editor?.querySelector('.egov-ext-text-highlight-memo-status');
    if (!editor || !textarea || !status) return false;
    const dirty = textarea.value !== (textarea.dataset.initialValue || '');
    editor.classList.toggle('is-dirty', dirty);
    status.textContent = dirty ? '未保存のメモの変更があります' : '';
    return dirty;
  }

  function hideTextHighlightTargetOutline() {
    if (textHighlightTargetOutlineRaf) cancelAnimationFrame(textHighlightTargetOutlineRaf);
    textHighlightTargetOutlineRaf = 0;
    textHighlightTargetOutline?.remove();
    textHighlightTargetOutline = null;
  }

  function getTextHighlightTargetRects(range) {
    if (!range?.startContainer?.isConnected || !range?.endContainer?.isConnected) return [];
    const rects = getTextRangeClientRects(range, {
      excludeSelector: '#egov-ext-text-highlight-popup, #egov-ext-text-highlight-memo-tooltip, #egov-ext-text-highlight-target-outline',
    })
      .filter((rect) => rect.width > 0.5 && rect.height > 0.5 &&
        rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight)
      .map((rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }))
      .sort((first, second) => first.top - second.top || first.left - second.left);
    const merged = [];
    rects.forEach((rect) => {
      const previous = merged[merged.length - 1];
      const overlap = previous
        ? Math.min(previous.bottom, rect.bottom) - Math.max(previous.top, rect.top)
        : 0;
      const sameLine = previous && overlap >= Math.min(previous.bottom - previous.top, rect.bottom - rect.top) * 0.5;
      if (sameLine && rect.left <= previous.right + 4) {
        previous.left = Math.min(previous.left, rect.left);
        previous.top = Math.min(previous.top, rect.top);
        previous.right = Math.max(previous.right, rect.right);
        previous.bottom = Math.max(previous.bottom, rect.bottom);
      } else {
        merged.push({ ...rect });
      }
    });
    return merged;
  }

  function showTextHighlightTargetOutline(range = pendingTextHighlightRange) {
    hideTextHighlightTargetOutline();
    const rects = getTextHighlightTargetRects(range);
    if (!rects.length) return;
    const outline = document.createElement('div');
    outline.id = 'egov-ext-text-highlight-target-outline';
    outline.setAttribute('aria-hidden', 'true');
    outline.style.setProperty('display', 'block', 'important');
    rects.forEach((rect) => {
      const segment = document.createElement('div');
      segment.className = 'egov-ext-text-highlight-target-segment';
      segment.style.left = `${Math.max(0, rect.left - 2)}px`;
      segment.style.top = `${Math.max(0, rect.top - 2)}px`;
      segment.style.width = `${rect.right - rect.left + 4}px`;
      segment.style.height = `${rect.bottom - rect.top + 4}px`;
      outline.appendChild(segment);
    });
    document.body.appendChild(outline);
    textHighlightTargetOutline = outline;
  }

  function scheduleTextHighlightTargetOutline() {
    if (textHighlightTargetOutlineRaf) return;
    textHighlightTargetOutlineRaf = requestAnimationFrame(() => {
      textHighlightTargetOutlineRaf = 0;
      if (textHighlightPopup) showTextHighlightTargetOutline();
    });
  }

  function hideTextHighlightPopup({ force = false } = {}) {
    if (!force && isTextHighlightMemoEditing()) return false;
    if (textHighlightRangeButtonResetTimer) clearTimeout(textHighlightRangeButtonResetTimer);
    textHighlightRangeButtonResetTimer = 0;
    textHighlightRangeAdjusting = false;
    textHighlightPopup?.remove();
    textHighlightPopup = null;
    hideTextHighlightTargetOutline();
    pendingTextHighlightRange = null;
    pendingTextHighlightSource = null;
    if (textHighlightPendingStorageRecords) {
      const pendingRecords = textHighlightPendingStorageRecords;
      textHighlightPendingStorageRecords = null;
      setTimeout(() => syncTextHighlightRecordsFromStorage(pendingRecords), 0);
    }
    return true;
  }

  function hideTextHighlightMemoTooltip() {
    if (textHighlightMemoHideTimer) clearTimeout(textHighlightMemoHideTimer);
    textHighlightMemoHideTimer = 0;
    textHighlightMemoTooltip?.remove();
    textHighlightMemoTooltip = null;
    textHighlightMemoTooltipRecordId = '';
    textHighlightMemoTooltipSource = null;
  }

  function cancelTextHighlightMemoTooltipHide() {
    if (textHighlightMemoHideTimer) clearTimeout(textHighlightMemoHideTimer);
    textHighlightMemoHideTimer = 0;
  }

  function scheduleTextHighlightMemoTooltipHide(delay = 500) {
    if (textHighlightMemoHideTimer) return;
    textHighlightMemoHideTimer = setTimeout(() => {
      textHighlightMemoHideTimer = 0;
      hideTextHighlightMemoTooltip();
    }, delay);
  }

  function getRangeContainerElement(node) {
    return node instanceof Element ? node : node?.parentElement || null;
  }

  function isRangeInsideProvisionView(range) {
    const provisionRoot = document.querySelector('#provisionview');
    if (!provisionRoot || !range) return false;
    const startEl = getRangeContainerElement(range.startContainer);
    const endEl = getRangeContainerElement(range.endContainer);
    return !!startEl && !!endEl && provisionRoot.contains(startEl) && provisionRoot.contains(endEl);
  }

  function getTextHighlightStorageKey() {
    const lawId = getCurrentLawIdFromUrl();
    return lawId ? `${TEXT_HIGHLIGHT_STORAGE_PREFIX}${lawId}` : '';
  }

  function formatTextHighlightPortableKey(parts) {
    if (!parts?.article) return '';
    const provisionKey = buildJumpHistoryKey(parts);
    return parts.scope ? `${parts.scope}::${provisionKey}` : provisionKey;
  }

  function getTextHighlightPortableKeyFromElement(element) {
    if (!(element instanceof Element) || !element.id) return '';
    return formatTextHighlightPortableKey(parseProvisionHash(`#${element.id}`) || parseProvisionPath(element.id));
  }

  function getTextHighlightAnchor(range) {
    const provisionRoot = document.querySelector('#provisionview');
    const endEl = getRangeContainerElement(range?.endContainer);
    let el = getRangeContainerElement(range?.startContainer);
    while (el && el !== provisionRoot) {
      if (el.id && parseProvisionPath(el.id) && el.contains(endEl)) return el;
      el = el.parentElement;
    }
    return provisionRoot?.contains(endEl) ? provisionRoot : null;
  }

  function getTextHighlightProvisionAnchor(node) {
    const provisionRoot = document.querySelector('#provisionview');
    let element = getRangeContainerElement(node);
    let anchor = null;
    let anchorKey = '';
    while (element && element !== provisionRoot) {
      const key = getTextHighlightPortableKeyFromElement(element);
      if (key) {
        if (!anchorKey) anchorKey = key;
        if (key !== anchorKey) break;
        anchor = element;
      }
      element = element.parentElement;
    }
    return anchor;
  }

  function getTextHighlightPortableAnchor(node) {
    const provisionRoot = document.querySelector('#provisionview');
    let element = getRangeContainerElement(node);
    let paragraphAnchor = null;
    let paragraphKey = '';
    let articleAnchor = null;
    while (element && element !== provisionRoot) {
      const parts = element.id
        ? (parseProvisionHash(`#${element.id}`) || parseProvisionPath(element.id))
        : null;
      if (parts?.article && parts.paragraph && !parts.item) {
        const key = formatTextHighlightPortableKey(parts);
        if (!paragraphKey) paragraphKey = key;
        if (key === paragraphKey) paragraphAnchor = element;
      } else if (parts?.article && !parts.paragraph && !parts.item) {
        articleAnchor = element;
      }
      element = element.parentElement;
    }
    return paragraphAnchor || articleAnchor || getTextHighlightProvisionAnchor(node);
  }

  function getTextOffsetInAnchor(anchor, node, offset) {
    try {
      const range = document.createRange();
      range.selectNodeContents(anchor);
      range.setEnd(node, offset);
      return range.toString().length;
    } catch (_) {
      return -1;
    }
  }

  function getTextHighlightSearchOffset(anchor, node, offset) {
    const options = { excludeSelector: TEXT_HIGHLIGHT_PORTABLE_EXCLUDE_SELECTOR };
    try {
      const prefixRange = document.createRange();
      prefixRange.selectNodeContents(anchor);
      prefixRange.setEnd(node, offset);
      return getTextRangeText(prefixRange, options).replace(/\s+/g, '').length;
    } catch (_) {
      return -1;
    }
  }

  function getTextHighlightPortableText(range) {
    return getTextRangeText(range, {
      excludeSelector: TEXT_HIGHLIGHT_PORTABLE_EXCLUDE_SELECTOR,
    }).replace(/\s+/g, '');
  }

  function textHighlightPortableRangeMatchesRecord(range, record) {
    const selectedText = getTextHighlightPortableText(range);
    if (!selectedText || !record.q) return false;
    if (!record.z) return selectedText === record.q;
    return selectedText.startsWith(record.q) && selectedText.endsWith(record.z);
  }

  function updateTextHighlightPortableFields(record, range) {
    const startAnchor = getTextHighlightPortableAnchor(range.startContainer);
    const endAnchor = getTextHighlightPortableAnchor(range.endContainer);
    const portableStart = startAnchor ? getTextHighlightSearchOffset(startAnchor, range.startContainer, range.startOffset) : -1;
    const portableEnd = endAnchor ? getTextHighlightSearchOffset(endAnchor, range.endContainer, range.endOffset) : -1;
    if (!startAnchor || !endAnchor || portableStart < 0 || portableEnd <= 0) return false;
    const portableText = getTextHighlightPortableText(range);
    if (!portableText) return false;
    const fields = {
      u: getTextHighlightPortableKeyFromElement(startAnchor),
      v: getTextHighlightPortableKeyFromElement(endAnchor),
      x: portableStart,
      y: portableEnd,
      f: 2,
      l: portableText.length,
      q: portableText.slice(0, TEXT_HIGHLIGHT_QUOTE_HEAD_LENGTH),
      z: portableText.length > TEXT_HIGHLIGHT_QUOTE_HEAD_LENGTH
        ? portableText.slice(-TEXT_HIGHLIGHT_QUOTE_TAIL_LENGTH)
        : '',
      w: getNormalizedTextSignature(portableText),
    };
    if (!fields.u || !fields.v) return false;
    const changed = Object.entries(fields).some(([key, value]) => record[key] !== value);
    Object.assign(record, fields);
    return changed;
  }

  function createTextHighlightRecord(range, colorKey, recordId = '', memo = '') {
    const anchor = getTextHighlightAnchor(range);
    if (!anchor || !textHighlightRanges[colorKey]) return null;
    const start = getTextOffsetInAnchor(anchor, range.startContainer, range.startOffset);
    const end = getTextOffsetInAnchor(anchor, range.endContainer, range.endOffset);
    const selectedText = range.toString();
    if (start < 0 || end <= start || !selectedText) return null;

    const anchorText = anchor.textContent || '';
    const id = recordId || crypto.randomUUID?.() ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    const record = {
      id,
      c: colorKey,
      a: anchor.id,
      h: getTextHighlightPortableKeyFromElement(anchor),
      k: getProvisionJumpKeyFromNode(range.startContainer),
      s: start,
      e: end,
      l: selectedText.length,
      q: selectedText.slice(0, TEXT_HIGHLIGHT_QUOTE_HEAD_LENGTH),
      z: selectedText.length > TEXT_HIGHLIGHT_QUOTE_HEAD_LENGTH
        ? selectedText.slice(-TEXT_HIGHLIGHT_QUOTE_TAIL_LENGTH)
        : '',
      p: anchorText.slice(Math.max(0, start - TEXT_HIGHLIGHT_CONTEXT_LENGTH), start),
      n: anchorText.slice(end, end + TEXT_HIGHLIGHT_CONTEXT_LENGTH),
      m: String(memo || '').slice(0, TEXT_HIGHLIGHT_MEMO_MAX_LENGTH),
      t: Date.now(),
    };
    if (!updateTextHighlightPortableFields(record, range)) return null;
    return record;
  }

  function normalizeTextHighlightRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const colorKey = String(record.c || '');
    const id = String(record.id || '');
    const anchorId = String(record.a || '');
    const start = Number(record.s);
    const end = Number(record.e);
    const length = Number(record.l);
    if (!textHighlightRanges[colorKey] || !id || !anchorId ||
        !Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(length) ||
        start < 0 || end <= start || length <= 0) return null;
    const normalized = {
      id: id.slice(0, 80),
      c: colorKey,
      a: anchorId.slice(0, 500),
      h: String(record.h || '').slice(0, 120),
      k: String(record.k || '').slice(0, 100),
      s: start,
      e: end,
      l: length,
      q: String(record.q || '').slice(0, TEXT_HIGHLIGHT_QUOTE_HEAD_LENGTH),
      z: String(record.z || '').slice(-TEXT_HIGHLIGHT_QUOTE_TAIL_LENGTH),
      p: String(record.p || '').slice(-TEXT_HIGHLIGHT_CONTEXT_LENGTH),
      n: String(record.n || '').slice(0, TEXT_HIGHLIGHT_CONTEXT_LENGTH),
      m: String(record.m || '').slice(0, TEXT_HIGHLIGHT_MEMO_MAX_LENGTH),
      t: Number(record.t) || 0,
    };
    const portableStart = Number(record.x);
    const portableEnd = Number(record.y);
    if (record.f !== 2 || !record.u || !record.v ||
        !Number.isInteger(portableStart) || !Number.isInteger(portableEnd) ||
        portableStart < 0 || portableEnd <= 0) return null;
    normalized.u = String(record.u).slice(0, 120);
    normalized.v = String(record.v).slice(0, 120);
    normalized.x = portableStart;
    normalized.y = portableEnd;
    normalized.f = 2;
    normalized.w = String(record.w || '').slice(0, 32);
    return normalized;
  }

  async function loadTextHighlightRecords() {
    if (textHighlightRecordsLoaded) return;
    if (textHighlightLoadPromise) return textHighlightLoadPromise;
    textHighlightLoadPromise = (async () => {
      const storageKey = getTextHighlightStorageKey();
      if (!storageKey) return;
      const stored = await chrome.storage.local.get([storageKey]).catch(() => ({}));
      const records = Array.isArray(stored[storageKey]) ? stored[storageKey] : [];
      records.forEach((rawRecord) => {
        const record = normalizeTextHighlightRecord(rawRecord);
        if (record) textHighlightRecords.set(record.id, record);
      });
    })().finally(() => {
      textHighlightRecordsLoaded = true;
      textHighlightLoadPromise = null;
    });
    return textHighlightLoadPromise;
  }

  function getTextHighlightRecordSignature(record) {
    return record ? JSON.stringify([
      record.c, record.a, record.h, record.k, record.s, record.e, record.l,
      record.q, record.z, record.p, record.n, record.m, record.t,
      record.u, record.v, record.x, record.y, record.w,
      record.f,
    ]) : '';
  }

  function syncTextHighlightRecordsFromStorage(rawRecords) {
    if (isTextHighlightMemoDirty()) {
      textHighlightPendingStorageRecords = rawRecords;
      return;
    }
    const external = new Map();
    (Array.isArray(rawRecords) ? rawRecords : []).forEach((rawRecord) => {
      const record = normalizeTextHighlightRecord(rawRecord);
      if (record) external.set(record.id, record);
    });
    const changedIds = new Set();
    textHighlightRecords.forEach((record, id) => {
      if (textHighlightDirtyRecordIds.has(id) || textHighlightDeletedRecordIds.has(id)) return;
      if (getTextHighlightRecordSignature(record) !== getTextHighlightRecordSignature(external.get(id))) {
        changedIds.add(id);
      }
    });
    external.forEach((record, id) => {
      if (textHighlightDirtyRecordIds.has(id) || textHighlightDeletedRecordIds.has(id)) return;
      if (getTextHighlightRecordSignature(record) !== getTextHighlightRecordSignature(textHighlightRecords.get(id))) {
        changedIds.add(id);
      }
    });
    if (!changedIds.size) return;
    if (isTextHighlightMemoEditing()) hideTextHighlightPopup({ force: true });
    changedIds.forEach((id) => {
      const record = external.get(id);
      if (record) textHighlightRecords.set(id, record);
      else textHighlightRecords.delete(id);
    });
    Object.keys(textHighlightRanges).forEach((colorKey) => {
      textHighlightRanges[colorKey] = textHighlightRanges[colorKey].filter((range) => (
        !changedIds.has(textHighlightRangeRecordId.get(range))
      ));
      refreshTextHighlightColor(colorKey);
    });
    scheduleTextHighlightRestore(0);
  }

  async function persistTextHighlightRecordsNow() {
    if (textHighlightSaveTimer) clearTimeout(textHighlightSaveTimer);
    textHighlightSaveTimer = 0;
    await loadTextHighlightRecords();
    const storageKey = getTextHighlightStorageKey();
    if (!storageKey || (!textHighlightDirtyRecordIds.size && !textHighlightDeletedRecordIds.size)) return;
    const dirtySnapshot = new Map();
    textHighlightDirtyRecordIds.forEach((id) => {
      const record = textHighlightRecords.get(id);
      if (record) dirtySnapshot.set(id, record);
    });
    const deletedSnapshot = new Set(textHighlightDeletedRecordIds);
    const stored = await chrome.storage.local.get([storageKey]).catch(() => ({}));
    const merged = new Map();
    (Array.isArray(stored[storageKey]) ? stored[storageKey] : []).forEach((rawRecord) => {
      const record = normalizeTextHighlightRecord(rawRecord);
      if (record) merged.set(record.id, record);
    });
    deletedSnapshot.forEach((id) => merged.delete(id));
    dirtySnapshot.forEach((record, id) => merged.set(id, record));
    const records = Array.from(merged.values())
      .sort((first, second) => (second.t || 0) - (first.t || 0));
    let saved = false;
    try {
      if (records.length) await chrome.storage.local.set({ [storageKey]: records });
      else await chrome.storage.local.remove(storageKey);
      saved = true;
    } catch (_) {}
    if (!saved) return;
    dirtySnapshot.forEach((record, id) => {
      if (textHighlightRecords.get(id) === record) textHighlightDirtyRecordIds.delete(id);
    });
    deletedSnapshot.forEach((id) => textHighlightDeletedRecordIds.delete(id));
    new Map(records.map((record) => [record.id, record])).forEach((record, id) => {
      if (!textHighlightDirtyRecordIds.has(id) && !textHighlightDeletedRecordIds.has(id)) {
        textHighlightRecords.set(id, record);
      }
    });
  }

  function persistTextHighlightRecordsSoon() {
    if (textHighlightSaveTimer) clearTimeout(textHighlightSaveTimer);
    textHighlightSaveTimer = setTimeout(() => persistTextHighlightRecordsNow(), 180);
  }

  function getTextHighlightFallbackAnchorIndex(indexRef) {
    if (indexRef.value) return indexRef.value;
    const index = new Map();
    const canonicalElements = new Set();
    collectProvisionLinkTargets().forEach((el) => {
      const canonical = getTextHighlightProvisionAnchor(el);
      if (canonical) canonicalElements.add(canonical);
      const portable = getTextHighlightPortableAnchor(el);
      if (portable) canonicalElements.add(portable);
    });
    const addAnchor = (key, element) => {
      if (!key || !(element instanceof Element)) return;
      if (!index.has(key)) index.set(key, []);
      if (!index.get(key).includes(element)) index.get(key).push(element);
    };
    canonicalElements.forEach((el) => {
      const legacyKey = buildJumpHistoryKey(parseProvisionPath(el.id));
      const portableKey = getTextHighlightPortableKeyFromElement(el);
      [portableKey, legacyKey].forEach((key) => addAnchor(key, el));

      // Lite版では第1項の要素内に各号が入るが、通常版では第1項本文と各号が
      // 兄弟要素になる。第1項キーでも条文全体を候補にして、号をまたぐ範囲を復帰する。
      const parts = parseProvisionHash(`#${el.id}`) || parseProvisionPath(el.id);
      if (parts?.paragraph === '1' && !parts.item) {
        let article = el.parentElement;
        while (article && article !== document.querySelector('#provisionview')) {
          const articleParts = article.id
            ? (parseProvisionHash(`#${article.id}`) || parseProvisionPath(article.id))
            : null;
          if (articleParts?.article === parts.article && !articleParts.paragraph && !articleParts.item) {
            [portableKey, legacyKey].forEach((key) => addAnchor(key, article));
            break;
          }
          article = article.parentElement;
        }
      }
    });
    indexRef.value = index;
    return index;
  }

  function restoreTextHighlightPortableRange(record, anchorIndex) {
    if (!record.u || !record.v || !Number.isInteger(record.x) || !Number.isInteger(record.y)) return null;
    const startAnchors = anchorIndex.get(record.u) || [];
    const endAnchors = anchorIndex.get(record.v) || [];
    const options = {
      excludeSelector: TEXT_HIGHLIGHT_PORTABLE_EXCLUDE_SELECTOR,
    };
    for (const startAnchor of startAnchors) {
      for (const endAnchor of endAnchors) {
        const range = rangeFromNormalizedTextAnchorOffsets(
          startAnchor, record.x, endAnchor, record.y, options,
        );
        if (!range || !isRangeInsideProvisionView(range)) continue;
        if (!textHighlightPortableRangeMatchesRecord(range, record)) continue;
        return range;
      }
    }
    return null;
  }

  function restoreTextHighlightRecord(record, fallbackAnchorIndexRef = { value: null }) {
    const portableRange = restoreTextHighlightPortableRange(
      record,
      getTextHighlightFallbackAnchorIndex(fallbackAnchorIndexRef),
    );
    if (!portableRange) return false;
    const restoredRange = portableRange.cloneRange();
    textHighlightRangeSequence.set(restoredRange, ++textHighlightSequence);
    textHighlightRangeRecordId.set(restoredRange, record.id);
    textHighlightRanges[record.c].push(restoredRange);
    return true;
  }

  function textHighlightRangeMatchesRecord(range, record) {
    if (!range || !record || range.collapsed ||
        !range.startContainer?.isConnected || !range.endContainer?.isConnected) return false;
    return textHighlightPortableRangeMatchesRecord(range, record);
  }

  function getUnrestoredTextHighlightRecords() {
    const restoredIds = new Set();
    const displayIds = new Set(getTextHighlightDisplayRecords().map((record) => record.id));
    Object.values(textHighlightRanges).forEach((ranges) => {
      ranges.forEach((range) => {
        const id = textHighlightRangeRecordId.get(range);
        if (id && displayIds.has(id) && textHighlightRangeMatchesRecord(range, textHighlightRecords.get(id))) {
          restoredIds.add(id);
        }
      });
    });
    return Array.from(textHighlightRecords.values()).filter((record) => !restoredIds.has(record.id));
  }

  function getTextHighlightDisplayRecords() {
    return Array.from(textHighlightRecords.values())
      .sort((first, second) => (second.t || 0) - (first.t || 0))
      .slice(0, TEXT_HIGHLIGHT_DISPLAY_LIMIT);
  }

  function getTextHighlightDisplayLimitExceededCount() {
    return Math.max(0, textHighlightRecords.size - TEXT_HIGHLIGHT_DISPLAY_LIMIT);
  }

  function formatUnrestoredTextHighlightTarget(record, end = false) {
    const key = end ? (record.v || record.h) : (record.u || record.h || record.k);
    return key ? (getReferenceTargetLabel(key) || key) : '不明';
  }

  function buildUnrestoredTextHighlightReport(records) {
    const items = records.map((record) => [
      '【対象条文】',
      `開始位置：${formatUnrestoredTextHighlightTarget(record)}`,
      `終了位置：${formatUnrestoredTextHighlightTarget(record, true)}`,
      '',
      '【対象メモ】',
      String(record.m || '').trim() ? String(record.m || '') : 'なし',
      '---',
    ].join('\n'));
    return ['改正等により、描画できなかったハイライト/メモ', ...items].join('\n');
  }

  function downloadUnrestoredTextHighlightReport() {
    const records = getUnrestoredTextHighlightRecords();
    if (!records.length) {
      clearTextHighlightRestoreNotice();
      return;
    }
    const date = new Date();
    const stamp = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((value) => String(value).padStart(2, '0')).join('');
    const lawId = String(getCurrentLawIdFromUrl() || '').replace(/[^0-9A-Za-z_-]/g, '') || 'law';
    const blob = new Blob(['\uFEFF', buildUnrestoredTextHighlightReport(records)], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `描画できなかったハイライト・メモ_${lawId}_${stamp}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function deleteUnrestoredTextHighlights() {
    const records = getUnrestoredTextHighlightRecords();
    if (!records.length) {
      clearTextHighlightRestoreNotice();
      return;
    }
    if (!window.confirm('復元できなかったハイライト/メモを削除してよいですか？')) return;
    records.forEach((record) => {
      textHighlightRecords.delete(record.id);
      textHighlightDirtyRecordIds.delete(record.id);
      textHighlightDeletedRecordIds.add(record.id);
    });
    Object.keys(textHighlightRanges).forEach((colorKey) => {
      textHighlightRanges[colorKey] = textHighlightRanges[colorKey].filter((range) => (
        !textHighlightDeletedRecordIds.has(textHighlightRangeRecordId.get(range))
      ));
      refreshTextHighlightColor(colorKey);
    });
    persistTextHighlightRecordsSoon();
    clearTextHighlightRestoreNotice();
  }

  function ignoreTextHighlightRestoreNotice() {
    textHighlightRestoreNoticeIgnored = true;
    clearTextHighlightRestoreNotice();
  }

  function renderTextHighlightRestoreNotice() {
    const records = getUnrestoredTextHighlightRecords();
    const signature = records.map((record) => record.id).sort().join('\n');
    if (signature !== textHighlightUnrestoredSignature) {
      scheduleTextHighlightRestoreNotice(records);
      return;
    }
    let notice = document.querySelector('#egov-ext-text-highlight-restore-notice');
    if (!records.length) {
      notice?.remove();
      return;
    }
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'egov-ext-text-highlight-restore-notice';
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      const message = document.createElement('span');
      message.className = 'egov-ext-text-highlight-restore-message';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'テキスト保存';
      button.addEventListener('click', downloadUnrestoredTextHighlightReport);
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'egov-ext-text-highlight-restore-delete';
      deleteButton.textContent = '削除';
      deleteButton.addEventListener('click', deleteUnrestoredTextHighlights);
      const ignoreButton = document.createElement('button');
      ignoreButton.type = 'button';
      ignoreButton.textContent = '無視';
      ignoreButton.addEventListener('click', ignoreTextHighlightRestoreNotice);
      const actions = document.createElement('div');
      actions.className = 'egov-ext-text-highlight-restore-actions';
      actions.append(button, deleteButton, ignoreButton);
      notice.append(message, actions);
      document.body.appendChild(notice);
    }
    const message = notice.querySelector('.egov-ext-text-highlight-restore-message');
    if (message) {
      const limitExceededCount = getTextHighlightDisplayLimitExceededCount();
      message.textContent = limitExceededCount
        ? `表示できなかったハイライト/メモが${records.length}件あります（うち${limitExceededCount}件は表示上限1,000件を超えています）。`
        : `復元できなかったハイライト/メモが${records.length}件あります。`;
    }
  }

  function clearTextHighlightRestoreNotice() {
    if (textHighlightRestoreNoticeTimer) clearTimeout(textHighlightRestoreNoticeTimer);
    textHighlightRestoreNoticeTimer = 0;
    textHighlightUnrestoredRecords = [];
    textHighlightUnrestoredSignature = '';
    textHighlightUnrestoredStablePasses = 0;
    document.querySelector('#egov-ext-text-highlight-restore-notice')?.remove();
  }

  function scheduleTextHighlightRestoreNotice(records, delay = 1500) {
    if (textHighlightRestoreNoticeIgnored) {
      clearTextHighlightRestoreNotice();
      return;
    }
    textHighlightUnrestoredRecords = Array.from(records || []);
    const signature = textHighlightUnrestoredRecords.map((record) => record.id).sort().join('\n');
    if (textHighlightRestoreNoticeTimer) clearTimeout(textHighlightRestoreNoticeTimer);
    const notice = document.querySelector('#egov-ext-text-highlight-restore-notice');
    if (!signature && !notice) {
      textHighlightRestoreNoticeTimer = 0;
      textHighlightUnrestoredSignature = '';
      textHighlightUnrestoredStablePasses = 0;
      return;
    }
    if (signature === textHighlightUnrestoredSignature) {
      textHighlightUnrestoredStablePasses += 1;
    } else {
      textHighlightUnrestoredSignature = signature;
      textHighlightUnrestoredStablePasses = 1;
    }
    if (textHighlightUnrestoredStablePasses < 3) {
      textHighlightRestoreNoticeTimer = setTimeout(() => {
        textHighlightRestoreNoticeTimer = 0;
        restoreTextHighlights().catch(() => {});
      }, 550);
      return;
    }
    textHighlightRestoreNoticeTimer = setTimeout(() => {
      textHighlightRestoreNoticeTimer = 0;
      if (signature) renderTextHighlightRestoreNotice();
      else clearTextHighlightRestoreNotice();
    }, delay);
  }

  async function restoreTextHighlights() {
    if (!textHighlightFeatureEnabled) return;
    await loadTextHighlightRecords();
    if (!document.querySelector('#provisionview') || !textHighlightRecords.size) {
      scheduleTextHighlightRestoreNotice([]);
      return;
    }

    const connectedRecordIds = new Set();
    const displayRecords = getTextHighlightDisplayRecords();
    const displayRecordIds = new Set(displayRecords.map((record) => record.id));
    Object.values(textHighlightRanges).forEach((ranges) => {
      ranges.forEach((range) => {
        const recordId = textHighlightRangeRecordId.get(range);
        if (recordId && displayRecordIds.has(recordId) &&
            textHighlightRangeMatchesRecord(range, textHighlightRecords.get(recordId))) {
          connectedRecordIds.add(recordId);
        }
      });
    });
    Object.keys(textHighlightRanges).forEach((colorKey) => {
      textHighlightRanges[colorKey] = textHighlightRanges[colorKey].filter((range) => (
        displayRecordIds.has(textHighlightRangeRecordId.get(range))
      ));
    });

    let restoredCount = 0;
    const fallbackAnchorIndexRef = { value: null };
    for (const record of displayRecords) {
      if (connectedRecordIds.has(record.id)) continue;
      if (restoreTextHighlightRecord(record, fallbackAnchorIndexRef)) {
        connectedRecordIds.add(record.id);
        restoredCount += 1;
      }
      if (restoredCount > 0 && restoredCount % 25 === 0) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
    Object.keys(textHighlightRanges).forEach(refreshTextHighlightColor);
    scheduleTextHighlightRestoreNotice(
      Array.from(textHighlightRecords.values()).filter((record) => !connectedRecordIds.has(record.id)),
    );
  }

  function scheduleTextHighlightRestore(delay = 220) {
    if (!textHighlightFeatureEnabled) return;
    if (textHighlightRestoreTimer) clearTimeout(textHighlightRestoreTimer);
    textHighlightRestoreTimer = setTimeout(() => {
      textHighlightRestoreTimer = 0;
      restoreTextHighlights().catch(() => {});
    }, delay);
  }

  function discardInvalidTextHighlightRanges() {
    let discarded = false;
    Object.keys(textHighlightRanges).forEach((colorKey) => {
      textHighlightRanges[colorKey] = textHighlightRanges[colorKey].filter((range) => {
        if (!range.startContainer?.isConnected || !range.endContainer?.isConnected || range.collapsed) {
          discarded = true;
          return false;
        }
        const record = textHighlightRecords.get(textHighlightRangeRecordId.get(range));
        if (!record) return true;
        const valid = textHighlightRangeMatchesRecord(range, record);
        if (!valid) discarded = true;
        return valid;
      });
    });
    return discarded;
  }

  function observeTextHighlightDomChanges() {
    const root = document.querySelector('#provisionview') || document.documentElement;
    let validationTimer = 0;
    const observer = new MutationObserver(() => {
      textHighlightHitTestCache = null;
      if (textHighlightPopup) scheduleTextHighlightTargetOutline();
      if (!textHighlightRecords.size) return;
      if (validationTimer) clearTimeout(validationTimer);
      validationTimer = setTimeout(() => {
        validationTimer = 0;
        if (discardInvalidTextHighlightRanges()) scheduleTextHighlightRestore(80);
      }, 80);
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  function refreshTextHighlightColor(colorKey) {
    if (!CSS.highlights || typeof Highlight !== 'function') return;
    textHighlightHitTestCache = null;
    textHighlightRanges[colorKey] = textHighlightRanges[colorKey]
      .filter((range) => range.startContainer?.isConnected && range.endContainer?.isConnected);
    CSS.highlights.set(
      `egov-ext-text-highlight-${colorKey}`,
      new Highlight(...textHighlightRanges[colorKey])
    );
  }

  function applyPendingTextHighlight(colorKey) {
    const range = pendingTextHighlightRange;
    if (!range || !isRangeInsideProvisionView(range) || !textHighlightRanges[colorKey]) {
      hideTextHighlightPopup();
      return;
    }
    if (findOverlappingTextHighlightRange(range, pendingTextHighlightSource?.range || null)) {
      showTextHighlightOverlapNotice();
      flashTextHighlightRangeButton('重複不可');
      return;
    }

    const sourceRecordId = pendingTextHighlightSource
      ? textHighlightRangeRecordId.get(pendingTextHighlightSource.range) || ''
      : '';
    const memo = textHighlightPopup?.querySelector('.egov-ext-text-highlight-memo-input')?.value || '';
    if (pendingTextHighlightSource) {
      const { colorKey: sourceColor, range: sourceRange } = pendingTextHighlightSource;
      textHighlightRanges[sourceColor] = textHighlightRanges[sourceColor]
        .filter((highlightRange) => highlightRange !== sourceRange);
      refreshTextHighlightColor(sourceColor);
    }

    const nextRange = range.cloneRange();
    const record = createTextHighlightRecord(nextRange, colorKey, sourceRecordId, memo);
    if (!record) {
      updateTextHighlightMemoDirtyState();
      scheduleTextHighlightRestore(0);
      textHighlightPopup?.querySelector('textarea')?.focus();
      return;
    }
    textHighlightRangeSequence.set(nextRange, ++textHighlightSequence);
    if (sourceRecordId) textHighlightRecords.delete(sourceRecordId);
    textHighlightRecords.set(record.id, record);
    textHighlightRangeRecordId.set(nextRange, record.id);
    textHighlightDirtyRecordIds.add(record.id);
    textHighlightDeletedRecordIds.delete(record.id);
    textHighlightRanges[colorKey].push(nextRange);
    refreshTextHighlightColor(colorKey);
    persistTextHighlightRecordsSoon();
    hideTextHighlightPopup({ force: true });
    window.getSelection()?.removeAllRanges();
  }

  function textHighlightRangesOverlap(first, second) {
    try {
      return first.compareBoundaryPoints(Range.START_TO_END, second) > 0 &&
        first.compareBoundaryPoints(Range.END_TO_START, second) < 0;
    } catch (_) {
      return false;
    }
  }

  function findOverlappingTextHighlightRange(range, excludedRange = null) {
    return Object.values(textHighlightRanges).flat().find((highlightRange) => (
      highlightRange !== excludedRange && textHighlightRangesOverlap(highlightRange, range)
    )) || null;
  }

  function showTextHighlightOverlapNotice(clientX = null, clientY = null) {
    if (textHighlightOverlapNoticeTimer) clearTimeout(textHighlightOverlapNoticeTimer);
    document.querySelector('#egov-ext-text-highlight-overlap-notice')?.remove();
    const notice = document.createElement('div');
    notice.id = 'egov-ext-text-highlight-overlap-notice';
    notice.setAttribute('role', 'status');
    notice.textContent = '既存のハイライトと重なる範囲にハイライトを設定することはできません';
    document.body.appendChild(notice);
    const anchorRect = textHighlightPopup?.getBoundingClientRect();
    const left = Number.isFinite(clientX) ? clientX : anchorRect?.left;
    const top = Number.isFinite(clientY) ? clientY : anchorRect?.bottom;
    notice.style.left = `${Math.max(8, Math.min(Number(left) || 8, window.innerWidth - notice.offsetWidth - 8))}px`;
    notice.style.top = `${Math.max(8, Math.min((Number(top) || 8) + 10, window.innerHeight - notice.offsetHeight - 8))}px`;
    textHighlightOverlapNoticeTimer = setTimeout(() => {
      textHighlightOverlapNoticeTimer = 0;
      notice.remove();
    }, 2200);
  }

  function updateTextHighlightRangeButton(label = '') {
    const button = textHighlightPopup?.querySelector('[data-highlight-range]');
    if (!button) return;
    button.textContent = label || (textHighlightRangeAdjusting ? '選択中…' : '範囲');
    button.setAttribute('aria-pressed', String(textHighlightRangeAdjusting));
  }

  function flashTextHighlightRangeButton(label) {
    if (textHighlightRangeButtonResetTimer) clearTimeout(textHighlightRangeButtonResetTimer);
    updateTextHighlightRangeButton(label);
    textHighlightRangeButtonResetTimer = setTimeout(() => {
      textHighlightRangeButtonResetTimer = 0;
      updateTextHighlightRangeButton();
    }, 1400);
  }

  function toggleTextHighlightRangeAdjustment() {
    textHighlightRangeAdjusting = !textHighlightRangeAdjusting;
    updateTextHighlightRangeButton();
    if (textHighlightRangeAdjusting) window.getSelection()?.removeAllRanges();
  }

  function applyAdjustedTextHighlightRange(range, clientX, clientY) {
    if (!range || !isRangeInsideProvisionView(range) || range.collapsed || !range.toString().trim()) {
      flashTextHighlightRangeButton('範囲を選択');
      return false;
    }
    if (findOverlappingTextHighlightRange(range, pendingTextHighlightSource?.range || null)) {
      showTextHighlightOverlapNotice(clientX, clientY);
      flashTextHighlightRangeButton('重複不可');
      return false;
    }
    const source = pendingTextHighlightSource;
    const sourceRecordId = source ? textHighlightRangeRecordId.get(source.range) || '' : '';
    const sourceRecord = sourceRecordId ? textHighlightRecords.get(sourceRecordId) : null;
    if (!source || !sourceRecordId || !sourceRecord) {
      flashTextHighlightRangeButton('変更失敗');
      return false;
    }
    const nextRange = range.cloneRange();
    const nextRecord = createTextHighlightRecord(
      nextRange,
      source.colorKey,
      sourceRecordId,
      sourceRecord.m,
    );
    if (!nextRecord) {
      flashTextHighlightRangeButton('変更失敗');
      return false;
    }
    textHighlightRanges[source.colorKey] = textHighlightRanges[source.colorKey]
      .filter((highlightRange) => highlightRange !== source.range);
    textHighlightRangeSequence.set(nextRange, ++textHighlightSequence);
    textHighlightRangeRecordId.set(nextRange, sourceRecordId);
    textHighlightRecords.set(sourceRecordId, nextRecord);
    textHighlightDirtyRecordIds.add(sourceRecordId);
    textHighlightDeletedRecordIds.delete(sourceRecordId);
    textHighlightRanges[source.colorKey].push(nextRange);
    refreshTextHighlightColor(source.colorKey);
    persistTextHighlightRecordsSoon();
    pendingTextHighlightRange = nextRange.cloneRange();
    pendingTextHighlightSource = { colorKey: source.colorKey, range: nextRange };
    showTextHighlightTargetOutline(pendingTextHighlightRange);
    textHighlightRangeAdjusting = false;
    flashTextHighlightRangeButton('変更済み');
    window.getSelection()?.removeAllRanges();
    return true;
  }

  function removePendingTextHighlights() {
    const range = pendingTextHighlightRange;
    if (!range || !isRangeInsideProvisionView(range)) {
      hideTextHighlightPopup({ force: true });
      return;
    }

    const rangesToRemove = pendingTextHighlightSource
      ? [pendingTextHighlightSource.range]
      : Object.values(textHighlightRanges).flat().filter((highlightRange) => (
        textHighlightRangesOverlap(highlightRange, range)
      ));
    const removesMemo = rangesToRemove.some((highlightRange) => {
      const record = textHighlightRecords.get(textHighlightRangeRecordId.get(highlightRange));
      return !!record?.m;
    });
    if (removesMemo && !window.confirm('ハイライトとともにメモも削除されますが良いですか？')) return;

    if (pendingTextHighlightSource) {
      const { colorKey, range: sourceRange } = pendingTextHighlightSource;
      const recordId = textHighlightRangeRecordId.get(sourceRange);
      if (recordId) {
        textHighlightRecords.delete(recordId);
        textHighlightDirtyRecordIds.delete(recordId);
        textHighlightDeletedRecordIds.add(recordId);
      }
      textHighlightRanges[colorKey] = textHighlightRanges[colorKey]
        .filter((highlightRange) => highlightRange !== sourceRange);
      refreshTextHighlightColor(colorKey);
    } else {
      Object.keys(textHighlightRanges).forEach((colorKey) => {
        textHighlightRanges[colorKey] = textHighlightRanges[colorKey].filter((highlightRange) => {
          if (!textHighlightRangesOverlap(highlightRange, range)) return true;
          const recordId = textHighlightRangeRecordId.get(highlightRange);
          if (recordId) {
            textHighlightRecords.delete(recordId);
            textHighlightDirtyRecordIds.delete(recordId);
            textHighlightDeletedRecordIds.add(recordId);
          }
          return false;
        });
        refreshTextHighlightColor(colorKey);
      });
    }
    persistTextHighlightRecordsSoon();
    scheduleTextHighlightRestoreNotice(getUnrestoredTextHighlightRecords(), 0);
    hideTextHighlightPopup({ force: true });
    window.getSelection()?.removeAllRanges();
  }

  function positionTextHighlightPopup(popup, clientX, clientY) {
    const gap = 10;
    const viewportPadding = 8;
    const rect = popup.getBoundingClientRect();
    let left = clientX + gap;
    let top = clientY + gap;

    if (left + rect.width > window.innerWidth - viewportPadding) {
      left = clientX - rect.width - gap;
    }
    if (top + rect.height > window.innerHeight - viewportPadding) {
      top = clientY - rect.height - gap;
    }

    popup.style.left = `${Math.max(viewportPadding, left)}px`;
    popup.style.top = `${Math.max(viewportPadding, top)}px`;
    popup.classList.toggle('memo-above', clientY > window.innerHeight / 2);
    popup.classList.toggle('memo-align-right', left + 550 > window.innerWidth - viewportPadding);
  }

  function getTextHighlightHitTestEntries() {
    if (textHighlightHitTestCache) return textHighlightHitTestCache;
    const entries = [];
    Object.entries(textHighlightRanges).forEach(([colorKey, ranges]) => {
      ranges.forEach((range) => {
        if (!range.startContainer?.isConnected || !range.endContainer?.isConnected) return;
        entries.push({
          colorKey,
          range,
          rects: Array.from(range.getClientRects()),
          sequence: textHighlightRangeSequence.get(range) || 0,
        });
      });
    });
    textHighlightHitTestCache = entries;
    return entries;
  }

  function findTextHighlightAtPoint(clientX, clientY) {
    const caret = document.caretPositionFromPoint?.(clientX, clientY);
    const fallbackRange = !caret ? document.caretRangeFromPoint?.(clientX, clientY) : null;
    const node = caret?.offsetNode || fallbackRange?.startContainer;
    const offset = caret?.offset ?? fallbackRange?.startOffset;
    if (!node || !Number.isInteger(offset)) return null;

    const matches = [];
    getTextHighlightHitTestEntries().forEach((entry) => {
        const isVisuallyInside = entry.rects.some((rect) => (
          clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
        ));
        if (!isVisuallyInside) return;
        try {
          if (entry.range.comparePoint(node, offset) === 0) {
            matches.push(entry);
          }
        } catch (_) {
          // The caret and range can briefly belong to different DOM trees during a page update.
        }
    });
    matches.sort((first, second) => second.sequence - first.sequence);
    return matches[0] || null;
  }

  function positionTextHighlightMemoTooltip(tooltip, clientX, clientY) {
    const gap = 12;
    const padding = 8;
    const rect = tooltip.getBoundingClientRect();
    let left = clientX + gap;
    let top = clientY + gap;
    if (left + rect.width > window.innerWidth - padding) left = clientX - rect.width - gap;
    if (top + rect.height > window.innerHeight - padding) top = clientY - rect.height - gap;
    tooltip.style.left = `${Math.max(padding, left)}px`;
    tooltip.style.top = `${Math.max(padding, top)}px`;
  }

  function showTextHighlightMemoTooltip(record, source, clientX, clientY) {
    if (!record?.m || textHighlightPopup) {
      hideTextHighlightMemoTooltip();
      return;
    }
    cancelTextHighlightMemoTooltipHide();
    if (textHighlightMemoTooltip && textHighlightMemoTooltipRecordId === record.id) return;
    if (!textHighlightMemoTooltip || textHighlightMemoTooltipRecordId !== record.id) {
      hideTextHighlightMemoTooltip();
      const tooltip = document.createElement('div');
      tooltip.id = 'egov-ext-text-highlight-memo-tooltip';
      tooltip.className = `is-${source.colorKey}`;
      tooltip.setAttribute('role', 'tooltip');
      tooltip.textContent = record.m;
      tooltip.addEventListener('pointerenter', cancelTextHighlightMemoTooltipHide);
      tooltip.addEventListener('pointerleave', () => scheduleTextHighlightMemoTooltipHide(500));
      tooltip.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const activeSource = textHighlightMemoTooltipSource;
        if (!activeSource?.range?.startContainer?.isConnected) return;
        showTextHighlightPopup(activeSource.range, event.clientX, event.clientY, activeSource);
      });
      document.body.appendChild(tooltip);
      textHighlightMemoTooltip = tooltip;
      textHighlightMemoTooltipRecordId = record.id;
      textHighlightMemoTooltipSource = source;
    }
    positionTextHighlightMemoTooltip(textHighlightMemoTooltip, clientX, clientY);
  }

  function showTextHighlightMemoEditor({ focus = false } = {}) {
    if (!textHighlightPopup) return;
    const editor = textHighlightPopup.querySelector('.egov-ext-text-highlight-memo-editor');
    const button = textHighlightPopup.querySelector('[data-highlight-memo]');
    if (!editor) return;
    const textarea = editor.querySelector('textarea');
    if (!editor.classList.contains('is-visible') && textarea) {
      textarea.dataset.initialValue = textarea.value;
    }
    editor.classList.add('is-visible');
    button?.setAttribute('aria-expanded', 'true');
    updateTextHighlightMemoDirtyState();
    if (focus) {
      textarea?.focus();
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  }

  function cancelTextHighlightMemoEdit({ focusButton = true } = {}) {
    if (!textHighlightPopup) return true;
    const editor = textHighlightPopup.querySelector('.egov-ext-text-highlight-memo-editor.is-visible');
    const textarea = editor?.querySelector('textarea');
    if (!editor || !textarea) return true;
    const initialValue = textarea.dataset.initialValue || '';
    if (isTextHighlightMemoDirty() && !window.confirm('メモを保存せずに閉じていいですか？')) {
      textarea.focus();
      return false;
    }
    textarea.value = initialValue;
    updateTextHighlightMemoDirtyState();
    editor.classList.remove('is-visible');
    textHighlightPopup.querySelector('[data-highlight-memo]')?.setAttribute('aria-expanded', 'false');
    if (focusButton) textHighlightPopup.querySelector('[data-highlight-memo]')?.focus();
    return true;
  }

  function showTextHighlightPopup(range, clientX, clientY, source = null) {
    if (isTextHighlightMemoEditing()) return;
    hideTextHighlightPopup({ force: true });
    hideTextHighlightMemoTooltip();
    pendingTextHighlightRange = range.cloneRange();
    pendingTextHighlightSource = source;
    showTextHighlightTargetOutline(pendingTextHighlightRange);
    const sourceRecord = source
      ? textHighlightRecords.get(textHighlightRangeRecordId.get(source.range))
      : null;

    const popup = document.createElement('div');
    popup.id = 'egov-ext-text-highlight-popup';
    popup.setAttribute('role', 'toolbar');
    popup.setAttribute('aria-label', 'ハイライトの編集');
    popup.innerHTML = TEXT_HIGHLIGHT_COLORS.map(({ key, label }) => (
      `<button type="button" class="egov-ext-text-highlight-swatch is-${key}` +
      `${source?.colorKey === key ? ' is-active' : ''}" data-highlight-color="${key}" ` +
      `aria-label="${label}" aria-pressed="${source?.colorKey === key}" title="${label}"></button>`
    )).join('') +
      '<span class="egov-ext-text-highlight-divider" aria-hidden="true"></span>' +
      (source ? '<button type="button" class="egov-ext-text-highlight-range-button" ' +
      'data-highlight-range aria-label="ハイライト範囲を変更" aria-pressed="false" title="ハイライト範囲を選び直す">範囲</button>' : '') +
      '<button type="button" class="egov-ext-text-highlight-memo-button" ' +
      'data-highlight-memo aria-label="メモを追加・編集" aria-expanded="false" title="メモを追加・編集">メモ</button>' +
      '<button type="button" class="egov-ext-text-highlight-remove" ' +
      'data-highlight-remove aria-label="ハイライトを消す" title="ハイライトを消す">×</button>' +
      '<div class="egov-ext-text-highlight-memo-editor">' +
      `<textarea class="egov-ext-text-highlight-memo-input" rows="6" maxlength="${TEXT_HIGHLIGHT_MEMO_MAX_LENGTH}" ` +
      'aria-label="ハイライトのメモ" placeholder="メモを入力…"></textarea>' +
      '<div class="egov-ext-text-highlight-memo-footer">' +
      '<div class="egov-ext-text-highlight-memo-status" aria-live="polite"></div>' +
      '<div class="egov-ext-text-highlight-memo-hint">色選択・Ctrl+Enterで確定/「メモ」かESCでキャンセル</div></div></div>';

    const memoInput = popup.querySelector('.egov-ext-text-highlight-memo-input');
    if (memoInput) memoInput.value = sourceRecord?.m || '';

    popup.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('textarea')) event.preventDefault();
    });
    popup.addEventListener('click', (event) => {
      const rangeButton = event.target.closest('[data-highlight-range]');
      if (rangeButton instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        toggleTextHighlightRangeAdjustment();
        return;
      }
      const memoButton = event.target.closest('[data-highlight-memo]');
      if (memoButton instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        if (isTextHighlightMemoEditing()) cancelTextHighlightMemoEdit();
        else showTextHighlightMemoEditor({ focus: true });
        return;
      }
      const removeButton = event.target.closest('[data-highlight-remove]');
      if (removeButton instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        removePendingTextHighlights();
        return;
      }
      const button = event.target.closest('[data-highlight-color]');
      if (!(button instanceof HTMLElement)) return;
      event.preventDefault();
      event.stopPropagation();
      applyPendingTextHighlight(button.dataset.highlightColor || '');
    });

    document.body.appendChild(popup);
    textHighlightPopup = popup;
    memoInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        const selectedColorButton = popup.querySelector('[data-highlight-color].is-active') ||
          popup.querySelector('[data-highlight-color]');
        applyPendingTextHighlight(selectedColorButton?.dataset.highlightColor || TEXT_HIGHLIGHT_COLORS[0].key);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelTextHighlightMemoEdit();
      }
    });
    memoInput?.addEventListener('input', updateTextHighlightMemoDirtyState);
    memoInput?.addEventListener('focusout', () => {
      setTimeout(() => {
        // Losing focus because the browser window/tab itself became inactive
        // must not close the memo editor. Only an in-page focus move may close
        // an unchanged editor.
        if (!document.hasFocus()) return;
        if (!isTextHighlightMemoEditing() || isTextHighlightMemoDirty()) return;
        cancelTextHighlightMemoEdit({ focusButton: false });
      }, 0);
    });
    positionTextHighlightPopup(popup, clientX, clientY);
    if (sourceRecord?.m) showTextHighlightMemoEditor({ focus: true });
  }

  function setupTextHighlightInteractions() {
    if (!CSS.highlights || typeof Highlight !== 'function') return;

    const longPressDelay = 550;
    const moveTolerance = 8;
    let longPressTimer = 0;
    let longPressStart = null;
    let suppressLongPressClick = null;
    let ignoreSelectionPopupUntil = 0;
    let memoHoverRaf = 0;
    let memoHoverTimer = 0;
    let pendingMemoRecordId = '';
    let memoHoverPoint = null;

    function clearTextHighlightMemoHover({ immediate = false } = {}) {
      if (memoHoverTimer) clearTimeout(memoHoverTimer);
      memoHoverTimer = 0;
      pendingMemoRecordId = '';
      if (immediate) hideTextHighlightMemoTooltip();
      else scheduleTextHighlightMemoTooltipHide(500);
    }

    function scheduleTextHighlightMemoHover(event) {
      if (event.pointerType === 'touch') return;
      memoHoverPoint = { clientX: event.clientX, clientY: event.clientY, target: event.target };
      if (memoHoverRaf) return;
      memoHoverRaf = requestAnimationFrame(() => {
        memoHoverRaf = 0;
        const point = memoHoverPoint;
        const provisionRoot = document.querySelector('#provisionview');
        if (point?.target?.closest?.('#egov-ext-text-highlight-memo-tooltip')) {
          cancelTextHighlightMemoTooltipHide();
          return;
        }
        if (!point || textHighlightPopup || !provisionRoot?.contains(point.target)) {
          clearTextHighlightMemoHover();
          return;
        }
        const source = findTextHighlightAtPoint(point.clientX, point.clientY);
        const record = source
          ? textHighlightRecords.get(textHighlightRangeRecordId.get(source.range))
          : null;
        if (!record?.m) {
          clearTextHighlightMemoHover();
          return;
        }
        if (textHighlightMemoTooltipRecordId === record.id) {
          cancelTextHighlightMemoTooltipHide();
          return;
        }
        if (pendingMemoRecordId === record.id) return;
        if (memoHoverTimer) clearTimeout(memoHoverTimer);
        pendingMemoRecordId = record.id;
        memoHoverTimer = setTimeout(() => {
          memoHoverTimer = 0;
          pendingMemoRecordId = '';
          if (!memoHoverPoint || textHighlightPopup) return;
          const currentSource = findTextHighlightAtPoint(memoHoverPoint.clientX, memoHoverPoint.clientY);
          const currentRecord = currentSource
            ? textHighlightRecords.get(textHighlightRangeRecordId.get(currentSource.range))
            : null;
          if (currentRecord?.id === record.id) {
            showTextHighlightMemoTooltip(record, currentSource, memoHoverPoint.clientX, memoHoverPoint.clientY);
          }
        }, 220);
      });
    }

    function clearTextHighlightLongPressTimer() {
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = 0;
      longPressStart = null;
    }

    function matchesLongPressTarget(target, pressedTarget) {
      if (!(target instanceof Node) || !(pressedTarget instanceof Node)) return false;
      return target === pressedTarget ||
        (target instanceof Element && target.contains(pressedTarget)) ||
        (pressedTarget instanceof Element && pressedTarget.contains(target));
    }

    function isTextHighlightPriorityClickTarget(target) {
      const element = target instanceof Element ? target : target?.parentElement;
      return !!element?.closest(
        'a[href], .egov-ext-defined-term[data-term], .egov-ext-reference-clickable'
      );
    }

    document.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.isPrimary === false ||
          event.target.closest?.('#egov-ext-text-highlight-popup, #egov-ext-text-highlight-memo-tooltip')) return;
      if (isTextHighlightMemoEditing()) return;
      clearTextHighlightMemoHover({ immediate: true });
      const provisionRoot = document.querySelector('#provisionview');
      if (!provisionRoot?.contains(event.target)) return;
      const source = findTextHighlightAtPoint(event.clientX, event.clientY);
      if (!source) return;

      clearTextHighlightLongPressTimer();
      longPressStart = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        target: event.target,
        source,
      };
      longPressTimer = setTimeout(() => {
        if (!longPressStart) return;
        const pressed = longPressStart;
        longPressTimer = 0;
        ignoreSelectionPopupUntil = performance.now() + 1200;
        suppressLongPressClick = { target: pressed.target, expiresAt: performance.now() + 1200 };
        window.getSelection()?.removeAllRanges();
        hideLawReferencePreview();
        hideDefinitionTooltip(true);
        hideReferencesPopup();
        showTextHighlightPopup(pressed.source.range, pressed.clientX, pressed.clientY, pressed.source);
        longPressStart = null;
      }, longPressDelay);
    }, true);

    document.addEventListener('pointermove', (event) => {
      if (longPressStart && event.pointerId === longPressStart.pointerId &&
          Math.hypot(event.clientX - longPressStart.clientX, event.clientY - longPressStart.clientY) > moveTolerance) {
        clearTextHighlightLongPressTimer();
      }
      scheduleTextHighlightMemoHover(event);
    }, true);
    document.addEventListener('pointerup', clearTextHighlightLongPressTimer, true);
    document.addEventListener('pointercancel', clearTextHighlightLongPressTimer, true);

    document.addEventListener('click', (event) => {
      if (textHighlightRangeAdjusting && !event.target.closest?.('#egov-ext-text-highlight-popup')) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      if (suppressLongPressClick) {
        if (performance.now() > suppressLongPressClick.expiresAt) {
          suppressLongPressClick = null;
        } else if (matchesLongPressTarget(event.target, suppressLongPressClick.target)) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          suppressLongPressClick = null;
          return;
        }
      }
      if (isTextHighlightMemoEditing() && !event.target.closest?.('#egov-ext-text-highlight-popup')) {
        if (isTextHighlightMemoDirty()) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          textHighlightPopup?.querySelector('textarea')?.focus();
          return;
        }
        cancelTextHighlightMemoEdit({ focusButton: false });
        hideTextHighlightPopup();
      }
    }, true);

    document.addEventListener('contextmenu', (event) => {
      if (!suppressLongPressClick || performance.now() > suppressLongPressClick.expiresAt) return;
      if (!matchesLongPressTarget(event.target, suppressLongPressClick.target)) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);

    document.addEventListener('mouseup', (event) => {
      if (event.button !== 0 ||
          event.target.closest?.('#egov-ext-text-highlight-popup, #egov-ext-text-highlight-memo-tooltip')) return;
      if (!textHighlightRangeAdjusting && isTextHighlightMemoEditing()) return;
      if (performance.now() < ignoreSelectionPopupUntil) return;
      const clientX = event.clientX;
      const clientY = event.clientY;

      setTimeout(() => {
        const selection = window.getSelection();
        if (textHighlightRangeAdjusting) {
          const adjustedRange = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
          applyAdjustedTextHighlightRange(adjustedRange, clientX, clientY);
          return;
        }
        if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || !selection.toString().trim()) {
          const clickedSource = findTextHighlightAtPoint(clientX, clientY);
          if (clickedSource && !isTextHighlightPriorityClickTarget(event.target)) {
            showTextHighlightPopup(clickedSource.range, clientX, clientY, clickedSource);
            return;
          }
          hideTextHighlightPopup();
          return;
        }
        const range = selection.getRangeAt(0);
        if (!isRangeInsideProvisionView(range)) {
          hideTextHighlightPopup();
          return;
        }
        if (findOverlappingTextHighlightRange(range)) {
          hideTextHighlightPopup({ force: true });
          showTextHighlightOverlapNotice(clientX, clientY);
          return;
        }
        showTextHighlightPopup(range, clientX, clientY);
      }, 0);
    });

    document.addEventListener('mousedown', (event) => {
      if (event.target.closest?.('#egov-ext-text-highlight-popup')) return;
      if (textHighlightRangeAdjusting) return;
      if (isTextHighlightMemoEditing()) {
        if (isTextHighlightMemoDirty()) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          textHighlightPopup?.querySelector('textarea')?.focus();
          return;
        }
        cancelTextHighlightMemoEdit({ focusButton: false });
      }
      hideTextHighlightPopup();
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (isTextHighlightMemoEditing()) cancelTextHighlightMemoEdit();
      else hideTextHighlightPopup();
    });
    document.addEventListener('scroll', () => {
      textHighlightHitTestCache = null;
      if (!hideTextHighlightPopup()) scheduleTextHighlightTargetOutline();
      clearTextHighlightMemoHover({ immediate: true });
    }, true);
    window.addEventListener('blur', () => {
      // Keep the highlight/memo popup open while the memo editor is visible,
      // even when no text has been changed yet. The user may temporarily move
      // to another window to check or copy information for the memo.
      if (isTextHighlightMemoEditing()) {
        clearTextHighlightMemoHover({ immediate: true });
        return;
      }
      hideTextHighlightPopup();
      clearTextHighlightMemoHover({ immediate: true });
    });
    window.addEventListener('resize', () => {
      textHighlightHitTestCache = null;
      if (!hideTextHighlightPopup()) scheduleTextHighlightTargetOutline();
      clearTextHighlightMemoHover({ immediate: true });
    });
    window.addEventListener('pagehide', () => {
      if (textHighlightSaveTimer) persistTextHighlightRecordsNow();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && textHighlightSaveTimer) persistTextHighlightRecordsNow();
    });
    observeTextHighlightDomChanges();
    scheduleTextHighlightRestore(0);
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
    const newCursor = Math.max(
      0,
      Math.min(articleJumpHistory.length - 1, articleJumpCursor + dir)
    );
    const returnPosition = activeJumpReturnPosition ? null : getCurrentJumpReturnPosition();
    articleJumpCursor = newCursor;
    const raw   = articleJumpHistory[articleJumpCursor];
    let moved = false;
    if (raw.startsWith('#')) {
      const target = getHashTargetElement(raw);
      if (target instanceof Element) {
        highlightAndScroll(target, 0.25, { showReturnButton: false });
        history.replaceState(null, '', `#${encodeURIComponent(target.id)}`);
        moved = true;
      }
    } else {
      const parts = raw.split('.');
      moved = jumpToArticleWithDetail(
        parts[0], parts[1] || null, parts[2] || null,
        { showReturnButton: false }
      );
    }
    if (moved && returnPosition) showJumpReturnButton(returnPosition);
    showJumpHistoryIndicator();
  }

  // ==================
  // 履歴インジケーター（画面下部）
  // ==================
  function numToDisplay(raw) {
    if (!raw) return '';
    if (raw.startsWith('#')) {
      const parsed = parseProvisionHash(raw);
      const targetKey = getBookmarkTargetKey(parsed);
      return targetKey ? getReferenceTargetLabel(targetKey) : raw;
    }
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

  function closeDialog(options = {}) {
    const deferBookmarkRender = options?.deferBookmarkRender === true;
    const preserveHighlights = options?.preserveHighlights === true;
    const closingBookmarkDialog = activeDialog?.classList.contains('egov-ext-bookmark-mode') === true;
    if (activeDialog) { activeDialog.remove(); activeDialog = null; }
    if (!preserveHighlights) clearHighlights();
    if (!closingBookmarkDialog || deferBookmarkRender) return;

    articleBookmarkDialogSessionActive = false;
    if (!articleBookmarkGuttersDirty) return;
    articleBookmarkGuttersDirty = false;
    articleBookmarkGutterSignature = getArticleBookmarkGutterSignature(articleBookmarksCache);
    renderArticleBookmarkGutters();
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
    if (el.closest('.egov-ext-overlay, #TOC, #egov-ext-guide, #egov-jump-indicator, #egov-page-indicator')) return false;
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
    if (shouldFavorite) {
      setupFavoriteScrollPersistence();
      updateFavoriteScrollPosition(getCurrentScrollTop());
    }
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
      showPageIndicator(nextFavorite ? 'お気に入りに追加しました' : 'お気に入りから外しました');
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

  function isLawRefScrollMode() {
    return lawRefPageScrollOverride ?? lawRefClickEnabled;
  }

  function updateLawRefModeButton() {
    const button = document.getElementById('egov-ext-law-ref-mode-button');
    if (!button) return;
    if (!button.dataset.fixedModeWidth) {
      button.textContent = 'ポップアップ';
      button.style.setProperty('box-sizing', 'border-box', 'important');
      button.style.setProperty('width', 'auto', 'important');
      const popupModeWidth = Math.ceil(button.getBoundingClientRect().width);
      if (popupModeWidth > 0) {
        button.style.setProperty('width', `${popupModeWidth}px`, 'important');
        button.style.setProperty('min-width', `${popupModeWidth}px`, 'important');
        button.dataset.fixedModeWidth = String(popupModeWidth);
      }
    }
    const effectiveScrollMode = lawRefModeCtrlPressed ? !isLawRefScrollMode() : isLawRefScrollMode();
    const modeLabel = effectiveScrollMode ? 'スクロール' : 'ポップアップ';
    button.textContent = modeLabel;
    button.classList.toggle('is-active', effectiveScrollMode && !lawRefModeCtrlPressed);
    button.classList.toggle('is-ctrl-temporary', lawRefModeCtrlPressed);
    button.setAttribute('aria-pressed', String(effectiveScrollMode));
    button.title = lawRefModeCtrlPressed
      ? `Ctrl一時切替中：${modeLabel}`
      : `${modeLabel}（この法令だけの一時設定）`;
    button.setAttribute('aria-label', button.title);
  }

  function toggleLawRefPageMode() {
    lawRefPageScrollOverride = !isLawRefScrollMode();
    hideLawReferencePreview();
    updateLawRefModeButton();
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
    updateLawRefModeButton();
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
      { id: 'egov-ext-law-ref-mode-button', label: 'スクロール', onClick: toggleLawRefPageMode },
      { id: 'egov-ext-highlight-list-button', label: 'メモ', onClick: () => showTextHighlightListDialog() },
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
      showPageIndicator('\u6cd5\u4ee4ID\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f');
      return;
    }
    if (!openLightweightViewerDirectly(lawId)) {
      showPageIndicator('\u8efd\u91cf\u30d3\u30e5\u30fc\u30a2\u3092\u958b\u3051\u307e\u305b\u3093\u3067\u3057\u305f');
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

  function showPageIndicator(message, anchorEl = null) {
    let ind = document.getElementById('egov-page-indicator');
    if (!ind) {
      ind = document.createElement('div');
      ind.id = 'egov-page-indicator';
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

    clearTimeout(pageIndicatorTimer);
    pageIndicatorTimer = setTimeout(() => {
      ind.style.setProperty('opacity', '0', 'important');
      setTimeout(() => { ind.style.setProperty('display', 'none', 'important'); }, 180);
    }, 1400);
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

  function getBookmarkTargetKey(parts) {
    if (!parts?.article) return '';
    const normalizePart = (value) => String(value || '').replace(/_/g, '-');
    const provision = [parts.article, parts.paragraph, parts.item]
      .map(normalizePart)
      .filter(Boolean)
      .join('.');
    return parts.scope ? `${parts.scope}::${provision}` : provision;
  }

  function normalizeArticleBookmark(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const lawId = String(raw.lawId || '').trim().slice(0, 40);
    const targetKey = String(raw.targetKey || '').trim().slice(0, 120);
    const parts = splitReferenceTargetKey(targetKey);
    if (!lawId || !parts.article) return null;
    return {
      id: `${lawId}::${targetKey}`,
      lawId,
      lawName: String(raw.lawName || '').trim().slice(0, 500),
      targetKey,
      articleId: String(raw.articleId || '').slice(0, 500),
      numberLabel: String(raw.numberLabel || getReferenceTargetLabel(targetKey)).slice(0, 200),
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Math.round(Number(raw.createdAt)) : Date.now(),
      updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Math.round(Number(raw.updatedAt)) : Date.now(),
    };
  }

  function normalizeArticleBookmarks(raw) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(raw) ? raw : []) {
      const bookmark = normalizeArticleBookmark(value);
      if (!bookmark || seen.has(bookmark.id)) continue;
      seen.add(bookmark.id);
      result.push(bookmark);
    }
    return result;
  }

  function getArticleBookmarkGutterSignature(bookmarks = articleBookmarksCache) {
    const lawId = getCurrentLawIdFromUrl();
    if (!lawId) return '';
    return `${lawId}\n${(Array.isArray(bookmarks) ? bookmarks : [])
      .filter((bookmark) => bookmark?.lawId === lawId)
      .map((bookmark) => bookmark.targetKey)
      .sort((left, right) => left.localeCompare(right, 'ja', { numeric: true }))
      .join('\n')}`;
  }

  async function getArticleBookmarks() {
    if (articleBookmarksLoaded) return articleBookmarksCache;
    try {
      const stored = await chrome.storage.local.get([ARTICLE_BOOKMARKS_STORAGE_KEY]);
      articleBookmarksCache = normalizeArticleBookmarks(stored[ARTICLE_BOOKMARKS_STORAGE_KEY]);
    } catch (_) {
      articleBookmarksCache = [];
    }
    articleBookmarksLoaded = true;
    return articleBookmarksCache;
  }

  async function saveArticleBookmarks(bookmarks) {
    const normalized = normalizeArticleBookmarks(bookmarks);
    const previousCache = articleBookmarksCache;
    const previousLoaded = articleBookmarksLoaded;
    // storage.onChangedより先にキャッシュを更新し、この画面自身の保存通知で
    // 古い内容を使った全体再描画が始まらないようにする。
    articleBookmarksCache = normalized;
    articleBookmarksLoaded = true;
    try {
      await chrome.storage.local.set({ [ARTICLE_BOOKMARKS_STORAGE_KEY]: normalized });
      return true;
    } catch (_) {
      if (articleBookmarksCache === normalized) {
        articleBookmarksCache = previousCache;
        articleBookmarksLoaded = previousLoaded;
      }
      return false;
    }
  }

  function getBookmarkableProvisionItems() {
    if (articleBookmarkProvisionItemsCache) return articleBookmarkProvisionItemsCache;
    const seen = new Set();
    articleBookmarkProvisionItemsCache = collectProvisionLinkTargets()
      .map((articleEl) => {
        const parts = parseProvisionHash(`#${articleEl.id || ''}`);
        // e-Govでは第1項が条見出しと同じ表示要素を共有するため、
        // 法令内逆リンクと同様に条レベルへまとめ、二重の余白ボタンを作らない。
        if (parts?.paragraph === '1' && !parts.item) return null;
        const targetKey = getBookmarkTargetKey(parts);
        return {
          articleEl,
          id: articleEl.id || '',
          parts,
          targetKey,
          numberLabel: getReferenceTargetLabel(targetKey),
        };
      })
      .filter((item) => item?.targetKey && item.articleEl.offsetParent !== null)
      .filter((item) => {
        if (seen.has(item.targetKey)) return false;
        seen.add(item.targetKey);
        return true;
      });
    return articleBookmarkProvisionItemsCache;
  }

  function findBookmarkNumberElement(item) {
    const target = item?.articleEl;
    const parts = item?.parts;
    if (!(target instanceof Element) || !parts?.article) return null;
    const selector = parts.item
      ? ':scope > .itemtitle, :scope > .listtitle, :scope > [class*="ItemTitle"], :scope > [class*="Subitem"][class*="Title"]'
      : parts.paragraph
        ? ':scope > .paragraphtitle, :scope > .paragraphnum, :scope > [class*="ParagraphTitle"], :scope > [class*="ParagraphNum"]'
        : ':scope > .articletitle, :scope > .articleheading, :scope > em.articleheading, :scope > ._div_ArticleTitle, :scope > [class*="ArticleTitle"], :scope > .articlecontent > .paragraph:first-of-type .paragraphtitle';
    let title = null;
    try {
      title = target.matches(selector) ? target : target.querySelector(selector);
    } catch (_) {}
    return ensureReferenceNumberElement(title || target, parts);
  }

  function getBookmarkItemForRecord(bookmark, items = getBookmarkableProvisionItems()) {
    if (!bookmark || bookmark.lawId !== getCurrentLawIdFromUrl()) return null;
    const byId = bookmark.articleId ? items.find((item) => item.id === bookmark.articleId) : null;
    return byId || items.find((item) => item.targetKey === bookmark.targetKey) || null;
  }

  function applyArticleBookmarkGutterState(button, item, marked) {
    if (!(button instanceof HTMLButtonElement)) return;
    button.classList.toggle('is-bookmarked', marked);
    button.tabIndex = marked ? 0 : -1;
    const label = `${item.numberLabel}のブックマークを${marked ? '削除' : '追加'}`;
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  function createArticleBookmarkGutter(item, marked) {
    const numberEl = findBookmarkNumberElement(item);
    if (!(numberEl instanceof Element) || !(numberEl.parentNode instanceof Node)) return null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'egov-ext-bookmark-gutter';
    button.dataset.bookmarkTargetKey = item.targetKey;
    applyArticleBookmarkGutterState(button, item, marked);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleArticleBookmark(item);
    });
    numberEl.classList.add('egov-ext-bookmark-number-host');
    numberEl.parentNode.insertBefore(button, numberEl);
    articleBookmarkGutterButtons.set(item.targetKey, button);
    return button;
  }

  function updateArticleBookmarkGutter(item, marked) {
    let button = articleBookmarkGutterButtons.get(item.targetKey);
    if (!(button instanceof HTMLButtonElement) || !button.isConnected) {
      button = [...document.querySelectorAll('.egov-ext-bookmark-gutter')]
        .find((candidate) => candidate.dataset.bookmarkTargetKey === item.targetKey) || null;
    }
    if (!(button instanceof HTMLButtonElement)) {
      button = createArticleBookmarkGutter(item, marked);
    } else {
      articleBookmarkGutterButtons.set(item.targetKey, button);
      applyArticleBookmarkGutterState(button, item, marked);
    }
    return button;
  }

  async function renderArticleBookmarkGutters() {
    const renderVersion = ++articleBookmarkRenderVersion;
    articleBookmarkGutterButtons.clear();
    document.querySelectorAll('.egov-ext-bookmark-gutter').forEach((button) => button.remove());
    document.querySelectorAll('.egov-ext-bookmark-number-host').forEach((host) => {
      host.classList.remove('egov-ext-bookmark-number-host');
    });

    const lawId = getCurrentLawIdFromUrl();
    if (!lawId) return;
    const bookmarks = await getArticleBookmarks();
    if (renderVersion !== articleBookmarkRenderVersion) return;
    articleBookmarkGutterSignature = getArticleBookmarkGutterSignature(bookmarks);
    const bookmarkedKeys = new Set(
      bookmarks.filter((bookmark) => bookmark.lawId === lawId).map((bookmark) => bookmark.targetKey)
    );

    for (const item of getBookmarkableProvisionItems()) {
      if (renderVersion !== articleBookmarkRenderVersion) return;
      const marked = bookmarkedKeys.has(item.targetKey);
      createArticleBookmarkGutter(item, marked);
    }
  }

  async function toggleArticleBookmark(item) {
    if (!item?.targetKey || !item?.id) return false;
    const lawId = getCurrentLawIdFromUrl();
    if (!lawId) return false;
    const id = `${lawId}::${item.targetKey}`;
    const now = performance.now();
    const lastToggleAt = articleBookmarkLastToggleAt.get(id);
    if (articleBookmarkToggleLocks.has(id) ||
        (typeof lastToggleAt === 'number' && now - lastToggleAt < ARTICLE_BOOKMARK_TOGGLE_DEBOUNCE_MS)) {
      return false;
    }
    articleBookmarkToggleLocks.add(id);
    try {
      const bookmarks = [...await getArticleBookmarks()];
      const index = bookmarks.findIndex((bookmark) => bookmark.id === id);
      const removing = index >= 0;
      if (removing) {
        bookmarks.splice(index, 1);
      } else {
        bookmarks.push({
          id,
          lawId,
          lawName: getCurrentLawName(),
          targetKey: item.targetKey,
          articleId: item.id,
          numberLabel: item.numberLabel,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      const previousGutterSignature = articleBookmarkGutterSignature;
      articleBookmarkGutterSignature = getArticleBookmarkGutterSignature(bookmarks);
      // 追加・通常削除では全条文を作り直さず、操作対象だけ即時更新する。
      updateArticleBookmarkGutter(item, !removing);
      if (!await saveArticleBookmarks(bookmarks)) {
        articleBookmarkGutterSignature = previousGutterSignature;
        updateArticleBookmarkGutter(item, removing);
        showPageIndicator('ブックマークの保存に失敗しました');
        return false;
      }
      const completedAt = performance.now();
      articleBookmarkLastToggleAt.set(id, completedAt);
      setTimeout(() => {
        if (articleBookmarkLastToggleAt.get(id) === completedAt) articleBookmarkLastToggleAt.delete(id);
      }, ARTICLE_BOOKMARK_TOGGLE_DEBOUNCE_MS);
      showPageIndicator(
        `${item.numberLabel}のブックマークを${removing ? '削除' : '追加'}しました`,
        item.articleEl,
      );
      return true;
    } finally {
      articleBookmarkToggleLocks.delete(id);
    }
  }

  async function removeArticleBookmark(bookmark) {
    const bookmarks = [...await getArticleBookmarks()];
    const next = bookmarks.filter((item) => item.id !== bookmark?.id);
    if (next.length === bookmarks.length) return false;
    if (!await saveArticleBookmarks(next)) {
      showPageIndicator('ブックマークの削除に失敗しました');
      return false;
    }
    articleBookmarkGuttersDirty = true;
    return true;
  }

  async function toggleBookmarkAtCurrentPosition() {
    const ready = await waitForArticles();
    if (!ready) {
      showPageIndicator('条文の読み込み完了後にもう一度試してください');
      return;
    }
    const provisionItems = getBookmarkableProvisionItems();
    const keyboardItem = keyboardBookmarkTargetId
      ? provisionItems.find((candidate) => candidate.id === keyboardBookmarkTargetId)
      : null;
    keyboardBookmarkTargetId = '';
    const item = keyboardItem || getProvisionAtViewport25pct(provisionItems);
    if (!item) {
      showPageIndicator('ブックマークできる条文が見つかりません');
      return;
    }
    await toggleArticleBookmark(item);
  }

  function buildBookmarkShortcutCodes(count) {
    if (!count) return [];
    const strokeCount = count <= 7
      ? 1
      : count <= 49
        ? 2
        : count <= 343
          ? 3
          : Math.ceil(Math.log(count) / Math.log(BOOKMARK_SHORTCUT_KEYS.length));
    return Array.from({ length: count }, (_, index) => {
      let value = index;
      const chars = Array(strokeCount).fill(BOOKMARK_SHORTCUT_KEYS[0]);
      for (let position = strokeCount - 1; position >= 0; position -= 1) {
        chars[position] = BOOKMARK_SHORTCUT_KEYS[value % BOOKMARK_SHORTCUT_KEYS.length];
        value = Math.floor(value / BOOKMARK_SHORTCUT_KEYS.length);
      }
      return chars.join('');
    });
  }

  function sortCurrentLawBookmarkRows(bookmarks, provisionItems) {
    const itemOrder = new Map(provisionItems.map((item, index) => [item.targetKey, index]));
    return bookmarks
      .filter((bookmark) => bookmark.lawId === getCurrentLawIdFromUrl())
      .map((bookmark) => ({
        bookmark,
        item: getBookmarkItemForRecord(bookmark, provisionItems),
      }))
      .sort((left, right) => {
        const leftIndex = itemOrder.get(left.bookmark.targetKey) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = itemOrder.get(right.bookmark.targetKey) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex || left.bookmark.targetKey.localeCompare(right.bookmark.targetKey, 'ja', { numeric: true });
      });
  }

  function getBookmarkRowBody(row) {
    if (!row?.item) return '現在の法令本文からこの条文を見つけられませんでした。';
    let body = normalizeProvisionText(getProvisionBodyText(row.item));
    if (!body) return '（本文なし）';

    // 法令内逆リンクと同様、条文番号は太字ラベル側だけに表示する。
    if (!row.item.parts?.paragraph && !row.item.parts?.item) {
      body = body.replace(/^(?:（[^）]*）|\([^)]*\))\s*/, '');
    }
    const displayParts = splitReferenceTargetKey(row.item.targetKey);
    for (const candidate of getReferenceNumberCandidates(displayParts)) {
      const numberText = normalizeProvisionText(candidate);
      if (!numberText || !body.startsWith(numberText)) continue;
      body = body.slice(numberText.length).replace(/^[\s　:：\-–—]+/, '').trim();
      break;
    }
    return body || '（本文なし）';
  }

  function getBookmarkHistoryEntry(item) {
    return item?.id ? `#${item.id}` : '';
  }

  function jumpToArticleBookmark(row) {
    const target = row?.item?.articleEl;
    if (!(target instanceof Element)) {
      showPageIndicator('ブックマーク先の条文を見つけられませんでした');
      return false;
    }
    keyboardBookmarkTargetId = '';
    const currentItem = getProvisionAtViewport25pct(getBookmarkableProvisionItems());
    const sourceHistoryEntry = getBookmarkHistoryEntry(currentItem);
    const targetHistoryEntry = getBookmarkHistoryEntry(row.item);
    if (sourceHistoryEntry) pushJumpHistory(sourceHistoryEntry);
    closeDialog();
    highlightAndScroll(target, 0.25, { showReturnButton: true });
    if (targetHistoryEntry) pushJumpHistory(targetHistoryEntry);
    history.replaceState(null, '', `#${encodeURIComponent(target.id)}`);
    return true;
  }

  async function showBookmarkDialog({ refresh = false } = {}) {
    const ready = await waitForArticles();
    if (!ready) {
      showPageIndicator('条文の読み込み完了後にもう一度試してください');
      return;
    }
    const provisionItems = getBookmarkableProvisionItems();
    const rows = sortCurrentLawBookmarkRows(await getArticleBookmarks(), provisionItems);
    const shortcutCodes = buildBookmarkShortcutCodes(rows.length);
    const multiStrokeHelp = rows.length >= 8
      ? '、<kbd>;</kbd>/<kbd>Backspace</kbd>で最後の入力を取消'
      : '';
    articleBookmarkDialogSessionActive = true;
    if (activeDialog) {
      closeDialog({ deferBookmarkRender: refresh, preserveHighlights: refresh });
    }
    const dialog = createDialog(`
      <div class="egov-ext-dialog-header">
        <div>
          <div class="egov-ext-dialog-title">条文ブックマーク</div>
          <div class="egov-ext-bookmark-key-status" aria-live="polite" hidden></div>
        </div>
        <button type="button" class="egov-ext-close" aria-label="閉じる">×</button>
        </div>
        <div class="egov-ext-bookmark-dialog-body">
          <div class="egov-ext-bookmark-help">
          <kbd>ASDFJKL</kbd>で選択・ジャンプ、<kbd>n</kbd>/<kbd>p</kbd>で移動、<kbd>Enter</kbd>でジャンプ、<kbd>Space</kbd>で削除${multiStrokeHelp}、<kbd>b</kbd>/<kbd>Esc</kbd>で閉じる
        </div>
        <div class="egov-ext-bookmark-list" role="listbox" tabindex="0">
          ${rows.length ? rows.map((row, index) => `
            <div class="egov-ext-bookmark-row" role="option" data-index="${index}" data-shortcut="${shortcutCodes[index]}">
              <div class="egov-ext-bookmark-shortcut" aria-label="ショートカット ${shortcutCodes[index].toUpperCase()}">
                ${[...shortcutCodes[index]].map((key) => `<kbd>${key.toUpperCase()}</kbd>`).join('')}
              </div>
              <div class="egov-ext-bookmark-content">
                <div class="egov-ext-bookmark-number">${escapeHtml(row.bookmark.numberLabel || getReferenceTargetLabel(row.bookmark.targetKey))}</div>
                <div class="egov-ext-bookmark-text">${escapeHtml(getBookmarkRowBody(row))}</div>
              </div>
              <button type="button" class="egov-ext-bookmark-delete" data-index="${index}" aria-label="ブックマークを削除" title="ブックマークを削除">×</button>
            </div>
          `).join('') : '<div class="egov-ext-bookmark-empty">この法令にはブックマークがありません。</div>'}
        </div>
      </div>
    `, 'egov-ext-bookmark-mode');

    const list = dialog.querySelector('.egov-ext-bookmark-list');
    const status = dialog.querySelector('.egov-ext-bookmark-key-status');
    const rowElements = [...dialog.querySelectorAll('.egov-ext-bookmark-row')];
    let prefix = '';
    let selectedVisibleIndex = -1;
    let selectionMode = 'none';
    let visibleIndexes = rows.map((_row, index) => index);

    function updateRows({ scroll = false } = {}) {
      visibleIndexes = [];
      rowElements.forEach((rowEl, index) => {
        const visible = !prefix || shortcutCodes[index].startsWith(prefix);
        rowEl.hidden = !visible;
        if (visible) visibleIndexes.push(index);
      });
      if (selectedVisibleIndex >= visibleIndexes.length) {
        selectedVisibleIndex = -1;
        selectionMode = 'none';
      }
      rowElements.forEach((rowEl) => rowEl.classList.remove('is-selected', 'is-pointer-selected'));
      const selectedIndex = visibleIndexes[selectedVisibleIndex];
      const selected = Number.isInteger(selectedIndex) ? rowElements[selectedIndex] : null;
      if (selectionMode === 'keyboard') selected?.classList.add('is-selected');
      if (selectionMode === 'pointer') selected?.classList.add('is-pointer-selected');
      if (selectionMode === 'keyboard') selected?.setAttribute('aria-selected', 'true');
      rowElements.filter((rowEl) => rowEl !== selected).forEach((rowEl) => rowEl.removeAttribute('aria-selected'));
      if (selectionMode !== 'keyboard') selected?.removeAttribute('aria-selected');
      status.hidden = !prefix;
      status.textContent = prefix ? `入力: ${prefix.toUpperCase()}（${visibleIndexes.length}件）` : '';
      if (scroll) {
        const scrollTarget = selected || rowElements[visibleIndexes[0]];
        scrollTarget?.scrollIntoView({ block: 'nearest' });
      }
    }

    function moveSelection(delta) {
      if (!visibleIndexes.length) return;
      if (selectedVisibleIndex < 0) {
        selectedVisibleIndex = delta > 0 ? 0 : visibleIndexes.length - 1;
      } else {
        selectedVisibleIndex = (selectedVisibleIndex + delta + visibleIndexes.length) % visibleIndexes.length;
      }
      selectionMode = 'keyboard';
      updateRows({ scroll: true });
    }

    async function removeSelected({ confirmRemoval }) {
      const rowIndex = visibleIndexes[selectedVisibleIndex];
      const row = Number.isInteger(rowIndex) ? rows[rowIndex] : null;
      if (!row) return;
      const label = row.bookmark.numberLabel || getReferenceTargetLabel(row.bookmark.targetKey);
      if (confirmRemoval && !window.confirm(`「${label}」のブックマークを削除しますか？`)) return;
      if (await removeArticleBookmark(row.bookmark)) {
        showPageIndicator(`${label}のブックマークを削除しました`);
        await showBookmarkDialog({ refresh: true });
      }
    }

    list.addEventListener('click', (event) => {
      const deleteButton = event.target.closest('.egov-ext-bookmark-delete');
      if (deleteButton) {
        event.preventDefault();
        event.stopPropagation();
        const row = rows[Number(deleteButton.dataset.index)];
        if (!row) return;
        removeArticleBookmark(row.bookmark).then((removed) => {
          if (!removed) return;
          showPageIndicator(`${row.bookmark.numberLabel}のブックマークを削除しました`);
          showBookmarkDialog({ refresh: true });
        });
        return;
      }
      const rowEl = event.target.closest('.egov-ext-bookmark-row');
      const row = rowEl ? rows[Number(rowEl.dataset.index)] : null;
      if (row) jumpToArticleBookmark(row);
    });

    // CSSの:hoverでは、ダイアログを開いた瞬間に静止中のポインターと重なった行も
    // 強調される。実際にポインターが動いたときだけ仮選択として表示する。
    list.addEventListener('pointermove', (event) => {
      const rowEl = event.target.closest('.egov-ext-bookmark-row');
      const rowIndex = rowEl ? Number(rowEl.dataset.index) : -1;
      const visibleIndex = visibleIndexes.indexOf(rowIndex);
      if (visibleIndex < 0) {
        if (selectionMode === 'pointer') {
          selectedVisibleIndex = -1;
          selectionMode = 'none';
          updateRows();
        }
        return;
      }
      if (selectionMode === 'pointer' && selectedVisibleIndex === visibleIndex) return;
      selectedVisibleIndex = visibleIndex;
      selectionMode = 'pointer';
      updateRows();
    });
    list.addEventListener('pointerleave', () => {
      if (selectionMode !== 'pointer') return;
      selectedVisibleIndex = -1;
      selectionMode = 'none';
      updateRows();
    });

    dialog.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const lowerKey = event.key.toLowerCase();
      if (event.key === 'Escape' || lowerKey === 'b') {
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
        return;
      }
      if (lowerKey === 'n' || event.key === 'ArrowDown') {
        event.preventDefault();
        moveSelection(+1);
        return;
      }
      if (lowerKey === 'p' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(-1);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const rowIndex = visibleIndexes[selectedVisibleIndex];
        const row = Number.isInteger(rowIndex) ? rows[rowIndex] : null;
        if (row) jumpToArticleBookmark(row);
        return;
      }
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat) removeSelected({ confirmRemoval: true });
        return;
      }
      if (event.key === 'Backspace' || event.key === ';' || event.key === '；' || event.code === 'Semicolon') {
        event.preventDefault();
        if (!prefix) return;
        prefix = prefix.slice(0, -1);
        selectedVisibleIndex = -1;
        selectionMode = 'none';
        updateRows();
        return;
      }
      if (!BOOKMARK_SHORTCUT_KEYS.includes(lowerKey) || !shortcutCodes.length) return;
      event.preventDefault();
      if (event.repeat) return;
      const nextPrefix = `${prefix}${lowerKey}`;
      if (!shortcutCodes.some((code) => code.startsWith(nextPrefix))) return;
      prefix = nextPrefix;
      selectedVisibleIndex = -1;
      selectionMode = 'none';
      updateRows({ scroll: true });
      if (visibleIndexes.length === 1) {
        const row = rows[visibleIndexes[0]];
        if (row) jumpToArticleBookmark(row);
        return;
      }
      const exactIndex = shortcutCodes.findIndex((code) => code === prefix);
      if (exactIndex >= 0) {
        selectedVisibleIndex = visibleIndexes.indexOf(exactIndex);
        selectionMode = 'keyboard';
        updateRows({ scroll: true });
      }
    });

    updateRows();
    list.focus();
  }

  function getTextHighlightListLabel(row) {
    const formatKey = (key) => {
      const portableKey = String(key || '');
      return portableKey ? getReferenceTargetLabel(portableKey) : '';
    };
    const start = formatKey(row?.record?.u || row?.record?.k);
    const end = formatKey(row?.record?.v || row?.record?.u || row?.record?.k);
    if (start && end && start !== end) return `${start}～${end}`;
    return start || end || '位置不明';
  }

  async function getCurrentTextHighlightListRows() {
    await loadTextHighlightRecords();
    await restoreTextHighlights();
    const live = new Map();
    Object.entries(textHighlightRanges).forEach(([colorKey, ranges]) => {
      ranges.forEach((range) => {
        const id = textHighlightRangeRecordId.get(range);
        if (id && !live.has(id)) live.set(id, { colorKey, range });
      });
    });
    return getTextHighlightDisplayRecords().map((record) => {
      const source = live.get(record.id) || null;
      return {
        record,
        colorKey: source?.colorKey || record.c,
        range: source?.range || null,
        text: source?.range
          ? normalizeProvisionText(source.range.toString())
          : normalizeProvisionText(`${record.q || ''}${record.z ? `…${record.z}` : ''}`),
      };
    }).sort((first, second) => {
      if (first.range && second.range) {
        try {
          return first.range.compareBoundaryPoints(Range.START_TO_START, second.range);
        } catch (_) {}
      }
      if (first.range) return -1;
      if (second.range) return 1;
      return 0;
    });
  }

  function removeTextHighlightListRow(row, { confirmRemoval = false } = {}) {
    const record = row?.record;
    if (!record?.id) return false;
    const label = getTextHighlightListLabel(row);
    if (record.m) {
      if (!window.confirm('ハイライトとともにメモも削除されますが良いですか？')) return false;
    } else if (confirmRemoval && !window.confirm(`「${label}」のハイライトを削除しますか？`)) {
      return false;
    }
    Object.keys(textHighlightRanges).forEach((colorKey) => {
      textHighlightRanges[colorKey] = textHighlightRanges[colorKey]
        .filter((range) => textHighlightRangeRecordId.get(range) !== record.id);
      refreshTextHighlightColor(colorKey);
    });
    textHighlightRecords.delete(record.id);
    textHighlightDirtyRecordIds.delete(record.id);
    textHighlightDeletedRecordIds.add(record.id);
    persistTextHighlightRecordsSoon();
    scheduleTextHighlightRestoreNotice(getUnrestoredTextHighlightRecords(), 0);
    return true;
  }

  function jumpToTextHighlightListRow(row) {
    const range = row?.range;
    if (!range?.startContainer?.isConnected) {
      showPageIndicator('ハイライト位置を本文から見つけられませんでした');
      return false;
    }
    const target = getTextHighlightPortableAnchor(range.startContainer) ||
      getRangeContainerElement(range.startContainer);
    closeDialog();
    if (target instanceof Element) {
      highlightAndScroll(target, 0.25, { showReturnButton: true });
      if (target.id) history.replaceState(null, '', `#${encodeURIComponent(target.id)}`);
    }
    return true;
  }

  async function showTextHighlightListDialog({ refresh = false } = {}) {
    if (isTextHighlightMemoDirty()) {
      textHighlightPopup?.querySelector('textarea')?.focus();
      return;
    }
    hideTextHighlightPopup({ force: true });
    hideTextHighlightMemoTooltip();
    const rows = await getCurrentTextHighlightListRows();
    const shortcutCodes = buildBookmarkShortcutCodes(rows.length);
    const multiStrokeHelp = rows.length >= 8
      ? '、<kbd>;</kbd>/<kbd>Backspace</kbd>で最後の入力を取消'
      : '';
    if (activeDialog) closeDialog({ deferBookmarkRender: refresh, preserveHighlights: true });
    const dialog = createDialog(`
      <div class="egov-ext-dialog-header">
        <div>
          <div class="egov-ext-dialog-title">ハイライト・メモ（${rows.length}/${TEXT_HIGHLIGHT_DISPLAY_LIMIT}）</div>
          <div class="egov-ext-bookmark-key-status" aria-live="polite" hidden></div>
        </div>
        <button type="button" class="egov-ext-close" aria-label="閉じる">×</button>
      </div>
      <div class="egov-ext-bookmark-dialog-body">
        <div class="egov-ext-bookmark-help">
          <kbd>ASDFJKL</kbd>で選択・ジャンプ、<kbd>n</kbd>/<kbd>p</kbd>で移動、<kbd>Enter</kbd>でジャンプ、<kbd>Space</kbd>で削除${multiStrokeHelp}、<kbd>m</kbd>/<kbd>Esc</kbd>で閉じる
        </div>
        <div class="egov-ext-bookmark-list" role="listbox" tabindex="0">
          ${rows.length ? rows.map((row, index) => `
            <div class="egov-ext-bookmark-row" role="option" data-index="${index}" data-shortcut="${shortcutCodes[index]}">
              <div class="egov-ext-bookmark-shortcut" aria-label="ショートカット ${shortcutCodes[index].toUpperCase()}">
                ${[...shortcutCodes[index]].map((key) => `<kbd>${key.toUpperCase()}</kbd>`).join('')}
              </div>
              <div class="egov-ext-bookmark-content egov-ext-highlight-list-content">
                <div class="egov-ext-highlight-list-main">
                  <span class="egov-ext-highlight-list-color is-${escapeHtml(row.colorKey)}" aria-hidden="true"></span>
                  <span class="egov-ext-bookmark-number">${escapeHtml(getTextHighlightListLabel(row))}</span>
                  <span class="egov-ext-bookmark-text">${escapeHtml(row.text || '（本文なし）')}</span>
                </div>
                ${row.record.m ? `<div class="egov-ext-highlight-list-memo">${escapeHtml(String(row.record.m).replace(/\s+/g, ' ').trim())}</div>` : ''}
              </div>
              <button type="button" class="egov-ext-bookmark-delete" data-index="${index}" aria-label="ハイライトを削除" title="ハイライトを削除">×</button>
            </div>
          `).join('') : '<div class="egov-ext-bookmark-empty">この法令にはハイライト・メモがありません。</div>'}
        </div>
        <div class="egov-ext-highlight-list-tooltip" role="tooltip" hidden></div>
      </div>
    `, 'egov-ext-bookmark-mode');

    const list = dialog.querySelector('.egov-ext-bookmark-list');
    const status = dialog.querySelector('.egov-ext-bookmark-key-status');
    const memoTooltip = dialog.querySelector('.egov-ext-highlight-list-tooltip');
    const rowElements = [...dialog.querySelectorAll('.egov-ext-bookmark-row')];
    let prefix = '';
    let selectedVisibleIndex = -1;
    let selectionMode = 'none';
    let visibleIndexes = rows.map((_row, index) => index);
    let memoTooltipVersion = 0;

    function hideMemoTooltip() {
      memoTooltipVersion += 1;
      memoTooltip.hidden = true;
      memoTooltip.textContent = '';
    }

    function showMemoTooltip(rowIndex, rowEl) {
      memoTooltipVersion += 1;
      const memo = String(rows[rowIndex]?.record?.m || '');
      if (!memo.trim() || !(rowEl instanceof Element) || rowEl.hidden) {
        hideMemoTooltip();
        return;
      }
      memoTooltip.textContent = memo;
      memoTooltip.hidden = false;
      const rowRect = rowEl.getBoundingClientRect();
      const tooltipRect = memoTooltip.getBoundingClientRect();
      const margin = 10;
      const left = Math.max(margin, Math.min(rowRect.left + 72, window.innerWidth - tooltipRect.width - margin));
      const below = rowRect.bottom + 6;
      const top = below + tooltipRect.height <= window.innerHeight - margin
        ? below
        : Math.max(margin, rowRect.top - tooltipRect.height - 6);
      memoTooltip.style.left = `${Math.round(left)}px`;
      memoTooltip.style.top = `${Math.round(top)}px`;
    }

    function scheduleMemoTooltip(rowIndex, rowEl) {
      const version = ++memoTooltipVersion;
      requestAnimationFrame(() => {
        if (version === memoTooltipVersion) showMemoTooltip(rowIndex, rowEl);
      });
    }

    function updateRows({ scroll = false } = {}) {
      visibleIndexes = [];
      rowElements.forEach((rowEl, index) => {
        const visible = !prefix || shortcutCodes[index].startsWith(prefix);
        rowEl.hidden = !visible;
        if (visible) visibleIndexes.push(index);
      });
      if (selectedVisibleIndex >= visibleIndexes.length) {
        selectedVisibleIndex = -1;
        selectionMode = 'none';
      }
      rowElements.forEach((rowEl) => rowEl.classList.remove('is-selected', 'is-pointer-selected'));
      const selectedIndex = visibleIndexes[selectedVisibleIndex];
      const selected = Number.isInteger(selectedIndex) ? rowElements[selectedIndex] : null;
      if (selectionMode === 'keyboard') selected?.classList.add('is-selected');
      if (selectionMode === 'pointer') selected?.classList.add('is-pointer-selected');
      if (selectionMode === 'keyboard') selected?.setAttribute('aria-selected', 'true');
      rowElements.filter((rowEl) => rowEl !== selected).forEach((rowEl) => rowEl.removeAttribute('aria-selected'));
      if (selectionMode !== 'keyboard') selected?.removeAttribute('aria-selected');
      status.hidden = !prefix;
      status.textContent = prefix ? `入力: ${prefix.toUpperCase()}（${visibleIndexes.length}件）` : '';
      if (scroll) (selected || rowElements[visibleIndexes[0]])?.scrollIntoView({ block: 'nearest' });
      if (selected) {
        const selectedRowIndex = visibleIndexes[selectedVisibleIndex];
        scheduleMemoTooltip(selectedRowIndex, selected);
      } else {
        hideMemoTooltip();
      }
    }

    function moveSelection(delta) {
      if (!visibleIndexes.length) return;
      selectedVisibleIndex = selectedVisibleIndex < 0
        ? (delta > 0 ? 0 : visibleIndexes.length - 1)
        : (selectedVisibleIndex + delta + visibleIndexes.length) % visibleIndexes.length;
      selectionMode = 'keyboard';
      updateRows({ scroll: true });
    }

    async function removeRow(row, confirmRemoval) {
      if (!removeTextHighlightListRow(row, { confirmRemoval })) return;
      showPageIndicator(`${getTextHighlightListLabel(row)}のハイライトを削除しました`);
      await showTextHighlightListDialog({ refresh: true });
    }

    list.addEventListener('click', (event) => {
      const deleteButton = event.target.closest('.egov-ext-bookmark-delete');
      if (deleteButton) {
        event.preventDefault();
        event.stopPropagation();
        const row = rows[Number(deleteButton.dataset.index)];
        if (row) removeRow(row, false);
        return;
      }
      const rowEl = event.target.closest('.egov-ext-bookmark-row');
      const row = rowEl ? rows[Number(rowEl.dataset.index)] : null;
      if (row) jumpToTextHighlightListRow(row);
    });
    list.addEventListener('pointermove', (event) => {
      const rowEl = event.target.closest('.egov-ext-bookmark-row');
      const rowIndex = rowEl ? Number(rowEl.dataset.index) : -1;
      const visibleIndex = visibleIndexes.indexOf(rowIndex);
      if (visibleIndex < 0) {
        if (selectionMode === 'pointer') {
          selectedVisibleIndex = -1;
          selectionMode = 'none';
          updateRows();
        }
        return;
      }
      if (selectionMode === 'pointer' && selectedVisibleIndex === visibleIndex) {
        showMemoTooltip(rowIndex, rowEl);
        return;
      }
      selectedVisibleIndex = visibleIndex;
      selectionMode = 'pointer';
      updateRows();
    });
    list.addEventListener('pointerleave', () => {
      if (selectionMode !== 'pointer') return;
      selectedVisibleIndex = -1;
      selectionMode = 'none';
      updateRows();
    });
    list.addEventListener('scroll', () => {
      const rowIndex = visibleIndexes[selectedVisibleIndex];
      const rowEl = Number.isInteger(rowIndex) ? rowElements[rowIndex] : null;
      if (rowEl) showMemoTooltip(rowIndex, rowEl);
      else hideMemoTooltip();
    }, { passive: true });
    dialog.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const lower = event.key.toLowerCase();
      if (event.key === 'Escape' || lower === 'm' || lower === 'b') {
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
        return;
      }
      if (lower === 'n' || event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); return; }
      if (lower === 'p' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        const rowIndex = visibleIndexes[selectedVisibleIndex];
        if (Number.isInteger(rowIndex)) jumpToTextHighlightListRow(rows[rowIndex]);
        return;
      }
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        const rowIndex = visibleIndexes[selectedVisibleIndex];
        if (!event.repeat && Number.isInteger(rowIndex)) removeRow(rows[rowIndex], true);
        return;
      }
      if (event.key === 'Backspace' || event.key === ';' || event.key === '；' || event.code === 'Semicolon') {
        event.preventDefault();
        if (!prefix) return;
        prefix = prefix.slice(0, -1);
        selectedVisibleIndex = -1;
        selectionMode = 'none';
        updateRows();
        return;
      }
      if (!BOOKMARK_SHORTCUT_KEYS.includes(lower) || !shortcutCodes.length) return;
      event.preventDefault();
      if (event.repeat) return;
      const nextPrefix = `${prefix}${lower}`;
      if (!shortcutCodes.some((code) => code.startsWith(nextPrefix))) return;
      prefix = nextPrefix;
      selectedVisibleIndex = -1;
      selectionMode = 'none';
      updateRows({ scroll: true });
      if (visibleIndexes.length === 1) jumpToTextHighlightListRow(rows[visibleIndexes[0]]);
    });
    updateRows();
    list.focus();
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

    // ブックマーク一覧のキー操作は、モーダル自身のハンドラーに任せる。
    if (activeDialog?.classList.contains('egov-ext-bookmark-mode')) return;

    if (e.key === 'Escape') {
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
      if (e.key !== ' ' && lowerKey !== 'n' && lowerKey !== 'p') keyboardBookmarkTargetId = '';
      if (e.shiftKey && lowerKey === 'g') { e.preventDefault(); toggleParenthesesMute('nested'); return; }
      if (e.shiftKey && lowerKey === 't') { e.preventDefault(); showLawTocDialog({ initialFocus: 'natural' }); return; }
      if (e.key === 'g') { e.preventDefault(); toggleParenthesesMute('flat'); return; }
      if (e.key === 'h') { e.preventDefault(); navigateJumpHistory(-1); return; }
      if (e.key === 'l') { e.preventDefault(); navigateJumpHistory(+1); return; }
      if (e.key === 'b') { e.preventDefault(); showBookmarkDialog(); return; }
      if (e.key === 'm') { e.preventDefault(); showTextHighlightListDialog(); return; }
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) toggleBookmarkAtCurrentPosition();
        return;
      }
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

  document.addEventListener('wheel', () => {
    keyboardBookmarkTargetId = '';
  }, { capture: true, passive: true });
  document.addEventListener('pointerdown', () => {
    keyboardBookmarkTargetId = '';
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
    showPageIndicator(nextFavorite ? 'お気に入りに追加しました' : 'お気に入りから外しました');
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
        if (notify) showPageIndicator('定義用語ガイド: 条文の読み込み完了後にもう一度試してください');
        return;
      }
      const signature = getDefinitionApplySignature();
      if (!notify && signature && signature === definitionApplySignature && document.querySelector('.egov-ext-defined-term')) return;
      clearDefinitionTooltips();
      const startedAt = performance.now();
      if (notify) showPageIndicator('定義用語ガイドを解析しています');
      definitionMap = extractDefinitions();
      if (!definitionMap.size) {
        if (notify) showPageIndicator('定義用語ガイド: 定義用語は見つかりませんでした');
        return;
      }
      const markedCount = markDefinedTerms(definitionMap);
      definitionApplySignature = signature;
      console.debug(`[e-Gov Enhancer] 定義用語ガイド: extract+mark ${(performance.now() - startedAt).toFixed(1)}ms (${definitionMap.size} terms / ${markedCount} marks)`);
      if (notify) {
        showPageIndicator(
          markedCount > 0
            ? `定義用語ガイドを有効化しました（${definitionMap.size}語 / ${markedCount}箇所）`
            : `定義用語は${definitionMap.size}語見つかりましたが、本文中の表示箇所はありませんでした`
        );
      }
    } catch (error) {
      console.warn('[e-Gov Enhancer] 定義用語ガイドの解析に失敗しました', error);
      showPageIndicator('定義用語ガイドの解析に失敗しました');
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
      showPageIndicator('条文の読み込み完了後にもう一度試してください');
      return;
    }

    const items = getProvisionLinkCopyItems();
    if (items.length === 0) {
      showPageIndicator('コピーできる条文リンクが見つかりません');
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
        showPageIndicator('条文リンクをコピーしました', selected.articleEl);
        closeDialog();
      } else {
        showPageIndicator('クリップボードへのコピーに失敗しました', selected.articleEl);
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
  function jumpToArticle(num, options = {}) {
    const showReturnButton = options.showReturnButton !== false;
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
          highlightAndScroll(target, 0.25, { showReturnButton });
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
      if (exactPattern.test(text)) { highlightAndScroll(el, 0.25, { showReturnButton }); return true; }
    }
    return false;
  }

  // ==================
  // 項・号まで含む詳細ジャンプ
  // ==================
  function jumpToArticleWithDetail(articleNum, paraNum, itemNum, options = {}) {
    const showReturnButton = options.showReturnButton !== false;
    if (!paraNum) return jumpToArticle(articleNum, { showReturnButton });

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

    if (!ni) { highlightAndScroll(paraEl, 0.25, { showReturnButton }); return true; }

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
    highlightAndScroll(itemEl, 0.25, { showReturnButton });
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

  function buildReferenceTargetElementIndex() {
    const index = new Map();
    const provisionRoot = document.querySelector('#provisionview');
    if (!(provisionRoot instanceof Element)) return index;
    provisionRoot.querySelectorAll('[data-article-num], [id*="-At_"]').forEach((element) => {
      const parsed = element.id ? parseProvisionHash(`#${element.id}`) : null;
      const article = String(element.dataset?.articleNum || parsed?.article || '').replace(/_/g, '-');
      const paragraph = String(element.dataset?.paragraphNum || parsed?.paragraph || '').replace(/_/g, '-');
      const item = String(element.dataset?.itemNum || parsed?.item || '').replace(/_/g, '-');
      const scope = String(element.dataset?.referenceScope || parsed?.scope || '');
      const targetKey = canonicalizeReferenceTargetKey(
        `${scope ? `${scope}::` : ''}${[article, paragraph, item].filter(Boolean).join('.')}`
      );
      if (targetKey && !index.has(targetKey)) index.set(targetKey, element);
    });
    return index;
  }

  function findReferenceTargetElement(targetKey) {
    const indexedTarget = referenceTargetElementIndex.get(
      canonicalizeReferenceTargetKey(targetKey)
    );
    if (indexedTarget instanceof Element && indexedTarget.isConnected) return indexedTarget;
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

    // e-GovのDOM IDは枝番号を「At_7_2」、保存用キーは「7-2」と表す。
    // どちらから呼ばれても「第七条の二」を正しく特定できるよう両方を区切りとして扱う。
    const segmentSets = rawText.split(/[-_]/).map((segment) => getReferenceNumberSegmentVariants(segment));
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
    const sameLawPopup = !isLawRefScrollMode();
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
    const scrollMode = isLawRefScrollMode();
    let shouldPopup = !scrollMode;
    if (scrollMode && lawRefOtherLawPopupEnabled && isDifferentLaw) {
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
    if (clear) {
      clearExternalReferenceLinks();
      referenceTargetElementIndex = buildReferenceTargetElementIndex();
    }
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
        const referencesToRefresh = {};
        Object.keys(internalReferences).forEach((targetKey) => {
          if (mergedReferences[targetKey]) referencesToRefresh[targetKey] = mergedReferences[targetKey];
        });
        applyReferenceLinksForLaw(referencesToRefresh);
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
        if (!silent) showPageIndicator('条文の読み込み完了後にもう一度試してください');
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
      if (!silent) showPageIndicator('逆参照リンクを設定しました');
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
    if (!silent) showPageIndicator('逆参照リンクを無効化しました');
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
    articleBookmarkProvisionItemsCache = null;
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
    keyboardBookmarkTargetId = targetEl.id || '';

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

  function getCurrentFavoriteLocation() {
    const articles = getAllArticles();
    if (!articles.length) return null;
    const container = getScrollContainer();
    const containerRect = container?.getBoundingClientRect();
    const viewportTop = containerRect?.top || 0;
    let current = articles[0];
    for (const article of articles) {
      if (article.getBoundingClientRect().top > viewportTop + 1) break;
      current = article;
    }
    const parsed = parseProvisionHash(`#${current.id || ''}`);
    if (!parsed?.article) return null;
    const articleKey = canonicalizeReferenceTargetKey(
      `${parsed.scope ? `${parsed.scope}::` : ''}${parsed.article}`
    );
    if (!articleKey) return null;
    const rect = current.getBoundingClientRect();
    const offset = Math.max(0, Math.min(1, (viewportTop - rect.top) / Math.max(1, rect.height)));
    return { articleKey, offset };
  }

  function scrollToStoredFavoriteLocation(articleKey, offset = 0) {
    const target = findReferenceTargetElement(articleKey);
    if (!(target instanceof Element)) return false;
    const normalizedOffset = Math.max(0, Math.min(1, Number(offset) || 0));
    const container = getScrollContainer();
    const rect = target.getBoundingClientRect();
    if (container) {
      const containerRect = container.getBoundingClientRect();
      const top = rect.top - containerRect.top + container.scrollTop + rect.height * normalizedOffset;
      container.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    } else {
      const top = rect.top + window.scrollY + rect.height * normalizedOffset;
      window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    }
    return true;
  }

  async function updateFavoriteScrollPosition(scrollTop) {
    const lawId = getCurrentLawIdFromUrl();
    if (!lawId) return;

    try {
      const favorites = await getFavoritesCache();
      const idx = favorites.findIndex((f) => f.lawId === lawId);
      if (idx === -1) return;

      const normalizedTop = Math.max(0, Math.round(Number(scrollTop) || 0));
      const location = getCurrentFavoriteLocation();
      const normalizedOffset = location ? Math.round(location.offset * 10000) / 10000 : undefined;
      if ((favorites[idx].lastScrollTop ?? 0) === normalizedTop &&
          (!location || (favorites[idx].lastArticleKey === location.articleKey &&
            favorites[idx].lastArticleOffset === normalizedOffset))) return;

      favorites[idx] = {
        ...favorites[idx],
        lastScrollTop: normalizedTop,
        ...(location ? {
          lastArticleKey: location.articleKey,
          lastArticleOffset: normalizedOffset,
        } : {}),
      };
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
    if (!lawId || favoriteScrollPersistenceSetup) return;
    favoriteScrollPersistenceSetup = true;

    let saveEnabled = false;
    getFavoritesCache().then((favorites) => {
      saveEnabled = favorites.some((f) => f.lawId === lawId);
      if (!saveEnabled) {
        favoriteScrollPersistenceSetup = false;
        return;
      }

      const container = getScrollContainer();
      const target = container || window;
      target.addEventListener('scroll', scheduleFavoriteScrollSave, { passive: true });
      window.addEventListener('pagehide', () => { updateFavoriteScrollPosition(getCurrentScrollTop()); }, { once: true });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') updateFavoriteScrollPosition(getCurrentScrollTop());
      });
    }).catch(() => {
      favoriteScrollPersistenceSetup = false;
    });
  }

  async function restoreFavoriteScrollOnLoad() {
    const lawId = getCurrentLawIdFromUrl();
    if (!lawId || location.hash) return false;

    try {
      const favorites = await getFavoritesCache();
      const fav = favorites.find((f) => f.lawId === lawId);
      if (!fav) return false;

      const restore = () => {
        const restoredSharedLocation = typeof fav.lastArticleKey === 'string' &&
          scrollToStoredFavoriteLocation(fav.lastArticleKey, fav.lastArticleOffset);
        if (!restoredSharedLocation) {
          if (typeof fav.lastScrollTop !== 'number') return false;
          scrollToStoredTop(fav.lastScrollTop, 'instant');
        }
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
    const baseSuppress = isLawRefScrollMode();
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
      if (!event.isTrusted || event.key !== 'Control') return;
      lawRefModeCtrlPressed = true;
      updateLawRefModeButton();
      if (!isLawRefScrollMode()) activateLawReferenceAnchorAtPoint(lawReferencePointerPoint);
    }, true);

    document.addEventListener('keyup', (event) => {
      if (!event.isTrusted || event.key !== 'Control') return;
      lawRefModeCtrlPressed = false;
      updateLawRefModeButton();
      if (!isLawRefScrollMode()) hideLawReferencePreview();
    }, true);

    window.addEventListener('blur', () => {
      if (!lawRefModeCtrlPressed) return;
      lawRefModeCtrlPressed = false;
      updateLawRefModeButton();
      hideLawReferencePreview();
    });

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
        const matchCount = performSearch(query, resultEl);
        if (matchCount > 0) pushHistory(searchHistory, query);
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
        const matchCount = performSearch(query, resultEl);
        if (matchCount > 0) pushHistory(searchHistory, query);
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
        const matchCount = performSearch(query, resultEl);
        if (matchCount > 0) pushHistory(searchHistory, query);
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
    if (!query) { if (resultEl) resultEl.textContent = ''; return 0; }
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
    return searchState.highlights.length;
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
    const searchDialog = activeDialog?.classList.contains('egov-ext-search-mode')
      ? activeDialog.querySelector('.egov-ext-dialog')
      : null;
    const dialogBottom = searchDialog?.getBoundingClientRect().bottom || 0;
    const gap = 16;
    if (container) {
      const cRect  = container.getBoundingClientRect();
      const absTop = rect.top - cRect.top + container.scrollTop;
      const preferredOffset = container.clientHeight * 0.25;
      const unobscuredOffset = Math.max(0, dialogBottom + gap - cRect.top);
      const targetOffset = Math.min(container.clientHeight - gap, Math.max(preferredOffset, unobscuredOffset));
      container.scrollTo({ top: Math.max(0, absTop - targetOffset), behavior: scrollBehavior });
    } else {
      const absTop = rect.top + window.scrollY;
      const preferredOffset = window.innerHeight * 0.25;
      const targetOffset = Math.min(window.innerHeight - gap, Math.max(preferredOffset, dialogBottom + gap));
      window.scrollTo({ top: Math.max(0, absTop - targetOffset), behavior: scrollBehavior });
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

    const lawNameTooltip = document.createElement('div');
    lawNameTooltip.className = 'egov-ext-law-name-tooltip';
    lawNameTooltip.setAttribute('role', 'tooltip');
    lawNameTooltip.hidden = true;
    dialog.appendChild(lawNameTooltip);

    function hideLawNameTooltip() {
      lawNameTooltip.hidden = true;
      lawNameTooltip.textContent = '';
    }

    function showLawNameTooltip(item) {
      const nameEl = item?.querySelector('.egov-ext-law-result-name');
      if (!nameEl || nameEl.scrollWidth <= nameEl.clientWidth + 1) {
        hideLawNameTooltip();
        return;
      }

      lawNameTooltip.textContent = nameEl.textContent.trim();
      lawNameTooltip.hidden = false;

      const itemRect = item.getBoundingClientRect();
      const nameRect = nameEl.getBoundingClientRect();
      const tooltipRect = lawNameTooltip.getBoundingClientRect();
      const viewportPadding = 8;
      const gap = 6;
      const maxLeft = Math.max(viewportPadding, window.innerWidth - tooltipRect.width - viewportPadding);
      const left = Math.min(Math.max(viewportPadding, nameRect.left), maxLeft);
      const fitsBelow = itemRect.bottom + gap + tooltipRect.height <= window.innerHeight - viewportPadding;
      const top = fitsBelow
        ? itemRect.bottom + gap
        : Math.max(viewportPadding, itemRect.top - tooltipRect.height - gap);

      lawNameTooltip.style.left = `${left}px`;
      lawNameTooltip.style.top = `${top}px`;
    }

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
      if (idx >= 0 && items[idx]) {
        items[idx].scrollIntoView({ block: 'nearest' });
        showLawNameTooltip(items[idx]);
      } else {
        hideLawNameTooltip();
      }
    }

    // 入力欄へ戻った時や検索語を編集した時は、以前の結果選択を解除する。
    // 選択を残すと、検索のための Enter でその法令を開いてしまう。
    input.addEventListener('focus', () => setFocus(-1));
    input.addEventListener('pointerdown', () => setFocus(-1));
    input.addEventListener('input', () => setFocus(-1));

    function openLaw(law) {
      window.open(buildLawUrl(law.lawId), '_blank');
      closeDialog();
    }

    function renderResults(focusedLawId = null) {
      hideLawNameTooltip();
      listEl.innerHTML = '';
      if (results.length === 0) { listEl.style.setProperty('display', 'none', 'important'); return; }
      listEl.style.setProperty('display', 'block', 'important');
      results = [
        ...results.filter(law => isFav(law.lawId)),
        ...results.filter(law => !isFav(law.lawId)),
      ];
      results.forEach((law, i) => {
        const li  = document.createElement('li');
        const fav = isFav(law.lawId);
        li.className = `egov-ext-law-result-item${fav ? ' favorite' : ''}`;
        li.innerHTML =
          `<div class="egov-ext-law-result-main">` +
            `<span class="egov-ext-law-result-name">${formatLawNameHtml(law.lawName)}</span>` +
            (law.lawNum ? `<span class="egov-ext-law-result-num">${escapeHtml(law.lawNum)}</span>` : '') +
          `</div>` +
          `<button class="egov-ext-law-result-fav${fav ? ' active' : ''}" title="${fav ? 'お気に入りから削除' : 'お気に入りに追加'}">${fav ? '★' : '☆'}</button>`;

        li.querySelector('.egov-ext-law-result-fav').addEventListener('click', (e) => {
          e.stopPropagation();
          toggleFav(law);
          renderResults(law.lawId);
        });

        li.addEventListener('mouseenter', () => { if (hoverEnabled) setFocus(i); });
        li.addEventListener('click', () => openLaw(law));
        listEl.appendChild(li);
      });
      focusedIdx = focusedLawId ? results.findIndex(law => law.lawId === focusedLawId) : -1;
      if (focusedIdx >= 0) setFocus(focusedIdx);
    }

    listEl.addEventListener('scroll', () => {
      const items = listEl.querySelectorAll('.egov-ext-law-result-item');
      if (focusedIdx >= 0 && items[focusedIdx]) showLawNameTooltip(items[focusedIdx]);
      else hideLawNameTooltip();
    });

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
          const law = results[focusedIdx];
          toggleFav(law);
          renderResults(law.lawId);
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
        <tr><td><kbd>b</kbd></td><td>条文ブックマーク一覧を開く / 閉じる</td></tr>
        <tr><td><kbd>m</kbd></td><td>ハイライト・メモ一覧を開く / 閉じる</td></tr>
        <tr><td><kbd>Space</kbd></td><td>現在位置の条文ブックマークを追加 / 削除</td></tr>
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

  function setupArticleBookmarkFeatures() {
    runWhenIdle(() => renderArticleBookmarkGutters(), 1200);
    if (getAllArticles().length > 0) return;

    const observer = new MutationObserver(() => {
      if (getAllArticles().length === 0) return;
      observer.disconnect();
      renderArticleBookmarkGutters();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 10000);
  }

  async function initializeLawPageFeatures() {
    const highlightSettings = await chrome.storage.local.get([TEXT_HIGHLIGHT_ENABLED_KEY]).catch(() => ({}));
    textHighlightFeatureEnabled = highlightSettings[TEXT_HIGHLIGHT_ENABLED_KEY] !== false;
    invalidateArticleCache();
    const articleRoot = document.querySelector('#provisionview') || document.documentElement;
    observeArticleChanges({
      root: articleRoot,
      shouldInvalidate: shouldInvalidateArticleCache,
      onInvalidate() {
        invalidateArticleCache();
        runWhenIdle(() => renderArticleBookmarkGutters(), 500);
        if (textHighlightFeatureEnabled) scheduleTextHighlightRestore();
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
        updateLawRefModeButton();
        setupLawReferenceInteractions();
      });
    }, 1800);
    runWhenIdle(ensureShortcutGuide, 900);
    runWhenIdle(applyDefaultLawSidebarVisibility, 900);
    runWhenIdle(setupFavoriteHeaderBadge, 1200);
    runWhenIdle(setupArticleBookmarkFeatures, 1600);
    if (textHighlightFeatureEnabled) setupTextHighlightInteractions();
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
        if (externalReferencesAutoEnable === true) autoEnableExternalReferenceLinks();
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
