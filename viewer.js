(function () {
  'use strict';

  const shared = globalThis.EgovShared;
  const app = globalThis.EgovApp;
  const {
    applyReferenceLinksInBatches,
    buildProvisionCopyPayload: buildSharedProvisionCopyPayload,
    cacheLiteLawXml,
    cleanLawNameForSearch,
    cloneDefinitionPatterns,
    collectInternalLawReferences,
    collectSearchTextSegments,
    configureReferenceClickable,
    escapeHtml,
    extractInlineAliasDefinition: extractSharedInlineAliasDefinition,
    extractLaws,
    extractTermBeforeParentheticalDefinition: extractSharedTermBeforeParentheticalDefinition,
    findCurrentLawRevisionId,
    formatProvisionNumber,
    formatProvisionSourcePathFromEgovUrl,
    getJapanDateString,
    getLawReferencesData,
    getLiteLawDataUrl,
    getNormalizedTextSignature,
    getReferenceDomParts,
    getReferenceTargetKeyFromEgovUrl,
    getReverseReferenceScopeFlags,
    isTermBoundarySafe: isSharedTermBoundarySafe,
    mergeLawReferences,
    normalizeReverseReferenceScope,
    parseJapaneseReferenceNumber,
    parseProvisionPathFromEgovUrl,
    rangeFromSearchOffsets,
    readCachedLiteLawXml,
    sortReferenceSources,
    splitReferenceTargetKey,
    REVERSE_REFERENCE_SCOPE_KEY,
  } = shared;
  const {
    createReferencePopup,
    getReferenceTargetLabel,
    persistLocal: persistSharedLocal,
    positionFixedPopup,
    pushHistory: pushSharedHistory,
    readFavorites,
    runWhenIdle,
    toggleFavoriteRecord,
  } = app;
  const persistLocal = (items, options = { errorLabel: '設定の保存' }) => persistSharedLocal(items, options);
  const params = new URLSearchParams(location.search);
  const lawId = params.get('lawId') || '';
  const revisionIdParam = params.get('revisionId') || '';
  const sourceUrl = params.get('sourceUrl') || (lawId ? `https://laws.e-gov.go.jp/law/${encodeURIComponent(lawId)}` : '');
  const fallbackLawName = params.get('lawName') || '法令ビューア';
  const embeddedMode = params.get('embedded') === '1';
  const API_V2_BASE = 'https://laws.e-gov.go.jp/api/2';
  const LITE_FONT_SIZE_KEY = 'liteFontSize';
  const LITE_CONTENT_WIDTH_KEY = 'liteContentWidth';
  // Historical key name: this controls the definition guide in both normal and Lite modes.
  const LITE_DEF_TOOLTIP_ENABLED_KEY = 'liteDefTooltipEnabled';
  const DEF_TOOLTIP_CLICK_ONLY_KEY = 'defTooltipClickOnly';
  const EXTERNAL_REFERENCES_AUTO_ENABLE_KEY = 'externalReferencesAutoEnable';
  const TEXT_HIGHLIGHTS_ENABLED_KEY = 'textHighlightsEnabled';
  const ARTICLE_BOOKMARKS_STORAGE_KEY = 'articleBookmarks';
  const BOOKMARK_SHORTCUT_KEYS = ['f', 'j', 'd', 'k', 's', 'l', 'a'];
  const ARTICLE_BOOKMARK_TOGGLE_DEBOUNCE_MS = 500;
  const VALID_FONT_SIZES = new Set(['1', '2', '3', '4', '5']);
  const VALID_CONTENT_WIDTHS = new Set(['full', 'medium', 'narrow']);
  const SKIP_TAGS = new Set(['ImageData', 'Image', 'Fig', 'FigStruct', 'StyleStruct', 'FormatStruct', 'Remarks']);
  const STRUCTURAL_TAGS = new Set([
    'LawTitle', 'Preamble', 'MainProvision', 'Part', 'PartTitle', 'Chapter', 'ChapterTitle', 'Section', 'SectionTitle',
    'Subsection', 'SubsectionTitle', 'Division', 'DivisionTitle', 'Article', 'ArticleTitle', 'ArticleCaption',
    'Paragraph', 'ParagraphNum', 'ParagraphSentence', 'Item', 'ItemTitle', 'ItemSentence',
    'Sentence', 'SupplProvision', 'SupplProvisionLabel', 'AppdxTable', 'AppdxTableTitle',
    'TableStruct', 'TableStructTitle', 'Table', 'TableRow', 'TableColumn'
  ]);
  const INLINE_ALLOWED = new Set(['a', 'b', 'strong']);
  const KANJI_DIGITS = new Map([['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9]]);
  const titleEl = document.getElementById('law-title');
  const metaEl = document.getElementById('law-meta');
  const leftPaneEl = document.getElementById('left-pane');
  const rightPaneEl = document.getElementById('right-pane');
  const contentEl = document.getElementById('law-content');
  const revisionSelect = document.getElementById('revision-select');
  const fontSizeSelect = document.getElementById('font-size-select');
  const contentWidthSelect = document.getElementById('content-width-select');
  const parenModeButton = document.getElementById('paren-mode-button');
  const externalReferencesButton = document.getElementById('external-references-button');
  const definitionLinksButton = document.getElementById('definition-links-button');
  const lawRefModeButton = document.getElementById('law-ref-mode-button');
  const highlightListButton = document.getElementById('highlight-list-button');
  const normalModeButton = document.getElementById('normal-mode-button');
  const compareModeButton = document.getElementById('compare-mode-button');
  const favoriteButton = document.getElementById('favorite-button');
  const shortcutButton = document.getElementById('shortcut-button');

  let lawTitleText = fallbackLawName;
  let lawNumText = '';
  let currentRevisionId = revisionIdParam;
  let revisions = [];
  let anchorCounts = new Map();
  let tocItems = [];
  let articleIndex = new Map();
  let articleElementsCache = [];
  let articleHistory = [];
  let searchHistory = [];
  let articleJumpHistory = [];
  let articleJumpCursor = -1;
  let searchState = { marks: [], current: -1, query: '' };
  let activeDialog = null;
  let indicatorTimer = 0;
  let jumpIndicatorTimer = 0;
  let parenSeq = 0;
  let activeParenGroup = '';
  let parenGroups = new Map();
  let parenthesesWrapped = false;
  let selectedProvisionEl = null;
  let scrollBehavior = 'instant';
  let compareMode = false;
  let focusedPane = 'left';
  let compareResults = [];
  let compareResultButtons = [];
  let compareFocusedIndex = -1;
  let lawRefClickEnabled = true;
  let lawRefOtherLawPopupEnabled = true;
  let lawRefPageScrollOverride = null;
  let lawRefModeCtrlPressed = false;
  let reverseReferenceScope = 'both';
  let liteDefTooltipEnabled = true;
  let defTooltipClickOnly = true;
  let externalReferencesAutoEnable = false;
  let externalReferencesEnabled = false;
  let externalReferencesLoading = false;
  let referenceAnalysisGeneration = 0;
  let activeReferencesPopup = null;
  let activeReferenceViewerPopup = null;
  const referenceViewerPopups = new Set();
  let referenceViewerPopupSequence = 0;
  let referenceViewerLayoutFrame = 0;
  let renderContextLawId = lawId;
  let liteDefinitionMap = new Map();
  let liteDefinitionMatcher = null;
  let liteDefinitionObserver = null;
  let liteDefinitionMarkedArticles = new WeakSet();
  let liteDefinitionMarkQueue = new Set();
  let liteDefinitionMarkWorkScheduled = false;
  let liteDefinitionGeneration = 0;
  let liteDefinitionApplyGeneration = 0;
  let activeLiteTooltip = null;
  let liteTooltipPinned = false;
  let liteTooltipShowTimer = 0;
  let liteTooltipHideTimer = 0;
  let jumpReturnButtonTimer = 0;
  let textHighlightController = null;
  let favoriteScrollSaveTimer = 0;
  let favoriteScrollRestoreStarted = false;
  let favoriteScrollPersistenceSetup = false;
  let articleBookmarksCache = [];
  let articleBookmarksLoaded = false;
  let liteProvisionItemsCache = null;
  let articleBookmarkRenderVersion = 0;
  let articleBookmarkGutterSignature = '';
  const articleBookmarkGutterButtons = new Map();
  const articleBookmarkToggleLocks = new Set();
  const articleBookmarkLastToggleAt = new Map();
  let articleBookmarkGuttersDirty = false;
  let articleBookmarkDialogSessionActive = false;
  let keyboardBookmarkTargetId = '';
  const externalReferencesByElement = new WeakMap();
  const referenceArticleLoadCache = new Map();
  titleEl.textContent = fallbackLawName;
  document.body.dataset.fontSize = '2';
  document.body.dataset.contentWidth = 'full';
  if (embeddedMode) document.body.dataset.embedded = 'true';

  function setViewerToggleButtonState(button, active, title) {
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.title = title;
  }

  function isLawRefScrollMode() {
    return lawRefPageScrollOverride ?? lawRefClickEnabled;
  }

  function updateLawRefModeButton() {
    if (!lawRefModeButton) return;
    if (!lawRefModeButton.dataset.fixedModeWidth) {
      lawRefModeButton.textContent = 'ポップアップ';
      lawRefModeButton.style.boxSizing = 'border-box';
      lawRefModeButton.style.width = 'auto';
      const popupModeWidth = Math.ceil(lawRefModeButton.getBoundingClientRect().width);
      if (popupModeWidth > 0) {
        lawRefModeButton.style.width = `${popupModeWidth}px`;
        lawRefModeButton.style.minWidth = `${popupModeWidth}px`;
        lawRefModeButton.dataset.fixedModeWidth = String(popupModeWidth);
      }
    }
    const effectiveScrollMode = lawRefModeCtrlPressed ? !isLawRefScrollMode() : isLawRefScrollMode();
    const modeLabel = effectiveScrollMode ? 'スクロール' : 'ポップアップ';
    lawRefModeButton.textContent = modeLabel;
    lawRefModeButton.classList.toggle('is-active', effectiveScrollMode && !lawRefModeCtrlPressed);
    lawRefModeButton.classList.toggle('is-ctrl-temporary', lawRefModeCtrlPressed);
    lawRefModeButton.setAttribute('aria-pressed', String(effectiveScrollMode));
    lawRefModeButton.title = lawRefModeCtrlPressed
      ? `Ctrl一時切替中：${modeLabel}`
      : `${modeLabel}（この法令だけの一時設定）`;
    lawRefModeButton.setAttribute('aria-label', lawRefModeButton.title);
  }

  function toggleLawRefPageMode() {
    lawRefPageScrollOverride = !isLawRefScrollMode();
    updateLawRefModeButton();
  }

  function syncViewerToggleButtons() {
    const parenHidden = document.body.dataset.parenMode === 'nested';
    setViewerToggleButtonState(parenModeButton, parenHidden, parenHidden ? 'かっこ消しを解除' : 'かっこを薄くして本文を表示');
    setViewerToggleButtonState(
      externalReferencesButton,
      externalReferencesEnabled,
      externalReferencesEnabled ? '逆参照リンクを無効化' : '逆参照リンクを有効化'
    );
    externalReferencesButton.setAttribute('aria-busy', String(externalReferencesLoading));
    externalReferencesButton.disabled = externalReferencesLoading;
    setViewerToggleButtonState(
      definitionLinksButton,
      liteDefTooltipEnabled,
      liteDefTooltipEnabled ? '定義語リンクを無効化' : '定義語リンクを有効化'
    );
    updateLawRefModeButton();
  }

  function applyFontSize(value) {
    const next = VALID_FONT_SIZES.has(String(value)) ? String(value) : '2';
    document.body.dataset.fontSize = next;
    fontSizeSelect.value = next;
    textHighlightController?.layoutChanged();
  }

  function applyContentWidth(value) {
    const next = VALID_CONTENT_WIDTHS.has(String(value)) ? String(value) : 'full';
    if (document.body.dataset.contentWidth === next) {
      if (contentWidthSelect.value !== next) contentWidthSelect.value = next;
      return false;
    }
    document.body.dataset.contentWidth = next;
    contentWidthSelect.value = next;
    textHighlightController?.layoutChanged();
    refreshReferenceViewerPopupLayout();
    return true;
  }

  function toggleDefinitionLinks() {
    liteDefTooltipEnabled = !liteDefTooltipEnabled;
    if (liteDefTooltipEnabled) scheduleApplyLiteDefinitionTooltips();
    else clearLiteDefinitionTooltips();
    syncViewerToggleButtons();
    persistLocal({ [LITE_DEF_TOOLTIP_ENABLED_KEY]: liteDefTooltipEnabled });
  }

  fontSizeSelect.addEventListener('change', () => {
    applyFontSize(fontSizeSelect.value);
    persistLocal({ [LITE_FONT_SIZE_KEY]: fontSizeSelect.value });
  });
  contentWidthSelect.addEventListener('change', () => {
    applyContentWidth(contentWidthSelect.value);
    persistLocal({ [LITE_CONTENT_WIDTH_KEY]: contentWidthSelect.value });
  });
  function openNormalMode() {
    location.href = sourceUrl || `https://laws.e-gov.go.jp/law/${encodeURIComponent(lawId)}`;
  }

  function openManualPageFromGuide() {
    chrome.runtime.sendMessage({ type: 'egov-open-manual-page' })
      .catch(() => {});
  }

  normalModeButton.addEventListener('click', openNormalMode);
  parenModeButton.addEventListener('click', () => toggleParenMode('nested'));
  externalReferencesButton.addEventListener('click', toggleExternalReferenceLinks);
  definitionLinksButton.addEventListener('click', toggleDefinitionLinks);
  lawRefModeButton.addEventListener('click', toggleLawRefPageMode);
  highlightListButton.addEventListener('click', () => showLiteTextHighlightListDialog());
  compareModeButton.addEventListener('click', () => toggleCompareMode());
  favoriteButton.addEventListener('click', () => toggleFavorite());
  shortcutButton.addEventListener('click', () => showShortcutDialog());
  revisionSelect.addEventListener('change', () => {
    const revisionId = revisionSelect.value;
    if (!revisionId || revisionId === currentRevisionId) return;
    const next = new URL(location.href);
    next.searchParams.set('revisionId', revisionId);
    next.searchParams.set('lawId', lawId);
    location.href = next.toString();
  });
  syncViewerToggleButtons();

  chrome.storage.local.get([
    'scrollBehavior',
    LITE_FONT_SIZE_KEY,
    LITE_CONTENT_WIDTH_KEY,
    'lawRefClickEnabled',
    'lawRefOtherLawPopup',
    REVERSE_REFERENCE_SCOPE_KEY,
    LITE_DEF_TOOLTIP_ENABLED_KEY,
    DEF_TOOLTIP_CLICK_ONLY_KEY,
    EXTERNAL_REFERENCES_AUTO_ENABLE_KEY,
    ARTICLE_BOOKMARKS_STORAGE_KEY,
  ]).then((stored) => {
    applyFontSize(stored[LITE_FONT_SIZE_KEY]);
    applyContentWidth(stored[LITE_CONTENT_WIDTH_KEY]);
    if (stored.scrollBehavior === 'smooth') scrollBehavior = 'smooth';
    lawRefClickEnabled = stored.lawRefClickEnabled !== false;
    lawRefOtherLawPopupEnabled = stored.lawRefOtherLawPopup !== false;
    reverseReferenceScope = normalizeReverseReferenceScope(stored[REVERSE_REFERENCE_SCOPE_KEY]);
    liteDefTooltipEnabled = stored[LITE_DEF_TOOLTIP_ENABLED_KEY] !== false;
    defTooltipClickOnly = stored[DEF_TOOLTIP_CLICK_ONLY_KEY] !== false;
    if (!liteDefTooltipEnabled) clearLiteDefinitionTooltips();
    externalReferencesAutoEnable = stored[EXTERNAL_REFERENCES_AUTO_ENABLE_KEY] === true;
    articleBookmarksCache = normalizeArticleBookmarks(stored[ARTICLE_BOOKMARKS_STORAGE_KEY]);
    articleBookmarksLoaded = true;
    if (articleElementsCache.length) renderLiteArticleBookmarkGutters();
    syncViewerToggleButtons();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.scrollBehavior) {
      scrollBehavior = changes.scrollBehavior.newValue === 'smooth' ? 'smooth' : 'instant';
    }
    if (area === 'local' && changes[LITE_FONT_SIZE_KEY]) applyFontSize(changes[LITE_FONT_SIZE_KEY].newValue);
    if (area === 'local' && changes[LITE_CONTENT_WIDTH_KEY]) applyContentWidth(changes[LITE_CONTENT_WIDTH_KEY].newValue);
    if (area === 'local' && changes.lawRefClickEnabled) {
      lawRefClickEnabled = changes.lawRefClickEnabled.newValue !== false;
      updateLawRefModeButton();
    }
    if (area === 'local' && changes.lawRefOtherLawPopup) lawRefOtherLawPopupEnabled = changes.lawRefOtherLawPopup.newValue !== false;
    if (area === 'local' && changes[REVERSE_REFERENCE_SCOPE_KEY]) {
      reverseReferenceScope = normalizeReverseReferenceScope(changes[REVERSE_REFERENCE_SCOPE_KEY].newValue);
    }
    if (area === 'local' && changes[LITE_DEF_TOOLTIP_ENABLED_KEY]) {
      const nextEnabled = changes[LITE_DEF_TOOLTIP_ENABLED_KEY].newValue !== false;
      if (liteDefTooltipEnabled !== nextEnabled) {
        liteDefTooltipEnabled = nextEnabled;
        if (liteDefTooltipEnabled) {
          applyLiteDefinitionTooltips();
        } else {
          clearLiteDefinitionTooltips();
        }
      }
      syncViewerToggleButtons();
    }
    if (area === 'local' && changes[DEF_TOOLTIP_CLICK_ONLY_KEY]) {
      defTooltipClickOnly = changes[DEF_TOOLTIP_CLICK_ONLY_KEY].newValue !== false;
      hideLiteTooltip(true);
    }
    if (area === 'local' && changes[EXTERNAL_REFERENCES_AUTO_ENABLE_KEY]) {
      externalReferencesAutoEnable = changes[EXTERNAL_REFERENCES_AUTO_ENABLE_KEY].newValue === true;
    }
    if (area === 'local' && changes.favorites) {
      refreshFavoriteButton();
      setupLiteFavoriteScrollPersistence();
    }
    if (area === 'local' && changes[ARTICLE_BOOKMARKS_STORAGE_KEY]) {
      articleBookmarksCache = normalizeArticleBookmarks(changes[ARTICLE_BOOKMARKS_STORAGE_KEY].newValue);
      articleBookmarksLoaded = true;
      const nextSignature = getArticleBookmarkGutterSignature(articleBookmarksCache);
      if (articleBookmarkDialogSessionActive) {
        if (nextSignature !== articleBookmarkGutterSignature) articleBookmarkGuttersDirty = true;
      } else if (nextSignature !== articleBookmarkGutterSignature && articleElementsCache.length) {
        renderLiteArticleBookmarkGutters();
      }
    }
  });

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function injectSearchHighlightStyles() {
    if (document.getElementById('egov-lite-search-highlight-style')) return;
    const style = document.createElement('style');
    style.id = 'egov-lite-search-highlight-style';
    style.textContent =
      '::highlight(egov-lite-search){background:#fff1a8;color:inherit}' +
      '::highlight(egov-lite-search-current){background:#ff8a00;color:#1f2933}';
    document.head.appendChild(style);
  }

  // タイムアウト付き fetch（ハングした e-Gov API 応答で無限待機しないため）
  function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  function getLiteLawRevisionStorageKey(targetLawId = lawId) {
    return `liteLawCurrentRevision:${targetLawId}`;
  }

  // href に安全なスキームのみ許可（javascript: 等を排除）。相対 URL・フラグメントは許可。
  function safeHref(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (!schemeMatch) return raw;
    const scheme = schemeMatch[1].toLowerCase();
    return (scheme === 'http' || scheme === 'https' || scheme === 'mailto') ? raw : '';
  }

  function toFullWidth(value) {
    return String(value || '').replace(/[0-9]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xFEE0));
  }

  function numToKanjiStr(num) {
    const n = Number(num);
    if (!Number.isInteger(n) || n <= 0 || n >= 1000) return '';
    const ones = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    const h = Math.floor(n / 100);
    const t = Math.floor((n % 100) / 10);
    const o = n % 10;
    let text = '';
    if (h) text += `${h === 1 ? '' : ones[h]}百`;
    if (t) text += `${t === 1 ? '' : ones[t]}十`;
    if (o) text += ones[o];
    return text;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeCopyText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([。、，．！？；：])/g, '$1')
      .trim();
  }

  function ownCopyText(el, excludedSelector = '') {
    if (!el) return '';
    const clone = el.cloneNode(true);
    if (excludedSelector) clone.querySelectorAll(excludedSelector).forEach((node) => node.remove());
    return normalizeCopyText(clone.textContent || '');
  }

  function buildItemCopyLines(el) {
    const lines = [];
    const num = normalizeCopyText(el.querySelector(':scope > .law-num')?.textContent || '');
    const body = el.children[1] || null;
    const text = ownCopyText(body, '.law-subitem');
    const line = normalizeCopyText([num, text].filter(Boolean).join(' '));
    if (line) lines.push(line);
    el.querySelectorAll(':scope > div:nth-child(2) > .law-subitem').forEach((subitem) => {
      lines.push(...buildItemCopyLines(subitem));
    });
    return lines;
  }

  function buildParagraphCopyLines(paragraph) {
    const lines = [];
    const num = normalizeCopyText(paragraph.querySelector(':scope > .law-num')?.textContent || '');
    const body = paragraph.children[1] || null;
    const text = ownCopyText(body, '.law-item,.law-subitem');
    const line = normalizeCopyText([num, text].filter(Boolean).join(' '));
    if (line) lines.push(line);
    paragraph.querySelectorAll(':scope > div:nth-child(2) > .law-item').forEach((item) => {
      lines.push(...buildItemCopyLines(item));
    });
    return lines;
  }

  function buildArticleCopyText(article) {
    const leadLines = [
      normalizeCopyText(article.querySelector(':scope > .article-caption')?.textContent || ''),
      normalizeCopyText(article.querySelector(':scope > .article-title')?.textContent || ''),
    ].filter(Boolean);
    const paragraphLines = Array.from(article.querySelectorAll(':scope > .law-paragraph'))
      .flatMap((paragraph) => buildParagraphCopyLines(paragraph))
      .filter(Boolean);
    return [...leadLines, ...paragraphLines]
      .filter(Boolean)
      .join('\n');
  }

  function buildParagraphCopyText(paragraph) {
    return buildParagraphCopyLines(paragraph).filter(Boolean).join('\n');
  }

  function childElements(el, tagName = '') {
    return Array.from(el?.children || []).filter((child) => !tagName || child.tagName === tagName);
  }

  function firstChildOfTag(el, tagName) {
    return childElements(el, tagName)[0] || null;
  }

  function getNodeText(el) {
    if (!(el instanceof Element)) return normalizeText(el?.textContent || '');
    const clone = el.cloneNode(true);
    clone.querySelectorAll('Rt,rt,rp').forEach((node) => node.remove());
    return normalizeText(clone.textContent || '');
  }

  function safeIdPart(value) {
    return String(value || '').replace(/[^\p{Letter}\p{Number}_-]+/gu, '-').replace(/^-+|-+$/g, '') || Math.random().toString(36).slice(2);
  }

  function getAnchorId(base) {
    const count = (anchorCounts.get(base) || 0) + 1;
    anchorCounts.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  }

  function getArticleId(num, scope = '') {
    const prefix = scope ? `${safeIdPart(scope)}-` : '';
    return getAnchorId(`${prefix}article-${safeIdPart(num)}`);
  }

  function getChildId(prefix, articleNum, childNum, itemNum = '', scope = '') {
    return getAnchorId([scope, prefix, articleNum, childNum, itemNum].filter(Boolean).map(safeIdPart).join('-'));
  }

  function getLiteProvisionScope(element) {
    const supplementary = element instanceof Element ? element.closest('SupplProvision') : null;
    if (!supplementary) return '';
    const provisions = Array.from(supplementary.ownerDocument.querySelectorAll('SupplProvision'));
    const index = provisions.indexOf(supplementary);
    return index <= 0 ? 'Sp' : `Sp_${index + 1}`;
  }

  function getLiteScopeDataAttribute(scope) {
    return scope ? ` data-reference-scope="${escapeHtml(scope)}"` : '';
  }

  function renderInline(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return renderInternalArticleReferenceText(node.nodeValue || '', node.parentElement);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return '';
    const lowerTag = tag.toLowerCase();
    if (/^(LawRef|ArticleRef|ParagraphRef|ItemRef)$/i.test(tag)) {
      const children = renderInlineChildren(node) || escapeHtml(getNodeText(node));
      const refLawId = node.getAttribute('LawId') || node.getAttribute('lawId') || node.getAttribute('TargetLawId') || '';
      const refHref = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
      const href = safeHref(refHref || (refLawId ? `https://laws.e-gov.go.jp/law/${encodeURIComponent(refLawId)}` : ''));
      return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${children}</a>` : children;
    }
    if (INLINE_ALLOWED.has(lowerTag)) {
      const children = renderInlineChildren(node);
      if (!children) return '';
      if (lowerTag === 'a') {
        const href = safeHref(node.getAttribute('href') || node.getAttribute('xlink:href') || '#') || '#';
        const id = node.getAttribute('id') || node.getAttribute('name') || '';
        return `<a${id ? ` id="${escapeHtml(id)}"` : ''} href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${children}</a>`;
      }
      return `<${lowerTag}>${children}</${lowerTag}>`;
    }
    if (tag === 'ArithFormula') return `<strong>${escapeHtml(getNodeText(node))}</strong>`;
    if (tag === 'Ruby') {
      return Array.from(node.childNodes)
        .filter((child) => !(child.nodeType === Node.ELEMENT_NODE && child.tagName === 'Rt'))
        .map(renderInline)
        .join('');
    }
    if (tag === 'Line') return `${renderInlineChildren(node)}<br>`;
    if (tag === 'Column' || tag === 'TableColumn') {
      const html = renderInlineChildren(node).trim();
      return html ? `<span class="law-column">${html}</span>` : '';
    }
    return renderInlineChildren(node);
  }

  function isExternalLawArticleReference(text, index) {
    const prefix = String(text || '').slice(Math.max(0, index - 80), index).replace(/\s+/g, '');
    const lawNamePattern = /(?:法律|法|政令|府令|省令|規則|条例)(?:（[^）]*）)?の?$/;
    if (!lawNamePattern.test(prefix)) return false;
    return !/(?:この|本)(?:法律|法|政令|府令|省令|規則|条例)(?:（[^）]*）)?の?$/.test(prefix);
  }

  function renderInternalArticleReferenceText(text, contextElement = null) {
    const source = String(text || '');
    if (!renderContextLawId || !source.includes('条')) return escapeHtml(source);
    const number = '[0-9０-９〇零一二三四五六七八九十百千万]+';
    const pattern = new RegExp(
      `第(${number})条(?:の(${number}))?` +
      `(?:(?:第(${number})項)(?:第(${number})号)?|第(${number})号|から第?(${number})条(?:の(${number}))?まで)?`,
      'g'
    );
    let html = '';
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) {
      html += escapeHtml(source.slice(lastIndex, match.index));
      const article = parseJapaneseReferenceNumber(match[1]);
      const branch = match[2] ? parseJapaneseReferenceNumber(match[2]) : 0;
      const paragraph = match[3] ? parseJapaneseReferenceNumber(match[3]) : (match[5] ? 1 : 0);
      const itemSource = match[4] || match[5];
      const item = itemSource ? parseJapaneseReferenceNumber(itemSource) : 0;
      const hasInvalidNumber = !Number.isInteger(article) ||
        (match[2] && !Number.isInteger(branch)) ||
        (match[3] && !Number.isInteger(paragraph)) ||
        (itemSource && !Number.isInteger(item));
      if (hasInvalidNumber || isExternalLawArticleReference(source, match.index)) {
        html += escapeHtml(match[0]);
      } else {
        const articlePath = [article, branch || ''].filter(Boolean).join('_');
        const prefix = source.slice(Math.max(0, match.index - 12), match.index).replace(/\s+/g, '');
        const scope = /附則$/.test(prefix) ? (getLiteProvisionScope(contextElement) || 'Sp') : '';
        const href = buildLiteProvisionHref(articlePath, paragraph, item, scope);
        html += `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(match[0])}</a>`;
      }
      lastIndex = pattern.lastIndex;
    }
    return html + escapeHtml(source.slice(lastIndex));
  }

  function buildLiteProvisionHref(article, paragraph = '', item = '', scope = '') {
    if (!article) return '';
    const articlePath = String(article).replace(/-/g, '_');
    const paragraphPath = paragraph ? `-Pr_${String(paragraph).replace(/-/g, '_')}` : '';
    const itemPath = item ? `-It_${String(item).replace(/-/g, '_')}` : '';
    const pathPrefix = scope ? `${renderContextLawId}-${scope}` : 'Mp';
    return `https://laws.e-gov.go.jp/law/${encodeURIComponent(renderContextLawId)}#${pathPrefix}-At_${articlePath}${paragraphPath}${itemPath}`;
  }

  function getLiteRelativeReferenceHref(node, unit, offset, articles, paragraph = '', item = '') {
    if (!Number.isInteger(offset) || offset === 0) return '';
    const sourceElement = node.parentElement;
    const sourceArticle = sourceElement?.closest('.law-article[data-article-num]');
    if (!sourceArticle) return '';
    const scope = sourceArticle.dataset.referenceScope || '';
    if (unit === '条') {
      const scopedArticles = articles.filter((article) => (article.dataset.referenceScope || '') === scope);
      const sourceIndex = scopedArticles.indexOf(sourceArticle);
      const target = scopedArticles[sourceIndex + offset];
      return buildLiteProvisionHref(target?.dataset?.articleNum || '', paragraph, item, scope);
    }

    const sourceParagraph = sourceElement.closest('.law-paragraph[data-paragraph-num]');
    if (!sourceParagraph) return '';
    const paragraphs = Array.from(sourceArticle.querySelectorAll('.law-paragraph[data-paragraph-num]'))
      .filter((paragraph) => paragraph.closest('.law-article') === sourceArticle);
    if (unit === '項') {
      const sourceIndex = paragraphs.indexOf(sourceParagraph);
      const target = paragraphs[sourceIndex + offset];
      return buildLiteProvisionHref(
        sourceArticle.dataset.articleNum,
        target?.dataset?.paragraphNum || '',
        '',
        scope
      );
    }

    const sourceItem = sourceElement.closest('.law-item[data-item-num], .law-subitem[data-item-num]');
    if (!sourceItem) return '';
    const items = Array.from(sourceParagraph.querySelectorAll('.law-item[data-item-num], .law-subitem[data-item-num]'))
      .filter((item) => item.closest('.law-paragraph') === sourceParagraph);
    const sourceIndex = items.indexOf(sourceItem);
    const target = items[sourceIndex + offset];
    return buildLiteProvisionHref(
      sourceArticle.dataset.articleNum,
      sourceParagraph.dataset.paragraphNum,
      target?.dataset?.itemNum || '',
      scope
    );
  }

  function linkifyLiteRelativeReferences() {
    if (!lawId || !contentEl.querySelector('.law-article')) return;
    const articles = Array.from(contentEl.querySelectorAll('.law-article[data-article-num]'));
    const textNodes = [];
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !/[前次]/.test(node.textContent || '')) return NodeFilter.FILTER_SKIP;
        if (parent.closest('a, button, script, style, .law-title, .law-heading, .article-title, .article-caption')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    const numberPattern = '[0-9０-９〇零一二三四五六七八九十百千万]+';
    const pattern = new RegExp(
      `前(${numberPattern})(条|項|号)|((?:前|次)条)(?:(?:第(${numberPattern})項)(?:第(${numberPattern})号)?|第(${numberPattern})号)?`,
      'g'
    );
    textNodes.forEach((textNode) => {
      const text = textNode.textContent || '';
      pattern.lastIndex = 0;
      let match;
      let lastIndex = 0;
      let changed = false;
      const fragment = document.createDocumentFragment();
      while ((match = pattern.exec(text))) {
        const isAdjacentArticle = Boolean(match[3]);
        const count = isAdjacentArticle ? 1 : parseJapaneseReferenceNumber(match[1]);
        if (!isAdjacentArticle && (!Number.isInteger(count) || count < 2)) continue;
        const unit = isAdjacentArticle ? '条' : match[2];
        const offset = match[3] === '次条' ? 1 : -count;
        const paragraphSource = match[4];
        const itemSource = match[5] || match[6];
        const paragraph = paragraphSource
          ? parseJapaneseReferenceNumber(paragraphSource)
          : (match[6] ? 1 : 0);
        const item = itemSource ? parseJapaneseReferenceNumber(itemSource) : 0;
        if ((paragraphSource && !Number.isInteger(paragraph)) ||
            (itemSource && !Number.isInteger(item))) continue;
        const href = getLiteRelativeReferenceHref(textNode, unit, offset, articles, paragraph, item);
        if (!href) continue;
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.target = '_blank';
        anchor.rel = 'noreferrer';
        anchor.textContent = match[0];
        fragment.appendChild(anchor);
        lastIndex = pattern.lastIndex;
        changed = true;
      }
      if (!changed) return;
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      textNode.replaceWith(fragment);
    });
  }

  function renderInlineChildren(el) {
    return Array.from(el.childNodes).map(renderInline).join('');
  }

  function renderTextBlock(el, className = 'law-text') {
    const html = renderInlineChildren(el).trim();
    return html ? `<div class="${className}"><p>${html}</p></div>` : '';
  }

  function renderTitle(el, className = 'law-heading') {
    const text = getNodeText(el);
    return text ? `<div class="${className}">${escapeHtml(text)}</div>` : '';
  }

  function renderParagraph(paragraph, articleNum, scope = '') {
    const rawNum = paragraph.getAttribute('Num') || '';
    const num = getNodeText(firstChildOfTag(paragraph, 'ParagraphNum')) || (rawNum && rawNum !== '1' ? rawNum : '');
    const normalizedNum = rawNum || (num ? num : '1');
    const sentence = firstChildOfTag(paragraph, 'ParagraphSentence') || paragraph;
    const id = getChildId('paragraph', articleNum, normalizedNum, '', scope);
    const textHtml = renderTextBlock(sentence);
    const itemHtml = childElements(paragraph, 'Item').map((item) => renderItem(item, articleNum, normalizedNum, scope)).join('');
    return `<div class="law-paragraph" id="${escapeHtml(id)}" data-article-num="${escapeHtml(articleNum)}" data-paragraph-num="${escapeHtml(normalizedNum)}"${getLiteScopeDataAttribute(scope)}>${num ? `<div class="law-num">${escapeHtml(num)}</div>` : '<div class="law-num" aria-hidden="true"></div>'}<div>${textHtml}${itemHtml}</div></div>`;
  }

  function renderItemLike(el, titleTag, sentenceTag, className, articleNum, paragraphNum, parentPath = '', scope = '') {
    const title = getNodeText(firstChildOfTag(el, titleTag)) || el.getAttribute('Num') || '';
    const itemNum = el.getAttribute('Num') || title || parentPath;
    const id = getChildId('item', articleNum, paragraphNum, itemNum, scope);
    const sentence = firstChildOfTag(el, sentenceTag) || el;
    const children = childElements(el)
      .filter((child) => /^Subitem\d+$/.test(child.tagName))
      .map((child) => renderSubitem(child, articleNum, paragraphNum, `${itemNum}-${child.getAttribute('Num') || ''}`, scope))
      .join('');
    return `<div class="${className}" id="${escapeHtml(id)}" data-article-num="${escapeHtml(articleNum)}" data-paragraph-num="${escapeHtml(paragraphNum)}" data-item-num="${escapeHtml(itemNum)}"${getLiteScopeDataAttribute(scope)}>${title ? `<div class="law-num">${escapeHtml(title)}</div>` : '<div class="law-num" aria-hidden="true"></div>'}<div>${renderTextBlock(sentence)}${children}</div></div>`;
  }

  function renderItem(item, articleNum, paragraphNum, scope = '') {
    return renderItemLike(item, 'ItemTitle', 'ItemSentence', 'law-item', articleNum, paragraphNum, '', scope);
  }

  function renderSubitem(subitem, articleNum, paragraphNum, path, scope = '') {
    const level = subitem.tagName.match(/\d+$/)?.[0] || '';
    return renderItemLike(subitem, `Subitem${level}Title`, `Subitem${level}Sentence`, 'law-subitem', articleNum, paragraphNum, path, scope);
  }

  function renderArticle(article, scopeOverride = null) {
    const articleNum = article.getAttribute('Num') || getNodeText(firstChildOfTag(article, 'ArticleTitle')) || '';
    const title = firstChildOfTag(article, 'ArticleTitle');
    const caption = firstChildOfTag(article, 'ArticleCaption');
    const titleText = getNodeText(title) || (articleNum ? `Article ${articleNum}` : 'Article');
    const scope = scopeOverride === null ? getLiteProvisionScope(article) : scopeOverride;
    const id = getArticleId(articleNum || titleText, scope);
    const captionText = getNodeText(caption);
    const paragraphs = childElements(article, 'Paragraph').map((paragraph) => renderParagraph(paragraph, articleNum, scope)).join('');
    return `<section class="law-article" id="${escapeHtml(id)}" data-article-num="${escapeHtml(articleNum)}"${getLiteScopeDataAttribute(scope)}>${captionText ? `<div class="article-caption">${escapeHtml(captionText)}</div>` : ''}${titleText ? `<div class="article-title">${escapeHtml(titleText)}</div>` : ''}${paragraphs || renderTextBlock(article)}</section>`;
  }

  function renderContainer(el) {
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag) || tag === 'TOC') return '';
    if (tag === 'Article') return renderArticle(el);
    if (tag === 'Paragraph') return renderParagraph(el, '', getLiteProvisionScope(el));
    if (tag === 'Item') return renderItem(el, '', '', getLiteProvisionScope(el));
    if (/^Subitem\d+$/.test(tag)) return renderSubitem(el, '', '', '', getLiteProvisionScope(el));
    if (/Title$|Label$/.test(tag)) return renderTitle(el);
    if (tag === 'Sentence' || /Sentence$/.test(tag)) return renderTextBlock(el);
    const childrenHtml = childElements(el)
      .filter((child) => child.tagName !== 'LawNum' && child.tagName !== 'LawBody')
      .map(renderContainer)
      .join('');
    if (!STRUCTURAL_TAGS.has(tag)) return childrenHtml || renderTextBlock(el);
    const className = ({
      Part: 'law-part',
      Chapter: 'law-chapter',
      Section: 'law-section',
      Subsection: 'law-subsection',
      Division: 'law-division',
      SupplProvision: 'law-suppl-provision',
      AppdxTable: 'law-appdx',
      TableStruct: 'law-appdx',
      Preamble: 'law-preamble',
    })[tag] || 'law-block';
    const scope = tag === 'SupplProvision' ? getLiteProvisionScope(el) : '';
    return `<section class="${className}"${getLiteScopeDataAttribute(scope)}>${childrenHtml}</section>`;
  }

  function parseLawFromResponse(doc) {
    const lawDataLaw = doc.querySelector('law_full_text > Law');
    if (lawDataLaw) return lawDataLaw;
    const v1Law = doc.querySelector('LawFullText > Law');
    if (v1Law) return v1Law;
    return doc.querySelector('Law');
  }

  function kanjiToNumber(text) {
    const s = String(text || '').replace(/[第条\s]/g, '').replace(/の.*$/, '');
    if (/^\d+$/.test(s)) return s;
    let total = 0;
    let current = 0;
    for (const ch of s) {
      if (KANJI_DIGITS.has(ch)) {
        current = KANJI_DIGITS.get(ch);
      } else if (ch === '十') {
        total += (current || 1) * 10;
        current = 0;
      } else if (ch === '百') {
        total += (current || 1) * 100;
        current = 0;
      } else if (ch === '千') {
        total += (current || 1) * 1000;
        current = 0;
      }
    }
    total += current;
    return total ? String(total) : '';
  }

  function normalizeArticleKey(value) {
    return String(value || '')
      .replace(/\s+/g, '')
      .replace(/[のノ之]/g, '_')
      .replace(/[-\u2010-\u2015\u2212_]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function articleKeyVariants(value) {
    const raw = String(value || '').trim();
    const normalized = normalizeArticleKey(raw);
    return Array.from(new Set([raw, normalized, normalized.replace(/_/g, '-'), normalized.replace(/_/g, 'の')].filter(Boolean)));
  }

  function jumpKeyVariants(key) {
    const { scope, article, paragraph, item } = splitReferenceTargetKey(String(key || '').trim());
    const suffix = [paragraph, item].filter(Boolean).join('.');
    return articleKeyVariants(article).map((variant) => {
      const scopedArticle = scope ? `${scope}::${variant}` : variant;
      return suffix ? `${scopedArticle}.${suffix}` : scopedArticle;
    });
  }

  function articleKeyToDisplay(value) {
    const parts = normalizeArticleKey(value).split('_').filter(Boolean);
    if (!parts.length) return '';
    return `第${parts[0]}条${parts.slice(1).map((part) => `の${part}`).join('')}`;
  }

  function numToDisplay(raw) {
    if (!raw) return '';
    const { scope, article, paragraph, item } = splitReferenceTargetKey(raw);
    let text = scope ? '附則' : '';
    text += articleKeyToDisplay(article);
    if (paragraph) text += `第${paragraph}項`;
    if (item) text += `第${item}号`;
    return text;
  }

  function buildTocItems(tocEl) {
    tocItems = [];
    if (!tocEl) return;
    const walk = (node, level = 0) => {
      for (const child of childElements(node)) {
        const titleEl = childElements(child).find((el) => /Title$|Label$/.test(el.tagName));
        const title = getNodeText(titleEl);
        const range = getNodeText(firstChildOfTag(child, 'ArticleRange'));
        const match = range.match(/第?([一二三四五六七八九十百千〇零0-9]+)条/);
        const articleNum = match ? kanjiToNumber(match[1]) : '';
        if (title) tocItems.push({ text: range ? `${title} ${range}` : title, articleNum, level });
        walk(child, level + 1);
      }
    };
    walk(tocEl, 0);
  }

  function rebuildArticleIndex() {
    articleIndex = new Map();
    contentEl.querySelectorAll('.law-article[data-article-num]').forEach((article) => {
      const num = article.dataset.articleNum || '';
      const scope = article.dataset.referenceScope || '';
      const keys = articleKeyVariants(num);
      for (const articleKey of keys) {
        const scopedArticleKey = scope ? `${scope}::${articleKey}` : articleKey;
        if (!articleIndex.has(scopedArticleKey)) articleIndex.set(scopedArticleKey, article);
      }
      article.querySelectorAll('[data-paragraph-num], [data-item-num]').forEach((el) => {
        const para = el.dataset.paragraphNum || '';
        const item = el.dataset.itemNum || '';
        for (const articleKey of keys) {
          const scopedArticleKey = scope ? `${scope}::${articleKey}` : articleKey;
          if (para && !articleIndex.has(`${scopedArticleKey}.${para}`)) articleIndex.set(`${scopedArticleKey}.${para}`, el);
          if (para && item && !articleIndex.has(`${scopedArticleKey}.${para}.${item}`)) articleIndex.set(`${scopedArticleKey}.${para}.${item}`, el);
        }
      });
    });
  }

  function getDefinitionAnchorKey(el) {
    if (!(el instanceof Element)) return '';
    const article = el.closest('[data-article-num]')?.dataset.articleNum || '';
    const paragraph = el.closest('[data-paragraph-num]')?.dataset.paragraphNum || '';
    const item = el.closest('[data-item-num]')?.dataset.itemNum || '';
    return [article, paragraph, item].filter(Boolean).join('.');
  }

  function getDefinitionLocationLabel(definition) {
    const key = definition?.key || getDefinitionAnchorKey(definition?.anchorEl);
    return key ? getReferenceTargetLabel(key) : '';
  }

  function buildDefinitionSourceCandidates(article) {
    const scope = article instanceof Element ? article : contentEl;
    return Array.from(scope.querySelectorAll('.law-item, .law-subitem, .law-paragraph, .law-article'))
      .map((el) => ({
        el,
        text: normalizeCopyText(el.textContent || ''),
      }))
      .filter((item) => item.text)
      .sort((a, b) => a.text.length - b.text.length);
  }

  function getDefinitionSourceElement(matchText, candidates) {
    const needle = normalizeCopyText(matchText);
    if (!needle) return null;
    for (const item of candidates || []) {
      if (item.text.includes(needle)) return item.el;
    }
    return null;
  }

  function getDefinitionTargetElement(el) {
    if (!(el instanceof Element)) return null;
    return el.closest('.law-subitem, .law-item, .law-paragraph, .law-article');
  }

  function getDefinitionTargetDepth(el) {
    if (!(el instanceof Element)) return 0;
    if (el.classList.contains('law-subitem')) return 4;
    if (el.classList.contains('law-item')) return 3;
    if (el.classList.contains('law-paragraph')) return 2;
    if (el.classList.contains('law-article')) return 1;
    return 0;
  }

  function buildDefinitionTargetText(el) {
    if (!(el instanceof Element)) return '';
    if (el.classList.contains('law-item') || el.classList.contains('law-subitem')) {
      return buildItemCopyLines(el).filter(Boolean).join('\n');
    }
    if (el.classList.contains('law-paragraph')) return buildParagraphCopyText(el);
    if (el.classList.contains('law-article')) return buildArticleCopyText(el);
    return normalizeCopyText(el.textContent || '');
  }

  function addDefinition(definitions, item) {
    const term = normalizeCopyText(item.term);
    const sourceEl = item.anchorEl;
    const targetEl = getDefinitionTargetElement(sourceEl);
    const definition = buildDefinitionTargetText(targetEl) || normalizeCopyText(item.definition);
    if (term.length < 2 || term.length > 40 || !definition || !targetEl) return;
    const existing = definitions.get(term);
    const next = {
      term,
      definition,
      anchorEl: targetEl,
      sourceEl,
      excludeEl: targetEl,
      key: getDefinitionAnchorKey(targetEl),
      targetDepth: getDefinitionTargetDepth(targetEl),
      sourceType: item.sourceType || 'patternA',
    };
    if (
      !existing ||
      next.targetDepth > (existing.targetDepth || 0) ||
      (next.targetDepth === existing.targetDepth && next.definition.length > existing.definition.length)
    ) {
      definitions.set(term, next);
    }
  }

  function extractListedDefinitionFromItem(item) {
    const body = item.children[1] || item;
    const text = normalizeCopyText(ownCopyText(body, '.law-subitem'));
    const match = text.match(/^([^ 　、。]{2,40})[ 　]+(.{2,})$/);
    if (!match) return null;
    const term = match[1].trim();
    const definition = match[2].trim();
    if (!term || !definition || /[。、]$/.test(term)) return null;
    return { term, definition };
  }

  function extractTermBeforeParentheticalDefinition(text, matchIndex, cleanupPatterns = []) {
    return extractSharedTermBeforeParentheticalDefinition(text, matchIndex, cleanupPatterns, normalizeCopyText);
  }

  function extractInlineAliasDefinition(text, matchIndex, cleanupPatterns = []) {
    return extractSharedInlineAliasDefinition(text, matchIndex, cleanupPatterns, normalizeCopyText);
  }

  function extractDefinitions() {
    const definitions = new Map();
    const articleElements = Array.from(contentEl.querySelectorAll('.law-article'));
    const { patternA, patternC, patternD } = cloneDefinitionPatterns();

    for (const article of articleElements) {
      const text = normalizeCopyText(article.textContent || '');
      const articleCandidates = buildDefinitionSourceCandidates(article);
      let match;
      patternA.lastIndex = 0;
      while ((match = patternA.exec(text))) {
        const anchorEl = getDefinitionSourceElement(match[0], articleCandidates) || article;
        addDefinition(definitions, {
          term: match[2],
          definition: `${match[2]}とは、${match[3]}をいう。`,
          anchorEl,
          sourceType: 'patternA',
        });
      }

      patternD.lastIndex = 0;
      while ((match = patternD.exec(text))) {
        const term = extractTermBeforeParentheticalDefinition(text, match.index, [patternC, patternD]);
        const anchorEl = getDefinitionSourceElement(match[0], articleCandidates) || article;
        addDefinition(definitions, {
          term,
          definition: match[1].replace(/以下同じ。$/, ''),
          anchorEl,
          sourceType: 'patternD',
        });
      }

      patternC.lastIndex = 0;
      while ((match = patternC.exec(text))) {
        const definition = extractInlineAliasDefinition(text, match.index, [patternC, patternD]);
        const anchorEl = getDefinitionSourceElement(match[0], articleCandidates) || article;
        addDefinition(definitions, {
          term: match[1],
          definition,
          anchorEl,
          sourceType: 'patternC',
        });
      }

      if (/用語の意義は、?当該各号に定めるところによる/.test(text)) {
        article.querySelectorAll(':scope .law-item').forEach((item) => {
          const listed = extractListedDefinitionFromItem(item);
          if (!listed) return;
          addDefinition(definitions, {
            term: listed.term,
            definition: `${listed.term}とは、${listed.definition}`,
            anchorEl: item,
            sourceType: 'patternB',
          });
        });
      }
    }

    if (params.get('debugDefs') === '1') {
      console.table(Array.from(definitions.values()).map((def) => ({
        term: def.term,
        definition: def.definition,
        location: getDefinitionLocationLabel(def),
        sourceType: def.sourceType,
      })));
    }
    return definitions;
  }

  function shouldSkipDefinitionTextNode(node, definition) {
    const parent = node.parentElement;
    if (!parent) return true;
    if (parent.closest('a, button, script, style, mark, .law-title, .law-heading, .article-title, .article-caption, .lite-defined-term, .egov-lite-reference-number, .egov-lite-reference-clickable')) return true;
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

  function createLiteDefinitionMatcher(definitions) {
    const defs = Array.from(definitions.values()).sort((a, b) => b.term.length - a.term.length);
    if (!defs.length) return null;
    return {
      byTerm: new Map(defs.map((def) => [def.term, def])),
      pattern: new RegExp(defs.map((def) => escapeRegExp(def.term)).join('|'), 'g'),
    };
  }

  function markDefinedTermsInArticle(article, matcher) {
    if (!(article instanceof Element) || !matcher) return 0;
    const { byTerm, pattern } = matcher;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
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
    let markedCount = 0;

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
        span.className = 'lite-defined-term';
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

  function scheduleNextLiteDefinitionArticle(generation = liteDefinitionGeneration) {
    if (liteDefinitionMarkWorkScheduled || !liteDefinitionMarkQueue.size) return;
    liteDefinitionMarkWorkScheduled = true;
    runWhenIdle(() => {
      if (generation !== liteDefinitionGeneration) return;
      liteDefinitionMarkWorkScheduled = false;
      if (!liteDefTooltipEnabled || !liteDefinitionMatcher) return;
      const article = liteDefinitionMarkQueue.values().next().value;
      if (article) liteDefinitionMarkQueue.delete(article);
      if (article?.isConnected && !liteDefinitionMarkedArticles.has(article)) {
        liteDefinitionMarkedArticles.add(article);
        markDefinedTermsInArticle(article, liteDefinitionMatcher);
      }
      scheduleNextLiteDefinitionArticle(generation);
    }, 180);
  }

  function queueLiteDefinitionArticle(article) {
    if (!(article instanceof Element) || liteDefinitionMarkedArticles.has(article)) return;
    liteDefinitionMarkQueue.add(article);
    scheduleNextLiteDefinitionArticle();
  }

  function observeLiteDefinitionArticles() {
    const articles = Array.from(contentEl.querySelectorAll('.law-article'));
    if (!articles.length) return;
    if (typeof IntersectionObserver !== 'function') {
      articles.forEach(queueLiteDefinitionArticle);
      return;
    }
    const generation = liteDefinitionGeneration;
    liteDefinitionObserver = new IntersectionObserver((entries, observer) => {
      if (generation !== liteDefinitionGeneration || !liteDefTooltipEnabled) return;
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        queueLiteDefinitionArticle(entry.target);
      });
    }, { root: null, rootMargin: '1200px 0px', threshold: 0 });
    articles.forEach((article) => liteDefinitionObserver.observe(article));
  }

  function unwrapElements(selector) {
    contentEl.querySelectorAll(selector).forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    });
  }

  function clearLiteDefinitionTooltips() {
    liteDefinitionApplyGeneration += 1;
    liteDefinitionGeneration += 1;
    liteDefinitionObserver?.disconnect();
    liteDefinitionObserver = null;
    liteDefinitionMatcher = null;
    liteDefinitionMarkQueue.clear();
    liteDefinitionMarkWorkScheduled = false;
    liteDefinitionMarkedArticles = new WeakSet();
    hideLiteTooltip(true);
    liteDefinitionMap = new Map();
    unwrapElements('.lite-defined-term');
  }

  function applyLiteDefinitionTooltips() {
    clearLiteDefinitionTooltips();
    if (!liteDefTooltipEnabled || !contentEl.querySelector('.law-article')) return;
    const startedAt = performance.now();
    liteDefinitionMap = extractDefinitions();
    liteDefinitionMatcher = createLiteDefinitionMatcher(liteDefinitionMap);
    observeLiteDefinitionArticles();
    console.debug(`[e-Gov Enhancer] Lite 定義用語ガイド: extract ${(performance.now() - startedAt).toFixed(1)}ms (${liteDefinitionMap.size} terms / lazy marking)`);
  }

  function scheduleApplyLiteDefinitionTooltips() {
    const generation = ++liteDefinitionApplyGeneration;
    runWhenIdle(() => {
      if (generation !== liteDefinitionApplyGeneration || !liteDefTooltipEnabled) return;
      applyLiteDefinitionTooltips();
    }, 900);
  }

  function renderLaw(law, doc) {
    const body = law.querySelector('LawBody') || law;
    lawTitleText = getNodeText(firstChildOfTag(body, 'LawTitle')) || fallbackLawName;
    lawNumText = getNodeText(law.querySelector('LawNum')) || getNodeText(doc.querySelector('law_info > law_num')) || '';
    anchorCounts = new Map();
    buildTocItems(firstChildOfTag(body, 'TOC'));
    const content = childElements(body).map((child) => {
      if (child.tagName === 'LawTitle') return `<h2 class="law-title">${escapeHtml(getNodeText(child))}</h2>`;
      return renderContainer(child);
    }).join('');
    titleEl.innerHTML = `${escapeHtml(lawTitleText)}${lawNumText ? `<span class="viewer-law-num">${escapeHtml(lawNumText)}</span>` : ''}`;
    document.title = lawTitleText;
    metaEl.textContent = lawNumText;
    contentEl.innerHTML = content || '<p class="viewer-error">表示できる条文が見つかりませんでした。</p>';
    liteProvisionItemsCache = null;
    articleBookmarkGutterButtons.clear();
    parenthesesWrapped = false;
    parenSeq = 0;
    activeParenGroup = '';
    parenGroups = new Map();
    document.body.removeAttribute('data-paren-mode');
    syncViewerToggleButtons();
    articleElementsCache = Array.from(contentEl.querySelectorAll('.law-article'));
    linkifyLiteRelativeReferences();
    rebuildArticleIndex();
    renderLiteArticleBookmarkGutters();
    scheduleLiteFavoriteScrollRestore();
    textHighlightController?.contentChanged();
    scheduleApplyLiteDefinitionTooltips();
  }

  async function loadRevisions() {
    if (!lawId) return;
    try {
      const url = `${API_V2_BASE}/law_revisions/${encodeURIComponent(lawId)}?response_format=json`;
      const response = await fetchWithTimeout(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      revisions = Array.isArray(data.revisions) ? data.revisions : [];
      if (!currentRevisionId) {
        currentRevisionId = findCurrentLawRevisionId(revisions);
      }
      renderRevisionSelect();
    } catch (_) {
      revisions = [];
      revisionSelect.innerHTML = '<option value="">現行版</option>';
      revisionSelect.disabled = true;
    }
  }

  function renderRevisionSelect() {
    if (!revisions.length) {
      revisionSelect.innerHTML = '<option value="">現行版</option>';
      revisionSelect.disabled = true;
      return;
    }
    const enforcedRevisionId = findCurrentLawRevisionId(revisions);
    revisionSelect.innerHTML = revisions.map((rev) => {
      const date = rev.amendment_enforcement_date || rev.amendment_scheduled_enforcement_date || '';
      const status = rev.law_revision_id === enforcedRevisionId ? ' 現行' : rev.current_revision_status === 'UnEnforced' ? ' 未施行' : '';
      const label = `${date || '日付不明'}${status} / ${rev.amendment_law_num || rev.amendment_law_title || rev.law_revision_id}`;
      return `<option value="${escapeHtml(rev.law_revision_id)}">${escapeHtml(label)}</option>`;
    }).join('');
    revisionSelect.disabled = false;
    if (currentRevisionId) revisionSelect.value = currentRevisionId;
  }

  function parseLawXmlForRender(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML parse error');
    const law = parseLawFromResponse(doc);
    if (!law) throw new Error('Law XML was not found');
    const body = law.querySelector('LawBody') || law;
    return {
      doc,
      law,
      signature: getNormalizedTextSignature(new XMLSerializer().serializeToString(body)),
    };
  }

  function renderParsedLawXml({ doc, law, signature }) {
    renderLaw(law, doc);
    return signature;
  }

  function renderLawXml(xmlText) {
    return renderParsedLawXml(parseLawXmlForRender(xmlText));
  }

  async function loadLiteLawDirectly() {
    // バックグラウンドが旧版のままでも表示できるよう、従来の安全な取得順を残す。
    await loadRevisions();
    const target = currentRevisionId || lawId;
    const asOf = currentRevisionId ? '' : getJapanDateString();
    const response = await fetchWithTimeout(getLiteLawDataUrl(target, asOf), { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xmlText = await response.text();
    if (!xmlText.trim()) throw new Error('Law XML was empty');
    await cacheLiteLawXml(target, xmlText);
    if (!revisionIdParam && currentRevisionId) {
      const revisionStorageKey = getLiteLawRevisionStorageKey();
      await chrome.storage.local.set({ [revisionStorageKey]: currentRevisionId }).catch(() => {});
    }
    return { ok: true, cacheTarget: target, currentRevisionId, revisions };
  }

  async function finishLawLoad() {
    if (externalReferencesEnabled) {
      const { includeExternal } = getReverseReferenceScopeFlags(reverseReferenceScope);
      applyExternalReferenceLinksForLaw(includeExternal ? await getLawReferencesData(lawId) : {});
    } else {
      const stored = await chrome.storage.local.get([EXTERNAL_REFERENCES_AUTO_ENABLE_KEY]).catch(() => ({}));
      if (stored[EXTERNAL_REFERENCES_AUTO_ENABLE_KEY] === true && externalReferencesAutoEnable) {
        runWhenIdle(() => enableExternalReferenceLinks(), 600);
      }
    }
    await refreshFavoriteButton();
  }

  async function loadLaw() {
    if (!lawId) {
      articleElementsCache = [];
      contentEl.innerHTML = '<p class="viewer-error">法令IDが指定されていません。</p>';
      return;
    }
    articleElementsCache = [];
    contentEl.innerHTML = '<p class="viewer-status">e-Gov APIから条文XMLを読み込んでいます...</p>';
    let renderedTarget = '';
    let renderedSignature = '';
    try {
      // 先行取得と同じバックグラウンド処理に合流させ、改正履歴と本文を並列取得する。
      const liveLoadPromise = chrome.runtime.sendMessage({
        type: 'egov-load-lite-law',
        lawId,
        revisionId: revisionIdParam,
      }).catch((error) => ({ ok: false, error: error?.message || String(error || '') }));

      // 保存済みXMLがあれば、ネットワーク確認を待たずに即座に表示する。
      const revisionStorageKey = getLiteLawRevisionStorageKey();
      const stored = await chrome.storage.local.get([revisionStorageKey]).catch(() => ({}));
      const cachedTarget = revisionIdParam || stored[revisionStorageKey] || lawId;
      const cachedXml = await readCachedLiteLawXml(cachedTarget);
      if (cachedXml) {
        renderedSignature = renderLawXml(cachedXml);
        renderedTarget = cachedTarget;
        jumpToInitialHash();
      }

      let result = await liveLoadPromise;
      if (!result?.ok) {
        try {
          result = await loadLiteLawDirectly();
        } catch (fallbackError) {
          if (!renderedTarget) {
            throw new Error(result?.error || fallbackError?.message || 'Law XML could not be loaded');
          }
        }
      }
      if (!result?.ok) {
        if (!renderedTarget) throw new Error(result?.error || 'Law XML could not be loaded');
      } else {
        revisions = Array.isArray(result.revisions) ? result.revisions : [];
        currentRevisionId = revisionIdParam || result.currentRevisionId || currentRevisionId;
        renderRevisionSelect();
        if (!renderedTarget || renderedTarget !== result.cacheTarget) {
          const freshXml = await readCachedLiteLawXml(result.cacheTarget);
          if (!freshXml) throw new Error('Cached law XML could not be read');
          const freshLaw = parseLawXmlForRender(freshXml);
          // The cache key can change from the law ID to its revision ID even when LawBody is identical.
          // Avoid replacing the live DOM in that case so an open selection popup and its Range stay valid.
          if (!renderedTarget || freshLaw.signature !== renderedSignature) {
            renderedSignature = renderParsedLawXml(freshLaw);
            jumpToInitialHash();
          }
          renderedTarget = result.cacheTarget;
        }
      }

      await finishLawLoad();
    } catch (error) {
      if (!renderedTarget) {
        articleElementsCache = [];
        contentEl.innerHTML = `<p class="viewer-error">条文の読み込みに失敗しました。${escapeHtml(error.message || '')}</p>`;
      }
    }
  }

  function isInputActive() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function createDialog(title, { wide = false, deferBookmarkRender = false } = {}) {
    closeDialog({ deferBookmarkRender });
    const overlay = document.createElement('div');
    overlay.className = 'lite-overlay';
    overlay.innerHTML = `
      <div class="lite-dialog${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
        <div class="lite-dialog-header">
          <div>${escapeHtml(title)}</div>
          <button class="lite-close" type="button" aria-label="閉じる">x</button>
        </div>
        <div class="lite-dialog-body"></div>
      </div>
    `;
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) closeDialog(); });
    overlay.querySelector('.lite-close').addEventListener('click', closeDialog);
    document.body.appendChild(overlay);
    activeDialog = overlay;
    return overlay.querySelector('.lite-dialog');
  }

  function closeDialog({ deferBookmarkRender = false } = {}) {
    const closingBookmarkDialog = activeDialog?.dataset.dialogType === 'bookmarks';
    if (activeDialog) {
      if (activeDialog.dataset.dialogType === 'search') clearSearchMarks();
      activeDialog.remove();
      activeDialog = null;
    }
    setProvisionSelection(null);
    if (!closingBookmarkDialog || deferBookmarkRender) return;
    articleBookmarkDialogSessionActive = false;
    if (!articleBookmarkGuttersDirty) return;
    articleBookmarkGuttersDirty = false;
    articleBookmarkGutterSignature = getArticleBookmarkGutterSignature(articleBookmarksCache);
    renderLiteArticleBookmarkGutters();
  }

  function showToast(message) {
    let el = document.getElementById('lite-indicator');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lite-indicator';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.display = 'block';
    clearTimeout(indicatorTimer);
    indicatorTimer = setTimeout(() => { el.style.display = 'none'; }, 1600);
  }

  function setFocusedPane(pane) {
    focusedPane = pane === 'right' && compareMode ? 'right' : 'left';
    leftPaneEl.classList.toggle('is-focused', focusedPane === 'left');
    rightPaneEl.classList.toggle('is-focused', focusedPane === 'right');
    if (focusedPane === 'right') {
      const input = rightPaneEl.querySelector('#compare-search-input');
      const frame = rightPaneEl.querySelector('.compare-frame');
      (input || frame || rightPaneEl).focus();
    } else {
      leftPaneEl.focus();
    }
  }

  function buildViewerUrlForLaw(targetLawId, lawName = '') {
    const urlParams = new URLSearchParams();
    urlParams.set('lawId', targetLawId);
    urlParams.set('lawName', lawName || targetLawId);
    urlParams.set('sourceUrl', `https://laws.e-gov.go.jp/law/${targetLawId}`);
    urlParams.set('embedded', '1');
    return chrome.runtime.getURL(`viewer.html?${urlParams.toString()}`);
  }

  function renderCompareSearch() {
    const initQuery = cleanLawNameForSearch(lawTitleText);
    rightPaneEl.innerHTML = `
      <div class="compare-search">
        <div class="compare-search-row">
          <input id="compare-search-input" type="search" autocomplete="off" value="${escapeHtml(initQuery)}" placeholder="関連法令を検索">
          <button id="compare-search-button" type="button">検索</button>
        </div>
        <div class="compare-status" id="compare-status">法令名を入力して検索してください</div>
        <div class="compare-results" id="compare-results"></div>
      </div>
    `;
    const input = rightPaneEl.querySelector('#compare-search-input');
    const button = rightPaneEl.querySelector('#compare-search-button');
    const run = () => runCompareSearch(input.value.trim());
    button.addEventListener('click', run);
    input.addEventListener('input', () => {
      if (compareFocusedIndex >= 0) compareResultButtons[compareFocusedIndex]?.classList.remove('is-focused');
      compareFocusedIndex = -1;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (compareFocusedIndex >= 0 && compareResults[compareFocusedIndex]) openCompareResult(compareFocusedIndex);
        else run();
      }
      else if (event.key === 'ArrowDown') { event.preventDefault(); focusCompareResult(compareFocusedIndex + 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); focusCompareResult(compareFocusedIndex - 1); }
    });
    const resultsEl = rightPaneEl.querySelector('#compare-results');
    resultsEl.addEventListener('click', (event) => {
      const buttonEl = event.target.closest('.compare-result');
      if (!buttonEl) return;
      openCompareResult(Number(buttonEl.dataset.index));
    });
    resultsEl.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'n') { event.preventDefault(); focusCompareResult(compareFocusedIndex + 1); }
      else if (event.key === 'ArrowUp' || event.key === 'p') { event.preventDefault(); focusCompareResult(compareFocusedIndex - 1); }
      else if (event.key === 'Enter') { event.preventDefault(); openCompareResult(compareFocusedIndex); }
    });
    if (initQuery) runCompareSearch(initQuery);
  }

  async function runCompareSearch(query) {
    const status = rightPaneEl.querySelector('#compare-status');
    const resultsEl = rightPaneEl.querySelector('#compare-results');
    if (!query) {
      status.textContent = '検索語を入力してください';
      resultsEl.innerHTML = '';
      compareResults = [];
      compareResultButtons = [];
      compareFocusedIndex = -1;
      return;
    }
    status.textContent = '検索中...';
    resultsEl.innerHTML = '';
    compareResults = [];
    compareResultButtons = [];
    compareFocusedIndex = -1;
    try {
      const url = `${API_V2_BASE}/laws?law_title=${encodeURIComponent(query)}&limit=31&response_format=json`;
      const response = await fetchWithTimeout(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      compareResults = extractLaws(await response.json()).map(getLawFields).filter((law) => law.lawId);
      status.textContent = compareResults.length ? `${compareResults.length}件` : '一致なし';
      resultsEl.innerHTML = compareResults.map((law, index) => `
        <button class="compare-result" type="button" data-index="${index}">
          <span class="compare-result-name">${escapeHtml(law.lawName || law.lawId)}</span>
          ${law.lawNum ? `<span class="compare-result-num">${escapeHtml(law.lawNum)}</span>` : ''}
        </button>
      `).join('');
      compareResultButtons = Array.from(resultsEl.querySelectorAll('.compare-result'));
      if (compareResults.length) focusCompareResult(0);
    } catch (error) {
      status.textContent = `検索に失敗しました: ${error.message || ''}`;
    }
  }

  function focusCompareResult(index) {
    if (!compareResults.length) return;
    const previous = compareFocusedIndex;
    compareFocusedIndex = (index + compareResults.length) % compareResults.length;
    if (previous >= 0) compareResultButtons[previous]?.classList.remove('is-focused');
    const current = compareResultButtons[compareFocusedIndex];
    if (!current) return;
    current.classList.add('is-focused');
    current.focus({ preventScroll: true });
    current.scrollIntoView({ block: 'nearest' });
  }

  function openCompareResult(index) {
    const law = compareResults[index];
    if (!law?.lawId) return;
    rightPaneEl.innerHTML = `<iframe class="compare-frame" title="${escapeHtml(law.lawName || law.lawId)}" src="${escapeHtml(buildViewerUrlForLaw(law.lawId, law.lawName))}"></iframe>`;
    setFocusedPane('right');
  }

  function toggleCompareMode(force) {
    compareMode = typeof force === 'boolean' ? force : !compareMode;
    document.body.dataset.compareMode = compareMode ? 'on' : 'off';
    compareModeButton.classList.toggle('is-active', compareMode);
    contentWidthSelect.disabled = compareMode;
    if (compareMode) {
      renderCompareSearch();
      setFocusedPane('right');
    } else {
      rightPaneEl.innerHTML = '';
      setFocusedPane('left');
    }
    refreshReferenceViewerPopupLayout();
  }

  function pushHistory(history, value) {
    pushSharedHistory(history, value, 30);
  }

  function buildHistoryDropdown(input, history, onSelect) {
    const dropdown = document.createElement('div');
    dropdown.className = 'lite-history';
    input.parentElement.insertAdjacentElement('afterend', dropdown);
    let index = -1;
    function render() {
      dropdown.innerHTML = history.map((item, i) => `<div class="lite-history-item${i === index ? ' is-focused' : ''}" data-index="${i}">${escapeHtml(item)}</div>`).join('');
    }
    function show() {
      if (!history.length) return;
      index = Math.max(0, index);
      render();
      dropdown.classList.add('is-visible');
    }
    function hide() {
      dropdown.classList.remove('is-visible');
      index = -1;
      render();
    }
    function move(delta) {
      if (!history.length) return;
      index = (Math.max(0, index) + delta + history.length) % history.length;
      render();
    }
    function current() {
      return index >= 0 ? history[index] : null;
    }
    dropdown.addEventListener('mousedown', (event) => {
      const item = event.target.closest('.lite-history-item');
      if (!item) return;
      event.preventDefault();
      const value = history[Number(item.dataset.index)];
      hide();
      onSelect(value);
    });
    return { show, hide, move, current, isVisible: () => dropdown.classList.contains('is-visible') };
  }

  function findJumpTarget(key) {
    for (const variant of jumpKeyVariants(key)) {
      if (articleIndex.has(variant)) return articleIndex.get(variant);
    }
    const { scope, article, paragraph, item } = splitReferenceTargetKey(key);
    if ((paragraph || item) && article) {
      const articleKey = scope ? `${scope}::${article}` : article;
      if (articleIndex.has(articleKey)) return articleIndex.get(articleKey);
      for (const variant of articleKeyVariants(article)) {
        const scopedVariant = scope ? `${scope}::${variant}` : variant;
        if (articleIndex.has(scopedVariant)) return articleIndex.get(scopedVariant);
      }
    }
    return null;
  }

  function pushJumpHistory(key) {
    if (!key) return;
    if (articleJumpCursor >= 0 && articleJumpHistory[articleJumpCursor] === key) return;
    const insertAt = articleJumpCursor + 1;
    articleJumpHistory.splice(insertAt, 0, key);
    articleJumpCursor = insertAt;
    if (articleJumpHistory.length > 200) {
      articleJumpHistory.shift();
      articleJumpCursor = Math.max(0, articleJumpCursor - 1);
    }
  }

  function showJumpHistoryIndicator() {
    if (articleJumpCursor < 0 || !articleJumpHistory.length) return;
    let ind = document.getElementById('lite-jump-indicator');
    if (!ind) {
      ind = document.createElement('div');
      ind.id = 'lite-jump-indicator';
      document.body.appendChild(ind);
    }
    const current = articleJumpHistory[articleJumpCursor];
    const pos = `${articleJumpCursor + 1} / ${articleJumpHistory.length}`;
    const context = 5;
    const itemOpacity = (dist) => [0, 0.68, 0.50, 0.36, 0.24, 0.14][Math.min(dist, 5)];
    const prev = [];
    for (let i = Math.max(0, articleJumpCursor - context); i < articleJumpCursor; i += 1) prev.push(articleJumpHistory[i]);
    const next = [];
    for (let i = articleJumpCursor + 1; i <= Math.min(articleJumpHistory.length - 1, articleJumpCursor + context); i += 1) next.push(articleJumpHistory[i]);
    const prevHtml = prev.map((num, idx) => {
      const dist = prev.length - idx;
      return `<span class="lite-jump-ind-near" style="opacity:${itemOpacity(dist)}">${escapeHtml(numToDisplay(num))}</span>`;
    }).join('');
    const nextHtml = next.map((num, idx) => {
      const dist = idx + 1;
      return `<span class="lite-jump-ind-near" style="opacity:${itemOpacity(dist)}">${escapeHtml(numToDisplay(num))}</span>`;
    }).join('');
    ind.innerHTML = `
      <div class="lite-jump-ind-inner">
        <div class="lite-jump-ind-context lite-jump-ind-prev">${prevHtml}</div>
        <span class="lite-jump-ind-current">${escapeHtml(numToDisplay(current))}<span class="lite-jump-ind-pos">${escapeHtml(pos)}</span></span>
        <div class="lite-jump-ind-context lite-jump-ind-next">${nextHtml}</div>
      </div>
    `;
    ind.style.display = 'flex';
    ind.style.opacity = '1';
    clearTimeout(jumpIndicatorTimer);
    jumpIndicatorTimer = setTimeout(() => {
      ind.style.opacity = '0';
      setTimeout(() => { ind.style.display = 'none'; }, 400);
    }, 2500);
  }

  function jumpToKey(key, record = true) {
    const target = findJumpTarget(key);
    if (!target) return false;
    const returnPosition = record ? getCurrentJumpReturnPosition() : null;
    // 長い項では画面の25%位置が配下の号に入ることがあるため、
    // ジャンプ直後のSpaceは表示位置ではなく明示された条・項・号を対象にする。
    keyboardBookmarkTargetId = target.id || '';
    scrollToElement(target, 'start');
    setTimeout(() => flashJumpTarget(target), scrollBehavior === 'smooth' ? 220 : 0);
    if (record) pushJumpHistory(key);
    showJumpHistoryIndicator();
    if (returnPosition) showJumpReturnButton(returnPosition);
    return true;
  }

  function getReferenceNumberSegmentVariants(raw) {
    const value = String(raw || '').trim();
    const variants = new Set();
    if (!value) return [];
    variants.add(value);
    variants.add(value.replace(/-/g, 'の').replace(/_/g, 'の'));
    variants.add(toFullWidth(value));
    const numeric = /^\d+$/.test(value) ? Number(value) : NaN;
    if (Number.isInteger(numeric) && numeric > 0) {
      variants.add(String(numeric));
      variants.add(toFullWidth(String(numeric)));
      const kanji = numToKanjiStr(numeric);
      if (kanji) variants.add(kanji);
    }
    return Array.from(variants);
  }

  function getReferenceNumberCandidates(parts) {
    const level = parts.item ? 'item' : parts.paragraph ? 'paragraph' : 'article';
    const raw = level === 'item' ? parts.item : level === 'paragraph' ? parts.paragraph : parts.article;
    const suffix = level === 'item' ? '号' : level === 'paragraph' ? '項' : '条';
    const rawText = String(raw || '').trim();
    if (!rawText) return [];

    const segmentSets = rawText.split(/[-_]/).map(getReferenceNumberSegmentVariants);
    const combined = [''];
    for (const variants of segmentSets) {
      const current = combined.splice(0);
      for (const prefix of current) {
        for (const variant of variants) combined.push(prefix ? `${prefix}の${variant}` : variant);
      }
    }

    const candidates = new Set();
    for (const variant of combined) {
      if (!variant) continue;
      candidates.add(variant);
      candidates.add(`第${variant}${suffix}`);
    }
    if (segmentSets.length > 1) {
      const [firstSet, ...restSets] = segmentSets;
      const restCombined = [''];
      for (const variants of restSets) {
        const current = restCombined.splice(0);
        for (const prefix of current) {
          for (const variant of variants) restCombined.push(prefix ? `${prefix}の${variant}` : variant);
        }
      }
      for (const first of firstSet || []) {
        for (const rest of restCombined) {
          if (first && rest) candidates.add(`第${first}${suffix}の${rest}`);
        }
      }
    }
    return Array.from(candidates).sort((a, b) => b.length - a.length);
  }

  function ensureReferenceNumberElement(root, parts) {
    if (!(root instanceof Element)) return null;
    if (root.classList.contains('egov-lite-reference-number')) return root;
    const existing = root.querySelector(':scope > .egov-lite-reference-number') ||
      root.querySelector('.egov-lite-reference-number');
    if (existing instanceof Element) return existing;

    const candidates = getReferenceNumberCandidates(parts).map(escapeRegExp);
    if (!candidates.length) return null;
    const pattern = new RegExp(`^(\\s*(?:${candidates.join('|')}))`);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent || !pattern.test(node.textContent)) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('.egov-lite-reference-number, a, button, script, style')) return NodeFilter.FILTER_REJECT;
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
    span.className = 'egov-lite-reference-number';
    span.textContent = text.slice(start, end);
    const fragment = document.createDocumentFragment();
    if (start > 0) fragment.appendChild(document.createTextNode(text.slice(0, start)));
    fragment.appendChild(span);
    if (end < text.length) fragment.appendChild(document.createTextNode(text.slice(end)));
    node.parentNode.replaceChild(fragment, node);
    return span;
  }

  function findLiteReferenceTargetElement(targetKey) {
    const parts = getReferenceDomParts(splitReferenceTargetKey(targetKey));
    if (!parts.article) return null;
    const articleKey = parts.scope ? `${parts.scope}::${parts.article}` : parts.article;
    if (parts.item) return findJumpTarget(`${articleKey}.${parts.paragraph || '1'}.${parts.item}`);
    if (parts.paragraph) return findJumpTarget(`${articleKey}.${parts.paragraph}`);
    return findJumpTarget(articleKey);
  }

  function findLiteReferenceClickableElement(target, targetKey) {
    if (!(target instanceof Element)) return null;
    const parts = getReferenceDomParts(splitReferenceTargetKey(targetKey));
    const numberRoot = parts.item || parts.paragraph
      ? target.querySelector(':scope > .law-num')
      : target.querySelector(':scope > .article-title');
    return ensureReferenceNumberElement(numberRoot || target, parts);
  }

  function getReferenceSourceLabel(source) {
    if (source?.isInternalLawSource) {
      return [source.sourceProvisionLabel, source.sourceProvisionText].filter(Boolean).join(' ');
    }
    const title = String(source?.sourceLawTitle || source?.sourceLawId || '').trim();
    const path = formatProvisionSourcePathFromEgovUrl(source?.sourceUrl, location.href);
    return [title, path].filter(Boolean).join(' ');
  }

  function hideReferencesPopup() {
    activeReferencesPopup?.cleanupReferencePopup?.();
    activeReferencesPopup?.remove();
    activeReferencesPopup = null;
  }

  function usesReferenceViewerSideLayout() {
    return !compareMode && (document.body.dataset.contentWidth === 'medium' || document.body.dataset.contentWidth === 'narrow');
  }

  function syncReferenceViewerContentAlignment() {
    const hasPopup = [...referenceViewerPopups].some((popup) => popup.isConnected);
    if (hasPopup && usesReferenceViewerSideLayout()) {
      document.body.dataset.referenceViewerOpen = 'true';
    } else {
      delete document.body.dataset.referenceViewerOpen;
    }
  }

  function clearReferenceViewerSidePosition(popup) {
    popup.classList.remove('is-side-positioned', 'is-compact-side');
    popup.style.width = '';
    delete popup.dataset.sidePlacementOrder;
    const rect = popup.getBoundingClientRect();
    const margin = 10;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(rect.top, window.innerHeight - rect.height - margin));
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  function positionReferenceViewerPopup(popup, point = null, forcedOrder = null) {
    syncReferenceViewerContentAlignment();
    if (!usesReferenceViewerSideLayout()) {
      clearReferenceViewerSidePosition(popup);
      positionFixedPopup(popup, point, { offset: 14 });
      return;
    }

    const gap = 14;
    const margin = 10;
    const contentRect = contentEl.getBoundingClientRect();
    let left = Math.ceil(contentRect.right + gap);
    let availableWidth = Math.floor(window.innerWidth - left - margin - 2);
    if (availableWidth < 160) {
      availableWidth = Math.min(780, Math.max(160, window.innerWidth - margin * 2 - 2));
      left = Math.max(margin, window.innerWidth - availableWidth - margin - 2);
    }
    const popupWidth = Math.min(780, availableWidth);
    popup.classList.add('is-side-positioned');
    popup.classList.toggle('is-compact-side', popupWidth < 560);
    popup.style.width = `${popupWidth}px`;
    popup.style.left = `${left}px`;

    const existingOrders = [...referenceViewerPopups]
      .filter((candidate) => candidate !== popup && candidate.isConnected)
      .map((candidate) => Number(candidate.dataset.sidePlacementOrder))
      .filter(Number.isFinite);
    const order = Number.isFinite(forcedOrder)
      ? forcedOrder
      : (existingOrders.length ? Math.max(...existingOrders) + 1 : 0);
    popup.dataset.sidePlacementOrder = String(order);

    const popupHeight = popup.getBoundingClientRect().height;
    const header = document.querySelector('.viewer-header');
    const headerBottom = header && getComputedStyle(header).display !== 'none'
      ? header.getBoundingClientRect().bottom
      : 0;
    const startTop = Math.max(margin, Math.ceil(headerBottom) + 8);
    const step = Math.max(1, popupHeight * 0.25);
    const maxTop = Math.max(startTop, window.innerHeight - popupHeight - margin);
    const slotCount = Math.max(1, Math.floor((maxTop - startTop) / step) + 1);
    const top = Math.min(maxTop, startTop + (order % slotCount) * step);
    popup.style.top = `${top}px`;
  }

  function refreshReferenceViewerPopupLayout() {
    syncReferenceViewerContentAlignment();
    const popups = Array.from(document.querySelectorAll('.egov-lite-reference-viewer-popup'))
      .filter((popup) => referenceViewerPopups.has(popup) && popup.isConnected);
    if (usesReferenceViewerSideLayout()) {
      popups.forEach((popup, index) => positionReferenceViewerPopup(popup, null, index));
    } else {
      popups.forEach(clearReferenceViewerSidePosition);
    }
  }

  function activateReferenceViewerPopup(popup) {
    if (!popup?.isConnected || !referenceViewerPopups.has(popup)) return;
    referenceViewerPopups.delete(popup);
    referenceViewerPopups.add(popup);
    activeReferenceViewerPopup = popup;
    for (const candidate of referenceViewerPopups) {
      candidate.style.zIndex = candidate === popup ? '2147483647' : '2147483646';
    }
  }

  function updateActiveReferenceViewerPopup() {
    activeReferenceViewerPopup = null;
    for (const popup of [...referenceViewerPopups]) {
      if (popup.isConnected) {
        activeReferenceViewerPopup = popup;
      } else {
        referenceViewerPopups.delete(popup);
      }
    }
    for (const popup of referenceViewerPopups) {
      popup.style.zIndex = popup === activeReferenceViewerPopup ? '2147483647' : '2147483646';
    }
  }

  function hideReferenceViewerPopup(popup = activeReferenceViewerPopup) {
    if (!popup) return;
    try {
      if (typeof popup.remove === 'function') {
        popup.remove();
      } else if (!popup.closed) {
        popup.close();
      }
    } catch (_) {}
    referenceViewerPopups.delete(popup);
    updateActiveReferenceViewerPopup();
    syncReferenceViewerContentAlignment();
  }

  function hideUnpinnedReferenceViewerPopups(except = null) {
    for (const popup of [...referenceViewerPopups]) {
      if (popup !== except && popup.dataset.pinned !== 'true') {
        hideReferenceViewerPopup(popup);
      }
    }
  }

  function clearLiteTooltipTimers() {
    clearTimeout(liteTooltipShowTimer);
    clearTimeout(liteTooltipHideTimer);
    liteTooltipShowTimer = 0;
    liteTooltipHideTimer = 0;
  }

  function hideLiteTooltip(immediate = false) {
    clearTimeout(liteTooltipShowTimer);
    const remove = () => {
      activeLiteTooltip?.remove();
      activeLiteTooltip = null;
      liteTooltipPinned = false;
    };
    if (immediate) {
      clearTimeout(liteTooltipHideTimer);
      remove();
      return;
    }
    clearTimeout(liteTooltipHideTimer);
    liteTooltipHideTimer = setTimeout(remove, 200);
  }

  function buildLiteDefinitionBodyHtml(term, definitionText) {
    const escaped = escapeHtml(definitionText);
    const escapedTerm = escapeHtml(term);
    if (!escapedTerm) return escaped;
    return escaped.replace(new RegExp(escapeRegExp(escapedTerm), 'g'), `<mark class="lite-definition-term-highlight">${escapedTerm}</mark>`);
  }

  function moveToLiteDefinitionSource(definition) {
    const returnPosition = getCurrentJumpReturnPosition();
    hideLiteTooltip(true);
    if (definition.key && jumpToKey(definition.key)) return;
    showJumpReturnButton(returnPosition);
    scrollToElement(definition.anchorEl, 'start');
    setTimeout(() => flashJumpTarget(definition.anchorEl), scrollBehavior === 'smooth' ? 220 : 0);
  }

  function showLiteDefinitionTooltip(trigger, activation = 'click') {
    if (!liteDefTooltipEnabled || (defTooltipClickOnly && activation !== 'click')) return;
    const term = trigger?.dataset?.term || '';
    const definition = liteDefinitionMap.get(term);
    if (!definition) return;
    const locationLabel = getDefinitionLocationLabel(definition) || '定義箇所';
    hideLiteTooltip(true);

    const popup = document.createElement('div');
    popup.className = 'lite-definition-tooltip';
    popup.setAttribute('role', 'tooltip');
    liteTooltipPinned = activation === 'click';
    popup.innerHTML = `
      <div class="lite-definition-tooltip-head">
        <button type="button" class="lite-definition-location">定義箇所の${escapeHtml(locationLabel)}に移動する</button>
      </div>
      <div class="lite-definition-body">${buildLiteDefinitionBodyHtml(term, definition.definition)}</div>
    `;
    document.body.appendChild(popup);
    activeLiteTooltip = popup;
    const rect = trigger.getBoundingClientRect();
    positionFixedPopup(popup, { x: rect.left, y: rect.bottom }, { offset: 8 });

    popup.addEventListener('mouseenter', clearLiteTooltipTimers);
    popup.addEventListener('mouseleave', () => {
      if (!liteTooltipPinned) hideLiteTooltip();
    });
    popup.querySelector('.lite-definition-location')?.addEventListener('click', (event) => {
      event.preventDefault();
      moveToLiteDefinitionSource(definition);
    });
  }

  function scheduleLiteDefinitionTooltip(trigger) {
    if (defTooltipClickOnly) return;
    clearLiteTooltipTimers();
    liteTooltipShowTimer = setTimeout(() => showLiteDefinitionTooltip(trigger, 'hover'), 300);
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
      currentLawTitle: lawTitleText,
      classPrefix: 'egov-lite',
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

  function getLawIdFromUrl(url) {
    try {
      return new URL(url, location.href).pathname.match(/\/law\/([^/?#]+)/)?.[1] || '';
    } catch (_) {
      return '';
    }
  }

  function parseProvisionKeyFromEgovUrl(url) {
    return getReferenceTargetKeyFromEgovUrl(url, location.href);
  }

  function buildNormalReferenceSourceUrl(source) {
    const sourceUrl = String(source?.sourceUrl || '').trim();
    if (sourceUrl) {
      try {
        return new URL(sourceUrl, location.href).href;
      } catch (_) {
        return sourceUrl;
      }
    }

    const sourceLawId = source?.sourceLawId || getLawIdFromUrl(source?.sourceUrl || '');
    if (!sourceLawId) return '';
    return `https://laws.e-gov.go.jp/law/${encodeURIComponent(sourceLawId)}`;
  }

  function shouldOpenReferenceSourcePopup(event, sourceLawId) {
    const isDifferentLaw = sourceLawId && sourceLawId !== lawId;
    const scrollMode = isLawRefScrollMode();
    let shouldPopup = !scrollMode;
    if (scrollMode && lawRefOtherLawPopupEnabled && isDifferentLaw) shouldPopup = true;
    return event?.ctrlKey ? !shouldPopup : shouldPopup;
  }

  function normalizeReferenceAsOf(value) {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    return '';
  }

  function getReferenceApiContext(url, resolvedLawId) {
    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch (_) {
      return null;
    }

    const pathMatch = parsed.pathname.match(/^\/law\/([^/?#]+)(?:\/([^/?#]+))?/);
    const targetLawId = decodeURIComponent(pathMatch?.[1] || resolvedLawId || '');
    if (!targetLawId) return null;

    const revisionSegment = decodeURIComponent(pathMatch?.[2] || '');
    const occasionDate = normalizeReferenceAsOf(parsed.searchParams.get('occasion_date'));
    let apiTarget = targetLawId;
    let explicitRevision = false;
    if (/^[A-Za-z0-9]+_\d{8}_[A-Za-z0-9_]+$/.test(revisionSegment)) {
      apiTarget = revisionSegment;
      explicitRevision = true;
    } else if (/^\d{8}_[A-Za-z0-9_]+$/.test(revisionSegment)) {
      apiTarget = `${targetLawId}_${revisionSegment}`;
      explicitRevision = true;
    } else if (!occasionDate && targetLawId === lawId && currentRevisionId) {
      apiTarget = currentRevisionId;
    }

    const asOf = explicitRevision || apiTarget !== targetLawId
      ? ''
      : (occasionDate || getJapanDateString());
    return { parsed, targetLawId, apiTarget, asOf };
  }

  function buildReferenceArticleElm(parts) {
    const article = String(parts?.article || '').replace(/-/g, '_');
    if (!/^\d+(?:_\d+)*$/.test(article)) return '';
    const scope = String(parts?.scope || '');
    if (!scope) return `MainProvision-Article_${article}`;
    const supplement = scope.match(/^Sp(?:_(\d+))?$/);
    if (!supplement) return '';
    return `SupplProvision[${supplement[1] || '1'}]-Article_${article}`;
  }

  function buildReferenceArticleRequest(url, resolvedLawId) {
    const context = getReferenceApiContext(url, resolvedLawId);
    const parts = parseProvisionPathFromEgovUrl(url, location.href);
    const elm = buildReferenceArticleElm(parts);
    if (!context || !parts?.article || !elm) return { context, parts, elm: '', apiUrl: '' };

    const apiUrl = new URL(`${API_V2_BASE}/law_data/${encodeURIComponent(context.apiTarget)}`);
    apiUrl.searchParams.set('response_format', 'xml');
    apiUrl.searchParams.set('law_full_text_format', 'xml');
    apiUrl.searchParams.set('elm', elm);
    if (context.asOf) apiUrl.searchParams.set('asof', context.asOf);
    return { context, parts, elm, apiUrl: apiUrl.href };
  }

  async function loadReferenceArticle(request) {
    if (!request?.apiUrl) throw new Error('Reference article target was not found');
    if (referenceArticleLoadCache.has(request.apiUrl)) {
      return referenceArticleLoadCache.get(request.apiUrl);
    }

    const loadPromise = (async () => {
      const response = await fetchWithTimeout(request.apiUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const xmlText = await response.text();
      const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('Reference article XML parse error');
      const article = doc.querySelector('law_full_text > Article');
      if (!article) {
        const apiMessage = normalizeText(doc.querySelector('error_info > message')?.textContent || '');
        throw new Error(apiMessage || 'Reference article was not returned');
      }
      return {
        article,
        lawTitle: normalizeText(doc.querySelector('revision_info > law_title')?.textContent || ''),
        lawNum: normalizeText(doc.querySelector('law_info > law_num')?.textContent || ''),
        revisionId: normalizeText(doc.querySelector('revision_info > law_revision_id')?.textContent || ''),
      };
    })();

    referenceArticleLoadCache.set(request.apiUrl, loadPromise);
    while (referenceArticleLoadCache.size > 40) {
      referenceArticleLoadCache.delete(referenceArticleLoadCache.keys().next().value);
    }
    loadPromise.catch(() => {
      if (referenceArticleLoadCache.get(request.apiUrl) === loadPromise) {
        referenceArticleLoadCache.delete(request.apiUrl);
      }
    });
    return loadPromise;
  }

  function renderReferenceArticle(article, targetLawId, scope = '') {
    const previousAnchorCounts = anchorCounts;
    const previousRenderContextLawId = renderContextLawId;
    anchorCounts = new Map();
    renderContextLawId = targetLawId;
    try {
      return renderArticle(article, scope);
    } finally {
      anchorCounts = previousAnchorCounts;
      renderContextLawId = previousRenderContextLawId;
    }
  }

  function prefixReferencePopupIds(root, prefix) {
    root.querySelectorAll('[id]').forEach((element) => {
      element.id = `${prefix}-${element.id}`;
    });
  }

  function findReferencePopupTarget(root, parts) {
    const normalizePart = (value) => normalizeArticleKey(value || '');
    const paragraph = normalizePart(parts?.paragraph);
    const item = normalizePart(parts?.item);
    if (item) {
      const itemTarget = Array.from(root.querySelectorAll('.law-item[data-item-num], .law-subitem[data-item-num]'))
        .find((element) => (
          normalizePart(element.dataset.paragraphNum) === (paragraph || '1') &&
          normalizePart(element.dataset.itemNum) === item
        ));
      if (itemTarget) return itemTarget;
    }
    if (paragraph) {
      const paragraphTarget = Array.from(root.querySelectorAll('.law-paragraph[data-paragraph-num]'))
        .find((element) => normalizePart(element.dataset.paragraphNum) === paragraph);
      if (paragraphTarget) return paragraphTarget;
    }
    return null;
  }

  function openReferenceInNewTab(url) {
    chrome.runtime.sendMessage({ type: 'egov-open-law-reference-tab', url })
      .then((result) => {
        if (!result?.ok) throw new Error('Tab could not be opened');
      })
      .catch(() => window.open(url, '_blank', 'noopener'));
  }

  function buildReferenceJumpKey(parts) {
    if (!parts?.article) return '';
    const provision = [parts.article, parts.paragraph, parts.item].filter(Boolean).join('.');
    return parts.scope ? `${parts.scope}::${provision}` : provision;
  }

  function buildReferenceScrollViewerUrl(fullLawUrl, request, lawTitle, revisionId = '') {
    const params = new URLSearchParams();
    params.set('lawId', request.context.targetLawId);
    params.set('lawName', lawTitle || request.context.targetLawId);
    params.set('sourceUrl', fullLawUrl);
    if (revisionId) params.set('revisionId', revisionId);
    const viewerUrl = new URL(chrome.runtime.getURL(`viewer.html?${params.toString()}`));
    viewerUrl.hash = request.context.parsed.hash;
    return viewerUrl.href;
  }

  function scrollToReferenceArticle(fullLawUrl, request, data, popup) {
    const jumpKey = buildReferenceJumpKey(request.parts);
    const canScrollInPlace = request.context.targetLawId === lawId &&
      (!data?.revisionId || data.revisionId === currentRevisionId);
    if (canScrollInPlace) {
      if (popup?.dataset.pinned !== 'true') hideReferenceViewerPopup(popup);
      if (!jumpKey || !jumpToKey(jumpKey)) showToast('対象条文の位置を見つけられませんでした');
      return;
    }
    hideReferenceViewerPopup(popup);
    location.href = buildReferenceScrollViewerUrl(
      fullLawUrl,
      request,
      data?.lawTitle || request.context.targetLawId,
      data?.revisionId || ''
    );
  }

  function setReferenceViewerPinned(popup, pinned) {
    const button = popup.querySelector('.egov-lite-reference-pin');
    popup.dataset.pinned = String(!!pinned);
    button?.classList.toggle('is-active', !!pinned);
    button?.setAttribute('aria-pressed', String(!!pinned));
    if (button) {
      button.title = pinned
        ? 'ピン止め中（外側をクリックしても閉じない）'
        : 'ピン止め（外側のクリックで閉じる）';
      button.setAttribute('aria-label', button.title);
    }
    if (!pinned) {
      hideUnpinnedReferenceViewerPopups(popup);
      activateReferenceViewerPopup(popup);
    }
  }

  function setupReferenceViewerDrag(popup, handle) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button, a, input, select, textarea')) return;
      event.preventDefault();
      const rect = popup.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const pointerId = event.pointerId;
      popup.classList.add('is-dragging');
      handle.setPointerCapture?.(pointerId);

      const move = (moveEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const maxLeft = Math.max(10, window.innerWidth - rect.width - 10);
        const maxTop = Math.max(10, window.innerHeight - rect.height - 10);
        popup.style.left = `${Math.max(10, Math.min(maxLeft, moveEvent.clientX - offsetX))}px`;
        popup.style.top = `${Math.max(10, Math.min(maxTop, moveEvent.clientY - offsetY))}px`;
      };
      const finish = (finishEvent) => {
        if (finishEvent.pointerId !== pointerId) return;
        popup.classList.remove('is-dragging');
        try { handle.releasePointerCapture?.(pointerId); } catch (_) {}
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
    });
  }

  async function showReferenceViewerPopup(source, url, point, resolvedLawId = '') {
    hideUnpinnedReferenceViewerPopups();
    let fullLawUrl;
    try {
      fullLawUrl = new URL(url, location.href).href;
    } catch (_) {
      return;
    }

    const request = buildReferenceArticleRequest(fullLawUrl, resolvedLawId || getLawIdFromUrl(fullLawUrl));
    const targetKey = parseProvisionKeyFromEgovUrl(fullLawUrl);
    const provisionLabel = request.parts?.article ? formatProvisionNumber(request.parts) : '';
    const targetLabel = provisionLabel
      ? `${request.parts.scope ? '附則' : ''}${provisionLabel}`
      : (targetKey ? getReferenceTargetLabel(targetKey) : '対象条文');
    const popupId = `egov-lite-reference-viewer-${++referenceViewerPopupSequence}`;
    const popup = document.createElement('div');
    popup.id = popupId;
    popup.className = 'egov-lite-reference-viewer-popup';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', `${targetLabel}の条文ポップアップ`);
    popup.tabIndex = -1;
    popup.innerHTML = `
      <div class="egov-lite-reference-viewer-head">
        <div class="egov-lite-reference-viewer-heading">
          <div class="egov-lite-reference-viewer-title">${escapeHtml(source?.sourceLawTitle || request.context?.targetLawId || '参照条文')}</div>
          <div class="egov-lite-reference-viewer-meta">${escapeHtml(targetLabel)}</div>
        </div>
        <div class="egov-lite-reference-viewer-actions">
          <button type="button" class="egov-lite-reference-scroll" disabled>スクロールする</button>
          <button type="button" class="egov-lite-reference-open-tab">新しいタブで開く</button>
          <button type="button" class="egov-lite-reference-pin" aria-pressed="false"><span aria-hidden="true">📌</span></button>
          <button type="button" class="egov-lite-reference-close" aria-label="閉じる">×</button>
        </div>
      </div>
      <div class="egov-lite-reference-viewer-body">
        <div class="egov-lite-reference-viewer-status">条文を読み込んでいます...</div>
      </div>
    `;
    document.body.appendChild(popup);
    referenceViewerPopups.add(popup);
    activateReferenceViewerPopup(popup);
    positionReferenceViewerPopup(popup, point);
    popup.focus({ preventScroll: true });

    const body = popup.querySelector('.egov-lite-reference-viewer-body');
    const head = popup.querySelector('.egov-lite-reference-viewer-head');
    const title = popup.querySelector('.egov-lite-reference-viewer-title');
    const meta = popup.querySelector('.egov-lite-reference-viewer-meta');
    const scrollButton = popup.querySelector('.egov-lite-reference-scroll');
    const pinButton = popup.querySelector('.egov-lite-reference-pin');
    let loadedReferenceData = null;
    setReferenceViewerPinned(popup, false);
    setupReferenceViewerDrag(popup, head);
    popup.addEventListener('pointerdown', () => activateReferenceViewerPopup(popup));
    popup.querySelector('.egov-lite-reference-close')?.addEventListener('click', () => hideReferenceViewerPopup(popup));
    scrollButton?.addEventListener('click', () => {
      if (!loadedReferenceData) return;
      scrollToReferenceArticle(fullLawUrl, request, loadedReferenceData, popup);
    });
    popup.querySelector('.egov-lite-reference-open-tab')?.addEventListener('click', () => {
      openReferenceInNewTab(fullLawUrl);
    });
    pinButton?.addEventListener('click', () => {
      setReferenceViewerPinned(popup, popup.dataset.pinned !== 'true');
    });
    popup.addEventListener('click', (event) => {
      event.stopPropagation();
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!anchor || !body.contains(anchor) || !getLawIdFromUrl(anchor.href)) return;
      event.preventDefault();
      if (popup.dataset.pinned !== 'true') hideReferenceViewerPopup(popup);
      openLawReferenceUrl(anchor.href, event);
    });

    if (!request.apiUrl) {
      body.innerHTML = '<div class="egov-lite-reference-viewer-status is-error">対象条文を特定できません。「新しいタブで開く」を使用してください。</div>';
      return;
    }

    try {
      const data = await loadReferenceArticle(request);
      if (!referenceViewerPopups.has(popup) || !popup.isConnected) return;
      loadedReferenceData = data;
      scrollButton.disabled = false;
      title.textContent = data.lawTitle || source?.sourceLawTitle || request.context.targetLawId;
      meta.textContent = [data.lawNum, targetLabel].filter(Boolean).join('　');

      const articleHost = document.createElement('div');
      articleHost.className = 'egov-lite-reference-viewer-article';
      articleHost.innerHTML = renderReferenceArticle(
        data.article,
        request.context.targetLawId,
        request.parts.scope || ''
      );
      prefixReferencePopupIds(articleHost, popupId);
      body.replaceChildren(articleHost);

      const target = findReferencePopupTarget(articleHost, request.parts);
      if (target) {
        target.classList.add('egov-lite-reference-viewer-target');
        requestAnimationFrame(() => {
          if (!popup.isConnected) return;
          const bodyRect = body.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();
          const centeredOffset = Math.max(24, (body.clientHeight - Math.min(targetRect.height, body.clientHeight)) / 2);
          body.scrollTop += targetRect.top - bodyRect.top - centeredOffset;
        });
      }
    } catch (error) {
      if (!referenceViewerPopups.has(popup) || !popup.isConnected) return;
      console.warn('[e-Gov Enhancer] 参照条文の読み込みに失敗しました', error);
      body.innerHTML = '<div class="egov-lite-reference-viewer-status is-error">条文を読み込めませんでした。「新しいタブで開く」を使用してください。</div>';
    }
  }

  function openLawReferenceUrl(url, event = null, sourceLawId = '', source = null) {
    const resolvedLawId = sourceLawId || getLawIdFromUrl(url);
    if (!resolvedLawId) return false;
    const provisionKey = parseProvisionKeyFromEgovUrl(url);
    const point = event ? { x: event.clientX, y: event.clientY } : null;
    if (shouldOpenReferenceSourcePopup(event || {}, resolvedLawId)) {
      showReferenceViewerPopup(source, url, point, resolvedLawId);
      return true;
    }
    if (resolvedLawId === lawId && provisionKey && jumpToKey(provisionKey)) return true;
    window.open(url, '_blank', 'noopener');
    return true;
  }

  function openReferenceSource(source, event = null) {
    if (!source) return;
    const sourceLawId = source.sourceLawId || getLawIdFromUrl(source.sourceUrl || '');
    hideReferencesPopup();

    const url = buildNormalReferenceSourceUrl(source);
    if (!url) return;
    openLawReferenceUrl(url, event, sourceLawId, source);
  }

  function clearExternalReferenceLinks() {
    hideReferencesPopup();
    contentEl.querySelectorAll('.egov-lite-reference-clickable').forEach((el) => {
      el.classList.remove('egov-lite-reference-clickable');
      delete el.dataset.egovReferenceTargetKey;
      delete el.dataset.egovReferenceSupplementArticle;
      el.removeAttribute('title');
      el.removeAttribute('tabindex');
    });
  }

  function makeReferenceClickable(target, targetKey, sources) {
    if (!(target instanceof Element) || !sources?.length) return;
    const clickable = findLiteReferenceClickableElement(target, targetKey);
    if (!(clickable instanceof Element)) return;
    configureReferenceClickable({
      clickable,
      className: 'egov-lite-reference-clickable',
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
      findTarget: findLiteReferenceTargetElement,
      makeClickable: makeReferenceClickable,
      schedule: (step) => runWhenIdle(step, 250),
      batchSize: 160,
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
        const internalReferences = collectInternalLawReferences(contentEl, {
          lawId,
          lawTitle: lawTitleText,
          baseUrl: sourceUrl || location.href,
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

  async function enableExternalReferenceLinks({ silent = false } = {}) {
    if (externalReferencesEnabled) return true;
    if (externalReferencesLoading) return false;
    if (!contentEl.querySelector('.law-article')) {
      if (!silent) showToast('条文の読み込み完了後にもう一度試してください');
      return false;
    }
    externalReferencesLoading = true;
    syncViewerToggleButtons();
    try {
      if (!silent) showToast('逆参照リンクを読み込んでいます');
      const stored = await chrome.storage.local.get([REVERSE_REFERENCE_SCOPE_KEY]).catch(() => ({}));
      reverseReferenceScope = normalizeReverseReferenceScope(
        stored[REVERSE_REFERENCE_SCOPE_KEY] ?? reverseReferenceScope
      );
      const { includeExternal } = getReverseReferenceScopeFlags(reverseReferenceScope);
      const lawReferences = includeExternal ? await getLawReferencesData(lawId) : {};
      externalReferencesEnabled = true;
      applyExternalReferenceLinksForLaw(lawReferences);
      if (!silent) showToast('逆参照リンクを設定しました');
      return true;
    } finally {
      externalReferencesLoading = false;
      syncViewerToggleButtons();
    }
  }

  function disableExternalReferenceLinks({ silent = false } = {}) {
    if (!externalReferencesEnabled) return;
    externalReferencesEnabled = false;
    referenceAnalysisGeneration += 1;
    clearExternalReferenceLinks();
    syncViewerToggleButtons();
    if (!silent) showToast('逆参照リンクを無効化しました');
  }

  function toggleExternalReferenceLinks() {
    if (externalReferencesEnabled) {
      disableExternalReferenceLinks();
      return;
    }
    enableExternalReferenceLinks();
  }

  function setupExternalReferenceInteractions() {
    contentEl.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest('a[href]');
      if (!anchor || !contentEl.contains(anchor) || !getLawIdFromUrl(anchor.href)) return;
      event.preventDefault();
      event.stopPropagation();
      hideReferencesPopup();
      openLawReferenceUrl(anchor.href, event);
    });
    document.addEventListener('pointerdown', (event) => {
      const target = event.target instanceof Node ? event.target : null;
      for (const popup of [...referenceViewerPopups]) {
        if (popup.dataset.pinned === 'true' || (target && popup.contains(target))) continue;
        hideReferenceViewerPopup(popup);
      }
    }, true);
    window.addEventListener('resize', () => {
      if (!referenceViewerPopups.size || referenceViewerLayoutFrame) return;
      referenceViewerLayoutFrame = requestAnimationFrame(() => {
        referenceViewerLayoutFrame = 0;
        refreshReferenceViewerPopupLayout();
      });
    });
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.egov-lite-reference-popup, .egov-lite-reference-viewer-popup, .egov-lite-reference-clickable')) return;
      hideReferencesPopup();
    });
    document.addEventListener('keydown', (event) => {
      if (event.isTrusted && event.key === 'Control') {
        lawRefModeCtrlPressed = true;
        updateLawRefModeButton();
      }
      if (event.key === 'Escape') {
        hideReferencesPopup();
        hideReferenceViewerPopup();
        hideLiteTooltip(true);
      }
    });
    document.addEventListener('keyup', (event) => {
      if (!event.isTrusted || event.key !== 'Control') return;
      lawRefModeCtrlPressed = false;
      updateLawRefModeButton();
    });
    window.addEventListener('blur', () => {
      if (!lawRefModeCtrlPressed) return;
      lawRefModeCtrlPressed = false;
      updateLawRefModeButton();
    });
  }

  function jumpToInitialHash() {
    const key = decodeURIComponent(location.hash || '').replace(/^#/, '');
    if (!key) return;
    runWhenIdle(() => jumpToKey(key, false), 300);
  }

  function getCurrentJumpReturnPosition() {
    return {
      windowTop: window.scrollY,
      leftTop: leftPaneEl?.scrollTop || 0,
      rightTop: rightPaneEl?.scrollTop || 0,
      guide: formatJumpReturnArticleGuide(),
    };
  }

  function scrollToJumpReturnPosition(position) {
    if (!position) return;
    if (compareMode) {
      leftPaneEl?.scrollTo({ top: Math.max(0, position.leftTop || 0), behavior: scrollBehavior });
      rightPaneEl?.scrollTo({ top: Math.max(0, position.rightTop || 0), behavior: scrollBehavior });
      return;
    }
    window.scrollTo({ top: Math.max(0, position.windowTop || 0), behavior: scrollBehavior });
  }

  function hideJumpReturnButton() {
    clearTimeout(jumpReturnButtonTimer);
    jumpReturnButtonTimer = 0;
    document.getElementById('lite-jump-return')?.remove();
  }

  function showJumpReturnButton(position) {
    if (!position) return;
    hideJumpReturnButton();
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'lite-jump-return';
    button.textContent = `Rでジャンプ前の位置に戻る${position.guide ? `（${position.guide}）` : ''}`;
    button.addEventListener('click', () => {
      scrollToJumpReturnPosition(position);
      hideJumpReturnButton();
    });
    document.body.appendChild(button);
    jumpReturnButtonTimer = setTimeout(hideJumpReturnButton, 10 * 60 * 1000);
  }

  function scrollToElement(el, block = 'start') {
    if (!el) return;
    if (compareMode && leftPaneEl.contains(el)) {
      const rootRect = leftPaneEl.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const offset = block === 'center'
        ? (leftPaneEl.clientHeight - elRect.height) / 2
        : 120;
      leftPaneEl.scrollTo({
        top: Math.max(0, leftPaneEl.scrollTop + elRect.top - rootRect.top - offset),
        behavior: scrollBehavior,
      });
      return;
    }
    el.scrollIntoView({ behavior: scrollBehavior, block });
  }

  function getLiteFavoriteScrollTarget() {
    return compareMode ? leftPaneEl : window;
  }

  function getCurrentLiteFavoriteLocation() {
    const articles = articleElementsCache.filter((article) => article.isConnected);
    if (!articles.length) return null;
    const viewportTop = compareMode ? leftPaneEl.getBoundingClientRect().top : 0;
    let current = articles[0];
    for (const article of articles) {
      if (article.getBoundingClientRect().top > viewportTop + 1) break;
      current = article;
    }
    const article = current.dataset.articleNum || '';
    if (!article) return null;
    const scope = current.dataset.referenceScope || '';
    const articleKey = scope ? `${scope}::${article}` : article;
    const rect = current.getBoundingClientRect();
    const offset = Math.max(0, Math.min(1, (viewportTop - rect.top) / Math.max(1, rect.height)));
    return { articleKey, offset };
  }

  function scrollToLiteFavoriteLocation(articleKey, offset = 0) {
    const target = findJumpTarget(articleKey);
    if (!(target instanceof Element)) return false;
    const normalizedOffset = Math.max(0, Math.min(1, Number(offset) || 0));
    const rect = target.getBoundingClientRect();
    if (compareMode) {
      const paneRect = leftPaneEl.getBoundingClientRect();
      const top = rect.top - paneRect.top + leftPaneEl.scrollTop + rect.height * normalizedOffset;
      leftPaneEl.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    } else {
      const top = rect.top + window.scrollY + rect.height * normalizedOffset;
      window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    }
    return true;
  }

  async function updateLiteFavoriteLocation() {
    if (!lawId) return;
    const locationRecord = getCurrentLiteFavoriteLocation();
    if (!locationRecord) return;
    const favorites = await getFavorites();
    const index = favorites.findIndex((favorite) => favorite.lawId === lawId);
    if (index < 0) return;
    const offset = Math.round(locationRecord.offset * 10000) / 10000;
    if (favorites[index].lastArticleKey === locationRecord.articleKey &&
        favorites[index].lastArticleOffset === offset) return;
    favorites[index] = {
      ...favorites[index],
      lastArticleKey: locationRecord.articleKey,
      lastArticleOffset: offset,
    };
    await persistLocal({ favorites }, { errorLabel: '閲覧位置の保存' });
  }

  function scheduleLiteFavoriteScrollSave() {
    clearTimeout(favoriteScrollSaveTimer);
    favoriteScrollSaveTimer = setTimeout(() => {
      favoriteScrollSaveTimer = 0;
      updateLiteFavoriteLocation();
    }, 400);
  }

  async function setupLiteFavoriteScrollPersistence() {
    if (favoriteScrollPersistenceSetup || !lawId) return;
    favoriteScrollPersistenceSetup = true;
    const favorites = await getFavorites();
    if (!favorites.some((favorite) => favorite.lawId === lawId)) {
      favoriteScrollPersistenceSetup = false;
      return;
    }
    window.addEventListener('scroll', scheduleLiteFavoriteScrollSave, { passive: true });
    leftPaneEl.addEventListener('scroll', scheduleLiteFavoriteScrollSave, { passive: true });
    window.addEventListener('pagehide', () => updateLiteFavoriteLocation(), { once: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') updateLiteFavoriteLocation();
    });
  }

  async function restoreLiteFavoriteScrollOnLoad() {
    if (!lawId || location.hash) return false;
    const favorites = await getFavorites();
    const favorite = favorites.find((item) => item.lawId === lawId);
    if (!favorite) return false;
    if (typeof favorite.lastArticleKey === 'string' &&
        scrollToLiteFavoriteLocation(favorite.lastArticleKey, favorite.lastArticleOffset)) {
      return true;
    }
    if (typeof favorite.lastScrollTop === 'number') {
      getLiteFavoriteScrollTarget().scrollTo({
        top: Math.max(0, favorite.lastScrollTop),
        behavior: 'instant',
      });
      return true;
    }
    return false;
  }

  function scheduleLiteFavoriteScrollRestore() {
    if (favoriteScrollRestoreStarted) return;
    favoriteScrollRestoreStarted = true;
    requestAnimationFrame(async () => {
      await restoreLiteFavoriteScrollOnLoad();
      setupLiteFavoriteScrollPersistence();
      favoriteScrollRestoreStarted = false;
    });
  }

  function flashJumpTarget(el) {
    el.classList.remove('lite-jump-flash');
    void el.offsetWidth;
    el.classList.add('lite-jump-flash');
    setTimeout(() => el.classList.remove('lite-jump-flash'), 1400);
  }

  function scrollPage(ratio) {
    const delta = window.innerHeight * ratio;
    if (compareMode && focusedPane === 'left') {
      leftPaneEl.scrollTo({ top: Math.max(0, leftPaneEl.scrollTop + leftPaneEl.clientHeight * ratio), behavior: scrollBehavior });
      return;
    }
    window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior: scrollBehavior });
  }

  function getArticleAtViewportRatio(ratio = 0.25, articles = articleElementsCache) {
    if (!articles.length) return null;
    const viewportTop = compareMode ? leftPaneEl.getBoundingClientRect().top : 0;
    const normalizedRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
    const y = viewportTop + (compareMode ? leftPaneEl.clientHeight : window.innerHeight) * normalizedRatio;
    let low = 0;
    let high = articles.length - 1;
    let currentIndex = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (articles[mid].getBoundingClientRect().top <= y) {
        currentIndex = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return articles[currentIndex];
  }

  function getArticleAtViewport(articles = articleElementsCache) {
    return getArticleAtViewportRatio(0.25, articles);
  }

  function formatArabicArticleLabelFromTitle(title) {
    const match = normalizeCopyText(title).match(/第([^条]{1,20})条/);
    if (!match) return '';
    const parts = match[1].split('の').map((part) => {
      const normalized = String(part || '').trim();
      return /^\d+$/.test(normalized) ? normalized : kanjiToNumber(normalized);
    }).filter(Boolean);
    if (!parts.length) return '';
    return parts.length > 1
      ? `第${parts[0]}条の${parts.slice(1).join('の')}`
      : `第${parts[0]}条`;
  }

  function formatJumpReturnArticleGuide() {
    const article = getArticleAtViewportRatio(1 / 3);
    const title = normalizeCopyText(article?.querySelector(':scope > .article-title')?.textContent || '');
    const titleLabel = formatArabicArticleLabelFromTitle(title);
    if (titleLabel) return `${titleLabel}近辺`;
    const articleParts = String(article?.dataset?.articleNum || '').split(/[-_]+/).filter(Boolean);
    if (!articleParts.length) return '';
    return articleParts.length > 1
      ? `第${articleParts[0]}条の${articleParts.slice(1).join('の')}近辺`
      : `第${articleParts[0]}条近辺`;
  }

  function navigateArticle(delta) {
    const articles = articleElementsCache;
    if (!articles.length) return;
    const current = getArticleAtViewport(articles);
    const idx = Math.max(0, articles.indexOf(current));
    const next = articles[Math.max(0, Math.min(articles.length - 1, idx + delta))];
    if (next) {
      keyboardBookmarkTargetId = next.id || '';
      scrollToElement(next, 'start');
      setTimeout(() => flashJumpTarget(next), scrollBehavior === 'smooth' ? 220 : 0);
    }
  }

  function navigateJumpHistory(dir) {
    if (!articleJumpHistory.length) {
      showToast('履歴がありません');
      return;
    }
    const next = Math.max(
      0,
      Math.min(articleJumpHistory.length - 1, articleJumpCursor + dir)
    );
    const returnPosition = document.getElementById('lite-jump-return')
      ? null
      : getCurrentJumpReturnPosition();
    articleJumpCursor = next;
    const moved = jumpToKey(articleJumpHistory[articleJumpCursor], false);
    if (moved && returnPosition) showJumpReturnButton(returnPosition);
  }

  function showArticleDialog(initial = '') {
    const dialog = createDialog('条文ジャンプ');
    const body = dialog.querySelector('.lite-dialog-body');
    body.innerHTML = `
      <div class="lite-input-row">
        <input id="lite-article-input" type="text" inputmode="numeric" value="${escapeHtml(initial)}" autocomplete="off">
        <span>条</span>
      </div>
      <p class="lite-hint">例: 3 / 3.2 / 3.2.1。Enterで移動、↑↓で履歴、Tabで検索へ。</p>
      <div class="lite-status" id="lite-article-status"></div>
    `;
    const input = body.querySelector('#lite-article-input');
    const status = body.querySelector('#lite-article-status');
    const hist = buildHistoryDropdown(input, articleHistory, doJump);
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^0-9.\-_\u306e\u30ce\u4e4b]/g, '');
    });
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Tab') { event.preventDefault(); closeDialog(); showSearchDialog(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!hist.isVisible()) hist.show();
        hist.move(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); hist.isVisible() ? hist.hide() : closeDialog(); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        const value = hist.isVisible() && hist.current() !== null ? hist.current() : input.value.trim();
        hist.hide();
        doJump(value);
      }
    });
    function doJump(value) {
      const raw = String(value || '').trim();
      if (!raw) return;
      if (jumpToKey(raw)) {
        pushHistory(articleHistory, raw);
        closeDialog();
      } else {
        status.textContent = `「${raw}」が見つかりませんでした`;
        status.className = 'lite-status error';
        input.focus();
        input.select();
      }
    }
    input.focus();
    input.setSelectionRange(initial.length, initial.length);
  }

  function clearSearchMarks() {
    if (CSS.highlights) {
      CSS.highlights.delete('egov-lite-search');
      CSS.highlights.delete('egov-lite-search-current');
    }
    window.getSelection()?.removeAllRanges();
    searchState = { marks: [], current: -1, query: '' };
  }

  function scrollRangeToView(range) {
    const rect = range.getBoundingClientRect();
    const searchDialog = activeDialog?.dataset.dialogType === 'search'
      ? activeDialog.querySelector('.lite-dialog')
      : null;
    const dialogBottom = searchDialog?.getBoundingClientRect().bottom || 0;
    const gap = 16;
    if (compareMode) {
      const pane = leftPaneEl.contains(range.commonAncestorContainer) ? leftPaneEl : rightPaneEl;
      const paneRect = pane.getBoundingClientRect();
      const preferredOffset = pane.clientHeight * 0.35;
      const unobscuredOffset = Math.max(0, dialogBottom + gap - paneRect.top);
      const targetOffset = Math.min(pane.clientHeight - gap, Math.max(preferredOffset, unobscuredOffset));
      pane.scrollTo({
        top: Math.max(0, rect.top - paneRect.top + pane.scrollTop - targetOffset),
        behavior: scrollBehavior,
      });
      return;
    }
    const preferredOffset = window.innerHeight * 0.35;
    const targetOffset = Math.min(window.innerHeight - gap, Math.max(preferredOffset, dialogBottom + gap));
    window.scrollTo({
      top: Math.max(0, rect.top + window.scrollY - targetOffset),
      behavior: scrollBehavior,
    });
  }

  function markCurrentSearch() {
    const current = searchState.marks[searchState.current];
    if (!current) return;
    if (CSS.highlights) CSS.highlights.set('egov-lite-search-current', new Highlight(current));
    else {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(current.cloneRange());
    }
    scrollRangeToView(current);
  }

  function findInPage(query) {
    clearSearchMarks();
    const q = normalizeText(query);
    if (!q) return 0;
    injectSearchHighlightStyles();
    const pattern = new RegExp(escapeRegExp(q), 'gi');
    const searchText = collectSearchTextSegments(contentEl);
    let match;
    while ((match = pattern.exec(searchText.text)) !== null) {
      const range = rangeFromSearchOffsets(searchText.segments, match.index, match.index + match[0].length);
      if (range) searchState.marks.push(range);
    }
    if (CSS.highlights) CSS.highlights.set('egov-lite-search', new Highlight(...searchState.marks));
    searchState.query = q;
    searchState.current = searchState.marks.length ? 0 : -1;
    markCurrentSearch();
    return searchState.marks.length;
  }

  function moveSearch(dir) {
    if (!searchState.marks.length) return;
    searchState.current = (searchState.current + dir + searchState.marks.length) % searchState.marks.length;
    markCurrentSearch();
  }

  function showSearchDialog() {
    const dialog = createDialog('ページ内検索');
    activeDialog.dataset.dialogType = 'search';
    const body = dialog.querySelector('.lite-dialog-body');
    body.innerHTML = `
      <div class="lite-input-row">
        <input id="lite-search-input" type="search" autocomplete="off">
      </div>
      <p class="lite-hint">Enter: 次へ / Shift+Enter: 前へ / Ctrl+Enter: 現在位置から検索 / ↑↓ または n/p: 履歴</p>
      <div class="lite-status" id="lite-search-status"></div>
      <div class="lite-search-history" id="lite-search-history"></div>
    `;
    const input = body.querySelector('#lite-search-input');
    const status = body.querySelector('#lite-search-status');
    const historyEl = body.querySelector('#lite-search-history');
    let focusedHistory = searchHistory.length ? 0 : -1;
    function renderHistory() {
      historyEl.innerHTML = searchHistory.length
        ? searchHistory.map((item, i) => `<button type="button" class="lite-search-history-item${i === focusedHistory ? ' is-focused' : ''}" data-index="${i}">${escapeHtml(item)}</button>`).join('')
        : '<div class="lite-empty-history">検索履歴はありません</div>';
    }
    function focusHistory(delta) {
      if (!searchHistory.length) return;
      focusedHistory = (Math.max(0, focusedHistory) + delta + searchHistory.length) % searchHistory.length;
      renderHistory();
      historyEl.querySelector('.is-focused')?.scrollIntoView({ block: 'nearest' });
    }
    function useHistory(index = focusedHistory) {
      const value = searchHistory[index];
      if (!value) return;
      input.value = value;
      input.focus();
      input.select();
    }
    function runSearch() {
      const query = input.value.trim();
      const count = findInPage(query);
      if (query && count > 0) {
        pushHistory(searchHistory, query);
        focusedHistory = 0;
        renderHistory();
      }
      status.textContent = count ? `${searchState.current + 1} / ${count}` : '一致なし';
    }
    historyEl.addEventListener('mousedown', (event) => {
      const item = event.target.closest('.lite-search-history-item');
      if (!item) return;
      event.preventDefault();
      focusedHistory = Number(item.dataset.index);
      useHistory(focusedHistory);
      renderHistory();
    });
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Tab') { event.preventDefault(); closeDialog(); showArticleDialog(); return; }
      if (event.key === 'Escape') { event.preventDefault(); closeDialog(); return; }
      if (event.key === 'ArrowDown' || event.key === 'n') { event.preventDefault(); focusHistory(1); useHistory(); return; }
      if (event.key === 'ArrowUp' || event.key === 'p') { event.preventDefault(); focusHistory(-1); useHistory(); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!searchState.marks.length || searchState.query !== normalizeText(input.value)) runSearch();
        else moveSearch(event.shiftKey ? -1 : 1);
        status.textContent = searchState.marks.length ? `${searchState.current + 1} / ${searchState.marks.length}` : '一致なし';
      }
    });
    renderHistory();
    input.focus();
  }
  function showTocDialog() {
    if (!tocItems.length) {
      showToast('目次データが存在しない法令です');
      return;
    }
    const dialog = createDialog('目次', { wide: true });
    const body = dialog.querySelector('.lite-dialog-body');
    body.innerHTML = `<div class="lite-toc-list">${tocItems.map((item, i) => `<a href="#" data-index="${i}" data-level="${Math.min(item.level, 2)}">${escapeHtml(item.text)}</a>`).join('')}</div>`;
    const links = Array.from(body.querySelectorAll('a'));
    let focused = 0;
    function focusLink(index) {
      links.forEach((link) => link.classList.remove('is-focused'));
      focused = Math.max(0, Math.min(index, links.length - 1));
      links[focused]?.classList.add('is-focused');
      links[focused]?.scrollIntoView({ block: 'nearest' });
    }
    function activate(index) {
      const item = tocItems[index];
      if (item?.articleNum && jumpToKey(item.articleNum)) closeDialog();
      else showToast('対応する条文位置が見つかりませんでした');
    }
    body.addEventListener('click', (event) => {
      const link = event.target.closest('a');
      if (!link) return;
      event.preventDefault();
      activate(Number(link.dataset.index));
    });
    body.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'n' || event.key === 'd') { event.preventDefault(); focusLink(focused + 1); }
      else if (event.key === 'ArrowUp' || event.key === 'p' || event.key === 'u') { event.preventDefault(); focusLink(focused - 1); }
      else if (event.key === 'Enter') { event.preventDefault(); activate(focused); }
      else if (event.key === 'Escape') { event.preventDefault(); closeDialog(); }
    });
    body.tabIndex = 0;
    focusLink(0);
    body.focus();
  }

  function getAllProvisionItems() {
    if (liteProvisionItemsCache) return liteProvisionItemsCache;
    const items = [];
    const baseUrl = sourceUrl.split('#')[0];
    Array.from(contentEl.querySelectorAll('.law-article')).forEach((article) => {
      const articleNum = article.dataset.articleNum || '';
      const articleTitle = formatProvisionNumber({ article: articleNum }) ||
        normalizeCopyText(article.querySelector('.article-title')?.textContent || articleNum);
      const paragraphNums = new Set(
        Array.from(article.querySelectorAll(':scope > .law-paragraph[data-paragraph-num]'))
          .map((paragraph) => paragraph.dataset.paragraphNum || '')
          .filter(Boolean)
      );
      items.push({
        el: article,
        id: article.id,
        type: 'article',
        targetKey: getLiteBookmarkTargetKey(article, 'article'),
        title: articleTitle,
        copyTitle: articleTitle,
        url: `${baseUrl}#${encodeURIComponent(article.id)}`,
      });
      article.querySelectorAll('.law-paragraph[data-paragraph-num]').forEach((paragraph) => {
        const paragraphNum = paragraph.dataset.paragraphNum || '';
        const label = formatProvisionNumber(
          { article: articleNum, paragraph: paragraphNum },
          { omitSingleParagraphFirst: paragraphNums.size === 1 }
        ) || articleTitle;
        items.push({
          el: paragraph,
          id: paragraph.id,
          type: 'paragraph',
          targetKey: getLiteBookmarkTargetKey(paragraph, 'paragraph'),
          title: label,
          copyTitle: label,
          url: `${baseUrl}#${encodeURIComponent(paragraph.id)}`,
        });
        paragraph.querySelectorAll(':scope > div:nth-child(2) > .law-item[data-item-num]').forEach((item) => {
          const itemNum = item.dataset.itemNum || '';
          const itemLabel = formatProvisionNumber({
            article: articleNum,
            paragraph: paragraphNum,
            item: itemNum,
          }) || label;
          items.push({
            el: item,
            id: item.id,
            type: 'item',
            targetKey: getLiteBookmarkTargetKey(item, 'item'),
            title: itemLabel,
            copyTitle: itemLabel,
            url: `${baseUrl}#${encodeURIComponent(item.id)}`,
          });
        });
      });
    });
    liteProvisionItemsCache = items;
    return liteProvisionItemsCache;
  }

  function currentArticleIndex(items) {
    const y = window.scrollY + 120;
    let idx = 0;
    items.forEach((item, i) => {
      if (item.el.getBoundingClientRect().top + window.scrollY <= y) idx = i;
    });
    return idx;
  }

  function getProvisionCopyText(item) {
    if (item.type === 'item') return buildItemCopyLines(item.el).filter(Boolean).join('\n');
    return item.type === 'paragraph' ? buildParagraphCopyText(item.el) : buildArticleCopyText(item.el);
  }

  function normalizeBookmarkKeyPart(value) {
    return normalizeArticleKey(value).replace(/_/g, '-');
  }

  function getLiteBookmarkTargetKey(el, type = '') {
    if (!(el instanceof Element)) return '';
    const article = normalizeBookmarkKeyPart(el.dataset.articleNum || el.closest('.law-article')?.dataset.articleNum || '');
    if (!article) return '';
    const paragraph = type === 'article' ? '' : normalizeBookmarkKeyPart(el.dataset.paragraphNum || '');
    const item = type === 'item' ? normalizeBookmarkKeyPart(el.dataset.itemNum || '') : '';
    const scope = el.dataset.referenceScope || el.closest('[data-reference-scope]')?.dataset.referenceScope || '';
    const provision = [article, paragraph, item].filter(Boolean).join('.');
    return scope ? `${scope}::${provision}` : provision;
  }

  function getLiteBookmarkProvisionItems() {
    // 通常表示と同様、第1項は条見出しと同じ対象として扱う。
    return getAllProvisionItems().filter((item) => {
      if (!item.targetKey) return false;
      const parts = splitReferenceTargetKey(item.targetKey);
      return !(item.type === 'paragraph' && parts.paragraph === '1');
    });
  }

  function normalizeArticleBookmark(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const bookmarkLawId = String(raw.lawId || '').trim().slice(0, 40);
    const targetKey = String(raw.targetKey || '').trim().slice(0, 120);
    const parts = splitReferenceTargetKey(targetKey);
    if (!bookmarkLawId || !parts.article) return null;
    return {
      id: `${bookmarkLawId}::${targetKey}`,
      lawId: bookmarkLawId,
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

  function getArticleBookmarkGutterSignature(bookmarks = articleBookmarksCache) {
    return `${lawId}\n${(Array.isArray(bookmarks) ? bookmarks : [])
      .filter((bookmark) => bookmark?.lawId === lawId)
      .map((bookmark) => bookmark.targetKey)
      .sort((left, right) => left.localeCompare(right, 'ja', { numeric: true }))
      .join('\n')}`;
  }

  function applyLiteBookmarkGutterState(button, item, marked) {
    if (!(button instanceof HTMLButtonElement)) return;
    button.classList.toggle('is-bookmarked', marked);
    button.tabIndex = marked ? 0 : -1;
    const label = `${item.title}のブックマークを${marked ? '削除' : '追加'}`;
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  function createLiteBookmarkGutter(item, marked) {
    const host = item.type === 'article'
      ? item.el.querySelector(':scope > .article-title')
      : item.el.querySelector(':scope > .law-num');
    if (!(host instanceof Element)) return null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lite-bookmark-gutter';
    button.dataset.bookmarkTargetKey = item.targetKey;
    applyLiteBookmarkGutterState(button, item, marked);
    host.classList.add('lite-bookmark-number-host');
    host.prepend(button);
    articleBookmarkGutterButtons.set(item.targetKey, button);
    return button;
  }

  function updateLiteBookmarkGutter(item, marked) {
    let button = articleBookmarkGutterButtons.get(item.targetKey);
    if (!(button instanceof HTMLButtonElement) || !button.isConnected) {
      button = Array.from(contentEl.querySelectorAll('.lite-bookmark-gutter'))
        .find((candidate) => candidate.dataset.bookmarkTargetKey === item.targetKey) || null;
    }
    if (!(button instanceof HTMLButtonElement)) button = createLiteBookmarkGutter(item, marked);
    else {
      articleBookmarkGutterButtons.set(item.targetKey, button);
      applyLiteBookmarkGutterState(button, item, marked);
    }
    return button;
  }

  async function renderLiteArticleBookmarkGutters() {
    const renderVersion = ++articleBookmarkRenderVersion;
    contentEl.querySelectorAll('.lite-bookmark-gutter').forEach((button) => button.remove());
    contentEl.querySelectorAll('.lite-bookmark-number-host').forEach((host) => host.classList.remove('lite-bookmark-number-host'));
    articleBookmarkGutterButtons.clear();
    if (!lawId || !articleElementsCache.length) return;
    const bookmarks = await getArticleBookmarks();
    if (renderVersion !== articleBookmarkRenderVersion) return;
    articleBookmarkGutterSignature = getArticleBookmarkGutterSignature(bookmarks);
    const markedKeys = new Set(
      bookmarks.filter((bookmark) => bookmark.lawId === lawId).map((bookmark) => bookmark.targetKey)
    );
    for (const item of getLiteBookmarkProvisionItems()) {
      if (renderVersion !== articleBookmarkRenderVersion) return;
      createLiteBookmarkGutter(item, markedKeys.has(item.targetKey));
    }
  }

  async function toggleLiteArticleBookmark(item) {
    if (!item?.targetKey || !item?.id || !lawId) return false;
    const id = `${lawId}::${item.targetKey}`;
    const now = performance.now();
    const lastToggleAt = articleBookmarkLastToggleAt.get(id);
    if (articleBookmarkToggleLocks.has(id) ||
        (typeof lastToggleAt === 'number' && now - lastToggleAt < ARTICLE_BOOKMARK_TOGGLE_DEBOUNCE_MS)) return false;
    articleBookmarkToggleLocks.add(id);
    try {
      const bookmarks = [...await getArticleBookmarks()];
      const index = bookmarks.findIndex((bookmark) => bookmark.id === id);
      const removing = index >= 0;
      if (removing) bookmarks.splice(index, 1);
      else {
        bookmarks.push({
          id,
          lawId,
          lawName: lawTitleText,
          targetKey: item.targetKey,
          articleId: item.id,
          numberLabel: item.title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      const previousSignature = articleBookmarkGutterSignature;
      articleBookmarkGutterSignature = getArticleBookmarkGutterSignature(bookmarks);
      updateLiteBookmarkGutter(item, !removing);
      if (!await saveArticleBookmarks(bookmarks)) {
        articleBookmarkGutterSignature = previousSignature;
        updateLiteBookmarkGutter(item, removing);
        showToast('ブックマークの保存に失敗しました');
        return false;
      }
      const completedAt = performance.now();
      articleBookmarkLastToggleAt.set(id, completedAt);
      setTimeout(() => {
        if (articleBookmarkLastToggleAt.get(id) === completedAt) articleBookmarkLastToggleAt.delete(id);
      }, ARTICLE_BOOKMARK_TOGGLE_DEBOUNCE_MS);
      showToast(`${item.title}のブックマークを${removing ? '削除' : '追加'}しました`);
      return true;
    } finally {
      articleBookmarkToggleLocks.delete(id);
    }
  }

  async function removeLiteArticleBookmark(bookmark) {
    const bookmarks = [...await getArticleBookmarks()];
    const next = bookmarks.filter((item) => item.id !== bookmark?.id);
    if (next.length === bookmarks.length) return false;
    if (!await saveArticleBookmarks(next)) {
      showToast('ブックマークの削除に失敗しました');
      return false;
    }
    articleBookmarkGuttersDirty = true;
    return true;
  }

  function buildBookmarkShortcutCodes(count) {
    if (!count) return [];
    const strokeCount = count <= 7 ? 1 : count <= 49 ? 2 : count <= 343
      ? 3 : Math.ceil(Math.log(count) / Math.log(BOOKMARK_SHORTCUT_KEYS.length));
    return Array.from({ length: count }, (_value, index) => {
      let value = index;
      const chars = Array(strokeCount).fill(BOOKMARK_SHORTCUT_KEYS[0]);
      for (let position = strokeCount - 1; position >= 0; position -= 1) {
        chars[position] = BOOKMARK_SHORTCUT_KEYS[value % BOOKMARK_SHORTCUT_KEYS.length];
        value = Math.floor(value / BOOKMARK_SHORTCUT_KEYS.length);
      }
      return chars.join('');
    });
  }

  function getLiteBookmarkBody(item) {
    let body = normalizeCopyText(getProvisionCopyText(item));
    if (!body) return '（本文なし）';
    const visibleNumber = normalizeCopyText((item.type === 'article'
      ? item.el.querySelector(':scope > .article-title')
      : item.el.querySelector(':scope > .law-num'))?.textContent || '');
    for (const prefix of [item.title, visibleNumber]) {
      if (prefix && body.startsWith(prefix)) body = body.slice(prefix.length).trim();
    }
    return body || '（本文なし）';
  }

  function getLiteBookmarkAtViewport(items = getLiteBookmarkProvisionItems()) {
    if (!items.length) return null;
    const paneRect = compareMode ? leftPaneEl.getBoundingClientRect() : null;
    const anchorTop = compareMode
      ? paneRect.top + leftPaneEl.clientHeight * 0.25
      : window.innerHeight * 0.25;
    let current = items[0];
    for (const item of items) {
      if (item.el.getBoundingClientRect().top <= anchorTop + 1) current = item;
      else break;
    }
    return current;
  }

  function jumpToLiteArticleBookmark(row) {
    if (!row?.item) {
      showToast('ブックマーク先の条文を見つけられませんでした');
      return false;
    }
    keyboardBookmarkTargetId = '';
    const sourceItem = getLiteBookmarkAtViewport();
    if (sourceItem?.targetKey) pushJumpHistory(sourceItem.targetKey);
    closeDialog();
    if (!jumpToKey(row.bookmark.targetKey, true)) {
      showToast('ブックマーク先の条文を見つけられませんでした');
      return false;
    }
    history.replaceState(null, '', `#${encodeURIComponent(row.bookmark.targetKey)}`);
    return true;
  }

  async function toggleLiteBookmarkAtCurrentPosition() {
    const items = getLiteBookmarkProvisionItems();
    const keyboardItem = keyboardBookmarkTargetId
      ? items.find((item) => item.id === keyboardBookmarkTargetId)
      : null;
    keyboardBookmarkTargetId = '';
    const item = keyboardItem || getLiteBookmarkAtViewport(items);
    if (!item) {
      showToast('ブックマークできる条文が見つかりません');
      return;
    }
    await toggleLiteArticleBookmark(item);
  }

  async function showLiteBookmarkDialog({ refresh = false } = {}) {
    const items = getLiteBookmarkProvisionItems();
    const itemByKey = new Map(items.map((item) => [item.targetKey, item]));
    const rows = (await getArticleBookmarks())
      .filter((bookmark) => bookmark.lawId === lawId)
      .map((bookmark) => ({ bookmark, item: itemByKey.get(bookmark.targetKey) || null }))
      .sort((left, right) => {
        const leftIndex = left.item ? items.indexOf(left.item) : Number.MAX_SAFE_INTEGER;
        const rightIndex = right.item ? items.indexOf(right.item) : Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex || left.bookmark.targetKey.localeCompare(right.bookmark.targetKey, 'ja', { numeric: true });
      });
    const shortcutCodes = buildBookmarkShortcutCodes(rows.length);
    const multiStrokeHelp = rows.length >= 8 ? '、<kbd>;</kbd>/<kbd>Backspace</kbd>で最後の入力を取消' : '';
    const dialog = createDialog('条文ブックマーク', { wide: true, deferBookmarkRender: refresh });
    activeDialog.dataset.dialogType = 'bookmarks';
    activeDialog.classList.add('lite-bookmark-overlay');
    dialog.classList.add('lite-bookmark-dialog');
    articleBookmarkDialogSessionActive = true;
    const headerTitle = dialog.querySelector('.lite-dialog-header > div');
    headerTitle.innerHTML = `条文ブックマーク<div class="lite-bookmark-key-status" aria-live="polite" hidden></div>`;
    const body = dialog.querySelector('.lite-dialog-body');
    body.classList.add('lite-bookmark-dialog-body');
    body.innerHTML = `
      <div class="lite-bookmark-help"><kbd>ASDFJKL</kbd>で選択・ジャンプ、<kbd>n</kbd>/<kbd>p</kbd>で移動、<kbd>Enter</kbd>でジャンプ、<kbd>Space</kbd>で削除${multiStrokeHelp}、<kbd>b</kbd>/<kbd>Esc</kbd>で閉じる</div>
      <div class="lite-bookmark-list" role="listbox" tabindex="0">
        ${rows.length ? rows.map((row, index) => `
          <div class="lite-bookmark-row" role="option" data-index="${index}">
            <div class="lite-bookmark-shortcut">${Array.from(shortcutCodes[index]).map((key) => `<kbd>${key.toUpperCase()}</kbd>`).join('')}</div>
            <div class="lite-bookmark-content">
              <span class="lite-bookmark-number">${escapeHtml(row.bookmark.numberLabel || getReferenceTargetLabel(row.bookmark.targetKey))}</span>
              <span class="lite-bookmark-text">${escapeHtml(row.item ? getLiteBookmarkBody(row.item) : '現在の法令本文からこの条文を見つけられませんでした。')}</span>
            </div>
            <button type="button" class="lite-bookmark-delete" data-index="${index}" aria-label="ブックマークを削除" title="ブックマークを削除">×</button>
          </div>
        `).join('') : '<div class="lite-bookmark-empty">この法令にはブックマークがありません。</div>'}
      </div>`;
    const list = body.querySelector('.lite-bookmark-list');
    const status = dialog.querySelector('.lite-bookmark-key-status');
    const rowElements = Array.from(dialog.querySelectorAll('.lite-bookmark-row'));
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
      if (scroll) (selected || rowElements[visibleIndexes[0]])?.scrollIntoView({ block: 'nearest' });
    }

    function moveSelection(delta) {
      if (!visibleIndexes.length) return;
      selectedVisibleIndex = selectedVisibleIndex < 0
        ? (delta > 0 ? 0 : visibleIndexes.length - 1)
        : (selectedVisibleIndex + delta + visibleIndexes.length) % visibleIndexes.length;
      selectionMode = 'keyboard';
      updateRows({ scroll: true });
    }

    async function removeSelected(confirmRemoval) {
      const rowIndex = visibleIndexes[selectedVisibleIndex];
      const row = Number.isInteger(rowIndex) ? rows[rowIndex] : null;
      if (!row) return;
      const label = row.bookmark.numberLabel || getReferenceTargetLabel(row.bookmark.targetKey);
      if (confirmRemoval && !window.confirm(`「${label}」のブックマークを削除しますか？`)) return;
      if (await removeLiteArticleBookmark(row.bookmark)) {
        showToast(`${label}のブックマークを削除しました`);
        await showLiteBookmarkDialog({ refresh: true });
      }
    }

    list.addEventListener('click', (event) => {
      const deleteButton = event.target.closest('.lite-bookmark-delete');
      if (deleteButton) {
        event.preventDefault();
        event.stopPropagation();
        const row = rows[Number(deleteButton.dataset.index)];
        if (row) removeLiteArticleBookmark(row.bookmark).then((removed) => {
          if (!removed) return;
          showToast(`${row.bookmark.numberLabel}のブックマークを削除しました`);
          showLiteBookmarkDialog({ refresh: true });
        });
        return;
      }
      const rowEl = event.target.closest('.lite-bookmark-row');
      const row = rowEl ? rows[Number(rowEl.dataset.index)] : null;
      if (row) jumpToLiteArticleBookmark(row);
    });
    list.addEventListener('pointermove', (event) => {
      const rowEl = event.target.closest('.lite-bookmark-row');
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
      const lower = event.key.toLowerCase();
      if (event.key === 'Escape' || lower === 'b') {
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
        if (Number.isInteger(rowIndex)) jumpToLiteArticleBookmark(rows[rowIndex]);
        return;
      }
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat) removeSelected(true);
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
      if (visibleIndexes.length === 1) {
        jumpToLiteArticleBookmark(rows[visibleIndexes[0]]);
      }
    });
    updateRows();
    list.focus();
  }

  function getLiteTextHighlightLabel(entry) {
    const formatKey = (key) => {
      const portableKey = String(key || '');
      return portableKey ? getReferenceTargetLabel(portableKey) : '';
    };
    const start = formatKey(entry?.startKey);
    const end = formatKey(entry?.endKey || entry?.startKey);
    if (start && end && start !== end) return `${start}～${end}`;
    return start || end || '位置不明';
  }

  function jumpToLiteTextHighlight(entry) {
    if (!entry?.range?.startContainer?.isConnected) {
      showToast('ハイライト位置を本文から見つけられませんでした');
      return false;
    }
    const range = entry.range;
    closeDialog();
    scrollRangeToView(range);
    return true;
  }

  async function showLiteTextHighlightListDialog({ refresh = false } = {}) {
    if (textHighlightController?.closeUi?.() === false) return;
    const rows = await textHighlightController?.getEntries?.() || [];
    const shortcutCodes = buildBookmarkShortcutCodes(rows.length);
    const multiStrokeHelp = rows.length >= 8 ? '、<kbd>;</kbd>/<kbd>Backspace</kbd>で最後の入力を取消' : '';
    const dialog = createDialog('ハイライト・メモ', { wide: true, deferBookmarkRender: refresh });
    activeDialog.dataset.dialogType = 'highlights';
    activeDialog.classList.add('lite-bookmark-overlay');
    dialog.classList.add('lite-bookmark-dialog');
    const headerTitle = dialog.querySelector('.lite-dialog-header > div');
    const displayLimit = Number(textHighlightController?.displayLimit) || 1000;
    headerTitle.innerHTML = `ハイライト・メモ（${rows.length}/${displayLimit}）<div class="lite-bookmark-key-status" aria-live="polite" hidden></div>`;
    const body = dialog.querySelector('.lite-dialog-body');
    body.classList.add('lite-bookmark-dialog-body');
    body.innerHTML = `
      <div class="lite-bookmark-help"><kbd>ASDFJKL</kbd>で選択・ジャンプ、<kbd>n</kbd>/<kbd>p</kbd>で移動、<kbd>Enter</kbd>でジャンプ、<kbd>Space</kbd>で削除${multiStrokeHelp}、<kbd>m</kbd>/<kbd>Esc</kbd>で閉じる</div>
      <div class="lite-bookmark-list" role="listbox" tabindex="0">
        ${rows.length ? rows.map((row, index) => `
          <div class="lite-bookmark-row" role="option" data-index="${index}">
            <div class="lite-bookmark-shortcut">${Array.from(shortcutCodes[index]).map((key) => `<kbd>${key.toUpperCase()}</kbd>`).join('')}</div>
            <div class="lite-bookmark-content lite-highlight-list-content">
              <div class="lite-highlight-list-main">
                <span class="lite-highlight-list-color is-${escapeHtml(row.colorKey)}" aria-hidden="true"></span>
                <span class="lite-bookmark-number">${escapeHtml(getLiteTextHighlightLabel(row))}</span>
                <span class="lite-bookmark-text">${escapeHtml(normalizeCopyText(row.text) || '（本文なし）')}</span>
              </div>
              ${row.memo ? `<div class="lite-highlight-list-memo">${escapeHtml(String(row.memo).replace(/\s+/g, ' ').trim())}</div>` : ''}
            </div>
            <button type="button" class="lite-bookmark-delete" data-index="${index}" aria-label="ハイライトを削除" title="ハイライトを削除">×</button>
          </div>
        `).join('') : '<div class="lite-bookmark-empty">この法令にはハイライト・メモがありません。</div>'}
      </div>
      <div class="lite-highlight-list-tooltip" role="tooltip" hidden></div>`;
    const list = body.querySelector('.lite-bookmark-list');
    const status = dialog.querySelector('.lite-bookmark-key-status');
    const memoTooltip = body.querySelector('.lite-highlight-list-tooltip');
    const rowElements = Array.from(dialog.querySelectorAll('.lite-bookmark-row'));
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
      const memo = String(rows[rowIndex]?.memo || '');
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
      if (!row) return;
      const label = getLiteTextHighlightLabel(row);
      if (row.memo) {
        if (!window.confirm('ハイライトとともにメモも削除されますが良いですか？')) return;
      } else if (confirmRemoval && !window.confirm(`「${label}」のハイライトを削除しますか？`)) {
        return;
      }
      if (!textHighlightController?.removeById?.(row.id)) return;
      showToast(`${label}のハイライトを削除しました`);
      await showLiteTextHighlightListDialog({ refresh: true });
    }

    list.addEventListener('click', (event) => {
      const deleteButton = event.target.closest('.lite-bookmark-delete');
      if (deleteButton) {
        event.preventDefault();
        event.stopPropagation();
        removeRow(rows[Number(deleteButton.dataset.index)], false);
        return;
      }
      const rowEl = event.target.closest('.lite-bookmark-row');
      const row = rowEl ? rows[Number(rowEl.dataset.index)] : null;
      if (row) jumpToLiteTextHighlight(row);
    });
    list.addEventListener('pointermove', (event) => {
      const rowEl = event.target.closest('.lite-bookmark-row');
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
        if (Number.isInteger(rowIndex)) jumpToLiteTextHighlight(rows[rowIndex]);
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
      if (visibleIndexes.length === 1) jumpToLiteTextHighlight(rows[visibleIndexes[0]]);
    });
    updateRows();
    list.focus();
  }

  function buildProvisionCopyPayload(item, mode) {
    return buildSharedProvisionCopyPayload({
      lawName: lawTitleText,
      numberLabel: item.copyTitle || item.title,
      bodyText: getProvisionCopyText(item),
      url: item.url,
    }, mode);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    }
  }

  function setProvisionSelection(el) {
    selectedProvisionEl?.classList.remove('egov-lite-provision-selected');
    selectedProvisionEl = el || null;
    if (selectedProvisionEl) selectedProvisionEl.classList.add('egov-lite-provision-selected');
  }

  function showArticleLinkDialog() {
    const items = getAllProvisionItems();
    if (!items.length) {
      showToast('コピー対象の条文が見つかりません');
      return;
    }
    const dialog = createDialog('条文リンクコピー', { wide: true });
    const body = dialog.querySelector('.lite-dialog-body');
    body.innerHTML = `
      <div class="lite-link-panel" id="lite-link-panel" tabindex="0">
        <p class="lite-hint">↑/↓ または u/p/n/d: コピー対象移動（条・項・号）</p>
        <p class="lite-hint"><kbd>Enter</kbd>: URL / <kbd>Shift+Enter</kbd>: 法令名+条項+URL / <kbd>Ctrl+Enter</kbd>: 本文付き</p>
        <div class="lite-link-preview" id="lite-link-preview-url"></div>
        <div class="lite-link-preview" id="lite-link-preview-meta"></div>
        <div class="lite-link-preview" id="lite-link-preview-text"></div>
      </div>
    `;
    const panel = body.querySelector('#lite-link-panel');
    const urlEl = body.querySelector('#lite-link-preview-url');
    const metaLineEl = body.querySelector('#lite-link-preview-meta');
    const textEl = body.querySelector('#lite-link-preview-text');
    let selected = currentArticleIndex(items);
    function update(scroll = false) {
      const item = items[selected];
      urlEl.textContent = buildProvisionCopyPayload(item, 'url');
      metaLineEl.textContent = buildProvisionCopyPayload(item, 'law-number-url');
      textEl.textContent = buildProvisionCopyPayload(item, 'text-url');
      setProvisionSelection(item.el);
      if (scroll) scrollToElement(item.el, 'center');
    }
    function move(delta) {
      selected = (selected + delta + items.length) % items.length;
      update(true);
    }
    async function copy(mode) {
      const ok = await copyText(buildProvisionCopyPayload(items[selected], mode));
      showToast(ok ? '条文リンクをコピーしました' : 'コピーに失敗しました');
      if (ok) closeDialog();
    }
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'p' || event.key === 'd' || event.key === 'n') { event.preventDefault(); move(1); }
      else if (event.key === 'ArrowUp' || event.key === 'u') { event.preventDefault(); move(-1); }
      else if (event.key === 'Enter') {
        event.preventDefault();
        copy(event.ctrlKey ? 'text-url' : event.shiftKey ? 'law-number-url' : 'url');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog();
      }
    });
    update(true);
    panel.focus();
  }

  function showShortcutDialog() {
    const dialog = createDialog('Liteショートカット', { wide: true });
    const manualButton = document.createElement('button');
    manualButton.type = 'button';
    manualButton.className = 'lite-manual-button';
    manualButton.textContent = 'マニュアル';
    manualButton.addEventListener('click', openManualPageFromGuide);
    dialog.querySelector('.lite-close').before(manualButton);
    dialog.querySelector('.lite-dialog-body').innerHTML = `
      <div class="lite-shortcut-list">
        <div><kbd>Alt+s</kbd><span>並べて表示の切替</span></div>
        <div><kbd>Alt+O</kbd><span>設定画面を開く</span></div>
        <div><kbd>s</kbd><span>ページ内検索</span></div>
        <div><kbd>0-9</kbd><span>条文ジャンプダイアログ</span></div>
        <div><kbd>h / l</kbd><span>条文ジャンプ履歴を前後移動</span></div>
        <div><kbd>r</kbd><span>ジャンプ前の位置に戻る</span></div>
        <div><kbd>b</kbd><span>条文ブックマーク一覧を開く / 閉じる</span></div>
        <div><kbd>m</kbd><span>ハイライト・メモ一覧を開く / 閉じる</span></div>
        <div><kbd>Space</kbd><span>現在位置の条文ブックマークを追加 / 削除</span></div>
        <div><kbd>n / p</kbd><span>次/前の条へ移動</span></div>
        <div><kbd>d / u</kbd><span>下/上へ80%スクロール</span></div>
        <div><kbd>g / Shift+g</kbd><span>括弧内の表示切替</span></div>
        <div><kbd>e</kbd><span>逆参照リンクを有効化/無効化する</span></div>
        <div><kbd>a</kbd><span>条文リンクコピー</span></div>
        <div><kbd>t</kbd><span>目次</span></div>
        <div><kbd>Tab</kbd><span>並べて表示中の左右ペイン切替</span></div>
        <div><kbd>?</kbd><span>この一覧を表示</span></div>
        <div><kbd>Esc</kbd><span>ダイアログを閉じる</span></div>
      </div>
    `;
  }

  function wrapParentheses() {
    parenSeq = 0;
    parenGroups = new Map();

    function appendSegment(parent, text, depth, group) {
      if (!text) return;
      if (depth <= 0) {
        parent.appendChild(document.createTextNode(text));
        return;
      }
      const span = document.createElement('span');
      span.className = 'egov-lite-paren';
      span.dataset.group = group;
      span.textContent = text;
      if (group) {
        if (!parenGroups.has(group)) parenGroups.set(group, []);
        parenGroups.get(group).push(span);
      }
      parent.appendChild(span);
    }

    function wrapTextNode(textNode, state) {
      const text = textNode.nodeValue || '';
      const frag = document.createDocumentFragment();
      let depth = Math.max(0, state.depth || 0);
      let group = state.group || '';
      let segmentDepth = depth > 0 ? 1 : 0;
      let segmentGroup = group;
      let buffer = '';
      function flush() {
        if (!buffer) return;
        appendSegment(frag, buffer, segmentDepth, segmentGroup);
        buffer = '';
      }
      for (const ch of text) {
        if (ch === '\uFF08') {
          flush();
          if (depth === 0) group = `p${++parenSeq}`;
          depth += 1;
          segmentDepth = 1;
          segmentGroup = group;
          buffer += ch;
        } else if (ch === '\uFF09') {
          buffer += ch;
          flush();
          depth = Math.max(0, depth - 1);
          if (depth === 0) group = '';
          segmentDepth = depth > 0 ? 1 : 0;
          segmentGroup = group;
        } else {
          buffer += ch;
        }
      }
      flush();
      textNode.parentNode.replaceChild(frag, textNode);
      return { depth, group };
    }

    contentEl.querySelectorAll('.law-text p').forEach((paragraph) => {
      const paragraphText = paragraph.textContent || '';
      if (!paragraphText.includes('\uFF08') && !paragraphText.includes('\uFF09')) return;
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest('script, style, mark, .egov-lite-paren')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
      let state = { depth: 0, group: '' };
      nodes.forEach((textNode) => {
        state = wrapTextNode(textNode, state);
      });
    });
  }

  function toggleParenMode(mode) {
    if (!parenthesesWrapped) {
      wrapParentheses();
      parenthesesWrapped = true;
    }
    document.body.dataset.parenMode = document.body.dataset.parenMode === mode ? '' : mode;
    if (!document.body.dataset.parenMode) document.body.removeAttribute('data-paren-mode');
    syncViewerToggleButtons();
  }

  function setParenHover(group) {
    if (activeParenGroup) {
      (parenGroups.get(activeParenGroup) || []).forEach((el) => el.classList.remove('is-hover'));
    }
    activeParenGroup = group || '';
    if (activeParenGroup) {
      (parenGroups.get(activeParenGroup) || []).forEach((el) => el.classList.add('is-hover'));
    }
  }

  contentEl.addEventListener('mouseover', (event) => {
    const span = event.target.closest?.('.egov-lite-paren[data-group]');
    if (!span || !span.dataset.group || activeParenGroup === span.dataset.group) return;
    setParenHover(span.dataset.group);
  });
  contentEl.addEventListener('mouseout', (event) => {
    const span = event.target.closest?.('.egov-lite-paren[data-group]');
    if (!span) return;
    const related = event.relatedTarget?.closest?.('.egov-lite-paren[data-group]');
    if (related?.dataset.group === span.dataset.group) return;
    setParenHover('');
  });
  contentEl.addEventListener('mouseover', (event) => {
    const term = event.target.closest?.('.lite-defined-term[data-term]');
    if (!term || !contentEl.contains(term)) return;
    if (defTooltipClickOnly) return;
    scheduleLiteDefinitionTooltip(term);
  });
  contentEl.addEventListener('mouseout', (event) => {
    if (defTooltipClickOnly) return;
    if (liteTooltipPinned) return;
    const term = event.target.closest?.('.lite-defined-term[data-term]');
    if (!term) return;
    if (event.relatedTarget?.closest?.('.lite-definition-tooltip, .lite-defined-term[data-term]')) return;
    hideLiteTooltip();
  });
  contentEl.addEventListener('focusin', (event) => {
    const term = event.target.closest?.('.lite-defined-term[data-term]');
    if (!defTooltipClickOnly && term) scheduleLiteDefinitionTooltip(term);
  });
  contentEl.addEventListener('focusout', (event) => {
    if (defTooltipClickOnly) return;
    if (liteTooltipPinned) return;
    const term = event.target.closest?.('.lite-defined-term[data-term]');
    if (!term || event.relatedTarget?.closest?.('.lite-definition-tooltip')) return;
    hideLiteTooltip();
  });
  contentEl.addEventListener('click', (event) => {
    const bookmarkButton = event.target.closest?.('.lite-bookmark-gutter');
    if (bookmarkButton && contentEl.contains(bookmarkButton)) {
      event.preventDefault();
      event.stopPropagation();
      const item = getLiteBookmarkProvisionItems()
        .find((candidate) => candidate.targetKey === bookmarkButton.dataset.bookmarkTargetKey);
      if (item) toggleLiteArticleBookmark(item);
      return;
    }
    const term = event.target.closest?.('.lite-defined-term[data-term]');
    if (!term || !contentEl.contains(term)) return;
    event.preventDefault();
    event.stopPropagation();
    clearLiteTooltipTimers();
    showLiteDefinitionTooltip(term);
  });
  contentEl.addEventListener('keydown', (event) => {
    const term = event.target.closest?.('.lite-defined-term[data-term]');
    if (!term || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    clearLiteTooltipTimers();
    showLiteDefinitionTooltip(term);
  });
  document.addEventListener('click', (event) => {
    if (!activeLiteTooltip) return;
    if (event.target.closest?.('.lite-definition-tooltip, .lite-defined-term[data-term]')) return;
    hideLiteTooltip(true);
  });

  leftPaneEl.addEventListener('focusin', () => {
    if (compareMode) setFocusedPane('left');
  });
  rightPaneEl.addEventListener('focusin', () => {
    if (compareMode) setFocusedPane('right');
  });
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const type = event.data?.type;
    if (type === 'egov-lite-focus-left') {
      if (compareMode) setFocusedPane('left');
    } else if (type === 'egov-lite-toggle-compare') {
      if (compareMode) toggleCompareMode(false);
    }
  });

  async function getFavorites() {
    return readFavorites();
  }

  async function refreshFavoriteButton() {
    const favorites = await getFavorites();
    const isFavorite = favorites.some((fav) => fav.lawId === lawId);
    favoriteButton.classList.toggle('is-favorite', isFavorite);
    favoriteButton.textContent = isFavorite ? '★' : '☆';
    favoriteButton.title = isFavorite ? 'お気に入りから削除' : 'お気に入りに追加';
  }

  async function toggleFavorite() {
    const favorites = await getFavorites();
    const result = toggleFavoriteRecord(favorites, {
      lawId,
      lawName: lawTitleText,
      lawNum: lawNumText,
      lawType: '',
      folderId: null,
    });
    showToast(result.isFavorite ? 'お気に入りに追加しました' : 'お気に入りから削除しました');
    await persistLocal({ favorites }, { errorLabel: 'お気に入りの保存' });
    if (result.isFavorite) {
      setupLiteFavoriteScrollPersistence();
      updateLiteFavoriteLocation();
    }
    refreshFavoriteButton();
  }

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const lower = event.key.toLowerCase();
    if (event.altKey && !event.ctrlKey && !event.metaKey && lower === 'o' && !activeDialog && !isInputActive()) {
      event.preventDefault();
      chrome.runtime.openOptionsPage();
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && (lower === 'l' || event.code === 'KeyL') && !activeDialog) {
      event.preventDefault();
      openNormalMode();
      return;
    }
    if (embeddedMode && event.altKey && !event.ctrlKey && !event.metaKey && lower === 's' && !activeDialog && !isInputActive()) {
      event.preventDefault();
      parent.postMessage({ type: 'egov-lite-toggle-compare' }, location.origin);
      return;
    }
    if (embeddedMode && event.key === 'Tab' && !activeDialog && !isInputActive()) {
      event.preventDefault();
      parent.postMessage({ type: 'egov-lite-focus-left' }, location.origin);
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && lower === 's' && !activeDialog && !isInputActive()) {
      event.preventDefault();
      toggleCompareMode();
      return;
    }
    if (compareMode && event.key === 'Tab' && !activeDialog) {
      event.preventDefault();
      setFocusedPane(focusedPane === 'left' ? 'right' : 'left');
      return;
    }
    if (compareMode && focusedPane !== 'left' && !activeDialog) return;
    if (event.key === 'Escape') {
      if (activeDialog) {
        event.preventDefault();
        closeDialog();
      }
      return;
    }
    if (isInputActive()) return;
    const isGuideShortcut = event.key === '?' || (event.shiftKey && (event.key === '/' || event.code === 'Slash'));
    if (isGuideShortcut) { event.preventDefault(); showShortcutDialog(); return; }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key !== ' ' && lower !== 'n' && lower !== 'p') keyboardBookmarkTargetId = '';
    if (/^[0-9]$/.test(event.key)) { event.preventDefault(); showArticleDialog(event.key); return; }
    if (lower === 's') { event.preventDefault(); showSearchDialog(); return; }
    if (lower === 'h') { event.preventDefault(); navigateJumpHistory(-1); return; }
    if (lower === 'l') { event.preventDefault(); navigateJumpHistory(1); return; }
    if (lower === 'b' && !activeDialog) { event.preventDefault(); showLiteBookmarkDialog(); return; }
    if (lower === 'm' && !activeDialog) { event.preventDefault(); showLiteTextHighlightListDialog(); return; }
    if (!activeDialog && (event.key === ' ' || event.code === 'Space')) {
      event.preventDefault();
      if (!event.repeat) toggleLiteBookmarkAtCurrentPosition();
      return;
    }
    if (lower === 'n') { event.preventDefault(); navigateArticle(1); return; }
    if (lower === 'p') { event.preventDefault(); navigateArticle(-1); return; }
    if (lower === 'd') { event.preventDefault(); scrollPage(0.8); return; }
    if (lower === 'u') { event.preventDefault(); scrollPage(-0.8); return; }
    if (lower === 'r' && !activeDialog) {
      const returnButton = document.getElementById('lite-jump-return');
      if (returnButton) {
        event.preventDefault();
        returnButton.click();
      }
      return;
    }
    if (lower === 'g' && event.shiftKey) { event.preventDefault(); toggleParenMode('nested'); return; }
    if (lower === 'g') { event.preventDefault(); toggleParenMode('flat'); return; }
    if (lower === 'e') { event.preventDefault(); toggleExternalReferenceLinks(); return; }
    if (lower === 'a') { event.preventDefault(); showArticleLinkDialog(); return; }
    if (lower === 't') { event.preventDefault(); showTocDialog(); }
  });

  document.addEventListener('wheel', () => { keyboardBookmarkTargetId = ''; }, { passive: true });
  document.addEventListener('pointerdown', () => { keyboardBookmarkTargetId = ''; });

  chrome.storage.local.get([TEXT_HIGHLIGHTS_ENABLED_KEY]).then((stored) => {
    if (stored[TEXT_HIGHLIGHTS_ENABLED_KEY] === false) return;
    textHighlightController = globalThis.EgovTextHighlights?.create({
      root: contentEl,
      lawId,
      onBeforeOpen() {
        hideLiteTooltip(true);
        hideReferencesPopup();
        hideUnpinnedReferenceViewerPopups();
      },
    }) || null;
  }).catch(() => {});
  setupExternalReferenceInteractions();
  loadLaw();
})();
