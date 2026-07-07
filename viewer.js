(function () {
  'use strict';

  const shared = globalThis.EgovShared;
  const {
    buildProvisionCopyPayload: buildSharedProvisionCopyPayload,
    cloneDefinitionPatterns,
    escapeHtml,
    extractInlineAliasDefinition: extractSharedInlineAliasDefinition,
    extractLaws,
    extractTermBeforeParentheticalDefinition: extractSharedTermBeforeParentheticalDefinition,
    formatProvisionNumber,
    formatProvisionSourcePathFromEgovUrl,
    isTermBoundarySafe: isSharedTermBoundarySafe,
    normalizeLawNameForCopy,
  } = shared;
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
  let selectedProvisionEl = null;
  let scrollBehavior = 'instant';
  let compareMode = false;
  let focusedPane = 'left';
  let compareResults = [];
  let compareResultButtons = [];
  let compareFocusedIndex = -1;
  let lawRefClickEnabled = true;
  let lawRefOtherLawPopupEnabled = true;
  let liteDefTooltipEnabled = true;
  let defTooltipClickOnly = true;
  let externalReferencesAutoEnable = true;
  let externalReferencesEnabled = false;
  let referencesDataPromise = null;
  let activeReferencesPopup = null;
  let activeReferenceViewerPopup = null;
  let liteDefinitionMap = new Map();
  let activeLiteTooltip = null;
  let liteTooltipPinned = false;
  let liteTooltipShowTimer = 0;
  let liteTooltipHideTimer = 0;
  let jumpReturnButtonTimer = 0;
  const externalReferencesByElement = new WeakMap();
  titleEl.textContent = fallbackLawName;
  document.body.dataset.fontSize = '2';
  document.body.dataset.contentWidth = 'full';
  if (embeddedMode) document.body.dataset.embedded = 'true';

  function applyFontSize(value) {
    const next = VALID_FONT_SIZES.has(String(value)) ? String(value) : '2';
    document.body.dataset.fontSize = next;
    fontSizeSelect.value = next;
  }

  function applyContentWidth(value) {
    const next = VALID_CONTENT_WIDTHS.has(String(value)) ? String(value) : 'full';
    document.body.dataset.contentWidth = next;
    contentWidthSelect.value = next;
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

  normalModeButton.addEventListener('click', openNormalMode);
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

  chrome.storage.local.get([
    'scrollBehavior',
    LITE_FONT_SIZE_KEY,
    LITE_CONTENT_WIDTH_KEY,
    'lawRefClickEnabled',
    'lawRefOtherLawPopup',
    LITE_DEF_TOOLTIP_ENABLED_KEY,
    DEF_TOOLTIP_CLICK_ONLY_KEY,
    EXTERNAL_REFERENCES_AUTO_ENABLE_KEY,
  ]).then((stored) => {
    applyFontSize(stored[LITE_FONT_SIZE_KEY]);
    applyContentWidth(stored[LITE_CONTENT_WIDTH_KEY]);
    if (stored.scrollBehavior === 'smooth') scrollBehavior = 'smooth';
    lawRefClickEnabled = stored.lawRefClickEnabled !== false;
    lawRefOtherLawPopupEnabled = stored.lawRefOtherLawPopup !== false;
    liteDefTooltipEnabled = stored[LITE_DEF_TOOLTIP_ENABLED_KEY] !== false;
    defTooltipClickOnly = stored[DEF_TOOLTIP_CLICK_ONLY_KEY] !== false;
    if (!liteDefTooltipEnabled) clearLiteDefinitionTooltips();
    externalReferencesAutoEnable = stored[EXTERNAL_REFERENCES_AUTO_ENABLE_KEY] !== false;
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.scrollBehavior) {
      scrollBehavior = changes.scrollBehavior.newValue === 'smooth' ? 'smooth' : 'instant';
    }
    if (area === 'local' && changes[LITE_FONT_SIZE_KEY]) applyFontSize(changes[LITE_FONT_SIZE_KEY].newValue);
    if (area === 'local' && changes[LITE_CONTENT_WIDTH_KEY]) applyContentWidth(changes[LITE_CONTENT_WIDTH_KEY].newValue);
    if (area === 'local' && changes.lawRefClickEnabled) lawRefClickEnabled = changes.lawRefClickEnabled.newValue !== false;
    if (area === 'local' && changes.lawRefOtherLawPopup) lawRefOtherLawPopupEnabled = changes.lawRefOtherLawPopup.newValue !== false;
    if (area === 'local' && changes[LITE_DEF_TOOLTIP_ENABLED_KEY]) {
      liteDefTooltipEnabled = changes[LITE_DEF_TOOLTIP_ENABLED_KEY].newValue !== false;
      if (liteDefTooltipEnabled) {
        applyLiteDefinitionTooltips();
      } else {
        clearLiteDefinitionTooltips();
      }
    }
    if (area === 'local' && changes[DEF_TOOLTIP_CLICK_ONLY_KEY]) {
      defTooltipClickOnly = changes[DEF_TOOLTIP_CLICK_ONLY_KEY].newValue !== false;
      hideLiteTooltip(true);
    }
    if (area === 'local' && changes[EXTERNAL_REFERENCES_AUTO_ENABLE_KEY]) {
      externalReferencesAutoEnable = changes[EXTERNAL_REFERENCES_AUTO_ENABLE_KEY].newValue !== false;
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

  function runWhenIdle(callback, timeout = 1500) {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(callback, { timeout });
      return;
    }
    setTimeout(callback, Math.min(timeout, 250));
  }

  // chrome.storage.local への保存を共通化（失敗時はログのみ）
  function persistLocal(items) {
    chrome.storage.local.set(items).catch((error) => {
      console.warn('[e-Gov Enhancer] 設定の保存に失敗しました', error);
    });
  }

  // タイムアウト付き fetch（ハングした e-Gov API 応答で無限待機しないため）
  function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
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

  // extractLaws は EgovShared のものを利用（本ファイル冒頭で分割代入）。
  // getLawFields は既定値（lawName の未設定時）が共有版と異なるため、ローカル定義を維持する。
  function getLawFields(law) {
    const info = law?.law_info || {};
    const rev = law?.current_revision_info || law?.revision_info || {};
    return {
      lawId: info.law_id || law?.law_id || '',
      lawName: rev.law_title || rev.abbrev || law?.law_title || law?.law_name || '',
      lawNum: info.law_num || law?.law_num || '',
      lawType: info.law_type || rev.law_type || '',
    };
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

  function getArticleId(num) {
    return getAnchorId(`article-${safeIdPart(num)}`);
  }

  function getChildId(prefix, articleNum, childNum, itemNum = '') {
    return getAnchorId([prefix, articleNum, childNum, itemNum].filter(Boolean).map(safeIdPart).join('-'));
  }

  function renderInline(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.nodeValue || '');
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

  function renderParagraph(paragraph, articleNum) {
    const rawNum = paragraph.getAttribute('Num') || '';
    const num = getNodeText(firstChildOfTag(paragraph, 'ParagraphNum')) || (rawNum && rawNum !== '1' ? rawNum : '');
    const normalizedNum = rawNum || (num ? num : '1');
    const sentence = firstChildOfTag(paragraph, 'ParagraphSentence') || paragraph;
    const id = getChildId('paragraph', articleNum, normalizedNum);
    const textHtml = renderTextBlock(sentence);
    const itemHtml = childElements(paragraph, 'Item').map((item) => renderItem(item, articleNum, normalizedNum)).join('');
    return `<div class="law-paragraph" id="${escapeHtml(id)}" data-article-num="${escapeHtml(articleNum)}" data-paragraph-num="${escapeHtml(normalizedNum)}">${num ? `<div class="law-num">${escapeHtml(num)}</div>` : '<div class="law-num" aria-hidden="true"></div>'}<div>${textHtml}${itemHtml}</div></div>`;
  }

  function renderItemLike(el, titleTag, sentenceTag, className, articleNum, paragraphNum, parentPath = '') {
    const title = getNodeText(firstChildOfTag(el, titleTag)) || el.getAttribute('Num') || '';
    const itemNum = el.getAttribute('Num') || title || parentPath;
    const id = getChildId('item', articleNum, paragraphNum, itemNum);
    const sentence = firstChildOfTag(el, sentenceTag) || el;
    const children = childElements(el)
      .filter((child) => /^Subitem\d+$/.test(child.tagName))
      .map((child) => renderSubitem(child, articleNum, paragraphNum, `${itemNum}-${child.getAttribute('Num') || ''}`))
      .join('');
    return `<div class="${className}" id="${escapeHtml(id)}" data-article-num="${escapeHtml(articleNum)}" data-paragraph-num="${escapeHtml(paragraphNum)}" data-item-num="${escapeHtml(itemNum)}">${title ? `<div class="law-num">${escapeHtml(title)}</div>` : '<div class="law-num" aria-hidden="true"></div>'}<div>${renderTextBlock(sentence)}${children}</div></div>`;
  }

  function renderItem(item, articleNum, paragraphNum) {
    return renderItemLike(item, 'ItemTitle', 'ItemSentence', 'law-item', articleNum, paragraphNum);
  }

  function renderSubitem(subitem, articleNum, paragraphNum, path) {
    const level = subitem.tagName.match(/\d+$/)?.[0] || '';
    return renderItemLike(subitem, `Subitem${level}Title`, `Subitem${level}Sentence`, 'law-subitem', articleNum, paragraphNum, path);
  }

  function renderArticle(article) {
    const articleNum = article.getAttribute('Num') || getNodeText(firstChildOfTag(article, 'ArticleTitle')) || '';
    const title = firstChildOfTag(article, 'ArticleTitle');
    const caption = firstChildOfTag(article, 'ArticleCaption');
    const titleText = getNodeText(title) || (articleNum ? `Article ${articleNum}` : 'Article');
    const id = getArticleId(articleNum || titleText);
    const captionText = getNodeText(caption);
    const paragraphs = childElements(article, 'Paragraph').map((paragraph) => renderParagraph(paragraph, articleNum)).join('');
    return `<section class="law-article" id="${escapeHtml(id)}" data-article-num="${escapeHtml(articleNum)}">${captionText ? `<div class="article-caption">${escapeHtml(captionText)}</div>` : ''}${titleText ? `<div class="article-title">${escapeHtml(titleText)}</div>` : ''}${paragraphs || renderTextBlock(article)}</section>`;
  }

  function renderContainer(el) {
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag) || tag === 'TOC') return '';
    if (tag === 'Article') return renderArticle(el);
    if (tag === 'Paragraph') return renderParagraph(el, '');
    if (tag === 'Item') return renderItem(el, '', '');
    if (/^Subitem\d+$/.test(tag)) return renderSubitem(el, '', '', '');
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
    return `<section class="${className}">${childrenHtml}</section>`;
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
    const parts = String(key || '').trim().split('.');
    const article = parts.shift() || '';
    const suffix = parts.join('.');
    return articleKeyVariants(article).map((variant) => suffix ? `${variant}.${suffix}` : variant);
  }

  function articleKeyToDisplay(value) {
    const parts = normalizeArticleKey(value).split('_').filter(Boolean);
    if (!parts.length) return '';
    return `第${parts[0]}条${parts.slice(1).map((part) => `の${part}`).join('')}`;
  }

  function numToDisplay(raw) {
    if (!raw) return '';
    const parts = String(raw).split('.');
    let text = articleKeyToDisplay(parts[0]);
    if (parts[1]) text += `第${parts[1]}項`;
    if (parts[2]) text += `第${parts[2]}号`;
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
      const keys = articleKeyVariants(num);
      for (const articleKey of keys) {
        if (!articleIndex.has(articleKey)) articleIndex.set(articleKey, article);
      }
      article.querySelectorAll('[data-paragraph-num], [data-item-num]').forEach((el) => {
        const para = el.dataset.paragraphNum || '';
        const item = el.dataset.itemNum || '';
        for (const articleKey of keys) {
          if (para && !articleIndex.has(`${articleKey}.${para}`)) articleIndex.set(`${articleKey}.${para}`, el);
          if (para && item && !articleIndex.has(`${articleKey}.${para}.${item}`)) articleIndex.set(`${articleKey}.${para}.${item}`, el);
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

  function trimDefinitionText(value, maxLength = 220) {
    const text = normalizeCopyText(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
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
    if (parent.closest('a, button, script, style, mark, .law-title, .law-heading, .article-title, .article-caption, .egov-lite-paren, .lite-defined-term, .egov-lite-reference-number, .egov-lite-reference-clickable')) return true;
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

  function markDefinedTerms(definitions) {
    const defs = Array.from(definitions.values()).sort((a, b) => b.term.length - a.term.length);
    if (!defs.length) return;
    const byTerm = new Map(defs.map((def) => [def.term, def]));
    const pattern = new RegExp(defs.map((def) => escapeRegExp(def.term)).join('|'), 'g');
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, {
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
        span.className = 'lite-defined-term';
        span.dataset.term = term;
        span.tabIndex = 0;
        span.textContent = term;
        fragment.appendChild(span);
        lastIndex = end;
        changed = true;
      }
      if (!changed) continue;
      if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      textNode.parentNode.replaceChild(fragment, textNode);
    }
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
    hideLiteTooltip(true);
    liteDefinitionMap = new Map();
    unwrapElements('.lite-defined-term');
  }

  function applyLiteDefinitionTooltips() {
    clearLiteDefinitionTooltips();
    if (!liteDefTooltipEnabled || !contentEl.querySelector('.law-article')) return;
    const startedAt = performance.now();
    liteDefinitionMap = extractDefinitions();
    markDefinedTerms(liteDefinitionMap);
    const markedCount = contentEl.querySelectorAll('.lite-defined-term').length;
    console.debug(`[e-Gov Enhancer] Lite 定義用語ガイド: extract+mark ${(performance.now() - startedAt).toFixed(1)}ms (${liteDefinitionMap.size} terms / ${markedCount} marks)`);
  }

  function scheduleApplyLiteDefinitionTooltips() {
    runWhenIdle(applyLiteDefinitionTooltips, 900);
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
    rebuildArticleIndex();
    wrapParentheses();
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
        const current = revisions.find((rev) => rev.current_revision_status === 'CurrentEnforced') || revisions[0];
        currentRevisionId = current?.law_revision_id || '';
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
    revisionSelect.innerHTML = revisions.map((rev) => {
      const date = rev.amendment_enforcement_date || rev.amendment_scheduled_enforcement_date || '';
      const status = rev.current_revision_status === 'CurrentEnforced' ? ' 現行' : rev.current_revision_status === 'UnEnforced' ? ' 未施行' : '';
      const label = `${date || '日付不明'}${status} / ${rev.amendment_law_num || rev.amendment_law_title || rev.law_revision_id}`;
      return `<option value="${escapeHtml(rev.law_revision_id)}">${escapeHtml(label)}</option>`;
    }).join('');
    revisionSelect.disabled = false;
    if (currentRevisionId) revisionSelect.value = currentRevisionId;
  }

  async function loadLaw() {
    if (!lawId) {
      contentEl.innerHTML = '<p class="viewer-error">法令IDが指定されていません。</p>';
      return;
    }
    contentEl.innerHTML = '<p class="viewer-status">e-Gov APIから条文XMLを読み込んでいます...</p>';
    try {
      await loadRevisions();
      const target = currentRevisionId || lawId;
      const url = `${API_V2_BASE}/law_data/${encodeURIComponent(target)}?response_format=xml&law_full_text_format=xml`;
      const response = await fetchWithTimeout(url, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const xmlText = await response.text();
      const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('XML parse error');
      const law = parseLawFromResponse(doc);
      if (!law) throw new Error('Law XML was not found');
      renderLaw(law, doc);
      jumpToInitialHash();
      if (externalReferencesEnabled) {
        applyExternalReferenceLinksForLaw(await getLawReferencesData(lawId));
      } else {
        const stored = await chrome.storage.local.get([EXTERNAL_REFERENCES_AUTO_ENABLE_KEY]).catch(() => ({}));
        if (stored[EXTERNAL_REFERENCES_AUTO_ENABLE_KEY] !== false && externalReferencesAutoEnable) {
          runWhenIdle(() => enableExternalReferenceLinks(), 600);
        }
      }
      await refreshFavoriteButton();
    } catch (error) {
      contentEl.innerHTML = `<p class="viewer-error">条文の読み込みに失敗しました。${escapeHtml(error.message || '')}</p>`;
    }
  }

  function isInputActive() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function createDialog(title, { wide = false } = {}) {
    closeDialog();
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

  function closeDialog() {
    if (activeDialog) {
      if (activeDialog.dataset.dialogType === 'search') clearSearchMarks();
      activeDialog.remove();
      activeDialog = null;
    }
    setProvisionSelection(null);
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

  function cleanLawNameForSearch(name) {
    return String(name || '')
      .replace(/（[^）]*）/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/(?:施行規則|施行令)$/, '')
      .trim();
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
  }

  function pushHistory(history, value) {
    if (!value) return;
    const idx = history.indexOf(value);
    if (idx !== -1) history.splice(idx, 1);
    history.unshift(value);
    if (history.length > 30) history.length = 30;
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
    const parts = String(key || '').trim().split('.');
    if (parts.length > 1 && articleIndex.has(parts[0])) return articleIndex.get(parts[0]);
    if (parts.length > 1) {
      for (const variant of articleKeyVariants(parts[0])) {
        if (articleIndex.has(variant)) return articleIndex.get(variant);
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
    scrollToElement(target, 'start');
    setTimeout(() => flashJumpTarget(target), scrollBehavior === 'smooth' ? 220 : 0);
    if (record) pushJumpHistory(key);
    showJumpHistoryIndicator();
    if (returnPosition) showJumpReturnButton(returnPosition);
    return true;
  }

  function splitReferenceTargetKey(key) {
    const [article = '', paragraph = '', item = ''] = String(key || '').split('.');
    return { article, paragraph, item };
  }

  function getReferenceDomParts(parts) {
    if (parts?.article && parts.paragraph === '1' && !parts.item) {
      return { article: parts.article, paragraph: '', item: '' };
    }
    return parts;
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
    if (parts.item) return findJumpTarget(`${parts.article}.${parts.paragraph || '1'}.${parts.item}`);
    if (parts.paragraph) return findJumpTarget(`${parts.article}.${parts.paragraph}`);
    return findJumpTarget(parts.article);
  }

  function findLiteReferenceClickableElement(target, targetKey) {
    if (!(target instanceof Element)) return null;
    const parts = getReferenceDomParts(splitReferenceTargetKey(targetKey));
    const numberRoot = parts.item || parts.paragraph
      ? target.querySelector(':scope > .law-num')
      : target.querySelector(':scope > .article-title');
    return ensureReferenceNumberElement(numberRoot || target, parts);
  }

  function formatReferenceBranchNumber(value) {
    return String(value || '').split(/[-_]/).filter(Boolean).join('の');
  }

  function getReferenceTargetLabel(targetKey) {
    const parts = splitReferenceTargetKey(targetKey);
    if (!parts.article) return targetKey;
    let label = `第${formatReferenceBranchNumber(parts.article)}条`;
    if (parts.paragraph) label += `第${formatReferenceBranchNumber(parts.paragraph)}項`;
    if (parts.item) label += `第${formatReferenceBranchNumber(parts.item)}号`;
    return label;
  }

  function getReferenceSourceLabel(source) {
    const title = String(source?.sourceLawTitle || source?.sourceLawId || '').trim();
    const path = formatProvisionSourcePathFromEgovUrl(source?.sourceUrl, location.href);
    return [title, path].filter(Boolean).join(' ');
  }

  function getReferenceSourceSortInfo(source, index) {
    const cleanName = typeof normalizeLawNameForCopy === 'function' ? normalizeLawNameForCopy : (value) => String(value || '').trim();
    const currentTitle = cleanName(lawTitleText);
    const currentPrefix = currentTitle.slice(0, 5);
    const sourceTitle = cleanName(source?.sourceLawTitle || '');
    const sourcePrefix = sourceTitle.slice(0, 5);
    return {
      source,
      index,
      isRelated: !!(
        (currentPrefix && sourceTitle.includes(currentPrefix)) ||
        (sourcePrefix && currentTitle.includes(sourcePrefix))
      ),
    };
  }

  function sortReferenceSources(sources) {
    return sources
      .map(getReferenceSourceSortInfo)
      .sort((a, b) => {
        if (a.isRelated !== b.isRelated) return a.isRelated ? -1 : 1;
        return a.index - b.index;
      });
  }

  function hideReferencesPopup() {
    activeReferencesPopup?.remove();
    activeReferencesPopup = null;
  }

  function hideReferenceViewerPopup() {
    try {
      if (typeof activeReferenceViewerPopup?.remove === 'function') {
        activeReferenceViewerPopup.remove();
      } else if (activeReferenceViewerPopup && !activeReferenceViewerPopup.closed) {
        activeReferenceViewerPopup.close();
      }
    } catch (_) {}
    activeReferenceViewerPopup = null;
  }

  function positionFixedPopup(popup, point, { offset = 10 } = {}) {
    const margin = 10;
    const rect = popup.getBoundingClientRect();
    const x = Math.min(
      Math.max(margin, (point?.x ?? window.innerWidth / 2) + offset),
      Math.max(margin, window.innerWidth - rect.width - margin)
    );
    const y = Math.min(
      Math.max(margin, (point?.y ?? window.innerHeight / 2) + offset),
      Math.max(margin, window.innerHeight - rect.height - margin)
    );
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
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

  function showReferencesPopup({ targetKey, sources, point }) {
    const list = Array.isArray(sources) ? sources : [];
    if (!list.length) return;
    const rows = sortReferenceSources(list);
    hideReferencesPopup();

    const popup = document.createElement('div');
    popup.className = 'egov-lite-reference-popup';
    popup.setAttribute('role', 'dialog');
    popup.innerHTML = `
      <div class="egov-lite-reference-popup-head">
        <div class="egov-lite-reference-target">${escapeHtml(getReferenceTargetLabel(targetKey))}</div>
        <button type="button" class="egov-lite-reference-close" aria-label="閉じる">×</button>
      </div>
      <div class="egov-lite-reference-list">
        ${rows.map((row, index) => `
          <button type="button" class="egov-lite-reference-link${row.isRelated ? ' egov-lite-reference-link-related' : ''}" data-index="${index}">
            <span class="egov-lite-reference-related-badge">${row.isRelated ? '関連' : ''}</span>
            <span class="egov-lite-reference-link-title">${escapeHtml(getReferenceSourceLabel(row.source))}</span>
            <span class="egov-lite-reference-link-url">${escapeHtml(row.source?.sourceUrl || '')}</span>
          </button>
        `).join('')}
      </div>
    `;
    document.body.appendChild(popup);
    activeReferencesPopup = popup;
    positionFixedPopup(popup, point);
    popup.addEventListener('click', (event) => event.stopPropagation());
    popup.querySelector('.egov-lite-reference-close')?.addEventListener('click', hideReferencesPopup);
    popup.querySelectorAll('.egov-lite-reference-link').forEach((button) => {
      button.addEventListener('click', (event) => {
        const row = rows[Number(button.dataset.index)];
        openReferenceSource(row?.source, event);
      });
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
    try {
      const hash = decodeURIComponent(new URL(url, location.href).hash || '').replace(/^#/, '');
      const article = hash.match(/-At_([\d_]+)/)?.[1] || '';
      const paragraph = hash.match(/-Pr_([\d_]+)/)?.[1] || '';
      const item = hash.match(/-(?:It|Sg)_([\d_]+)/)?.[1] || '';
      return [article, paragraph, item].filter(Boolean).join('.');
    } catch (_) {
      return '';
    }
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
    let shouldPopup = lawRefClickEnabled === false;
    if (lawRefClickEnabled !== false && lawRefOtherLawPopupEnabled && isDifferentLaw) shouldPopup = true;
    return event?.ctrlKey ? !shouldPopup : shouldPopup;
  }

  function showReferenceViewerPopup(source, url, point) {
    hideReferenceViewerPopup();
    const width = Math.min(920, Math.max(640, Math.round(window.innerWidth * 0.72)));
    const height = Math.min(760, Math.max(520, Math.round(window.innerHeight * 0.82)));
    const left = Math.max(0, Math.round(window.screenX + (point?.x ?? window.innerWidth / 2) + 14));
    const top = Math.max(0, Math.round(window.screenY + (point?.y ?? window.innerHeight / 2) + 14));
    const features = [
      'popup=yes',
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
      'resizable=yes',
      'scrollbars=yes',
    ].join(',');
    activeReferenceViewerPopup = window.open(url, 'egov-lite-reference-popup', features);
    if (!activeReferenceViewerPopup) window.open(url, '_blank', 'noopener');
  }

  function openReferenceSource(source, event = null) {
    if (!source) return;
    const sourceLawId = source.sourceLawId || getLawIdFromUrl(source.sourceUrl || '');
    const provisionKey = parseProvisionKeyFromEgovUrl(source.sourceUrl || '');
    const point = event ? { x: event.clientX, y: event.clientY } : null;
    hideReferencesPopup();

    if (sourceLawId === lawId && provisionKey && jumpToKey(provisionKey)) return;

    const url = buildNormalReferenceSourceUrl(source);
    if (!url) return;
    if (shouldOpenReferenceSourcePopup(event || {}, sourceLawId)) {
      showReferenceViewerPopup(source, url, point);
      return;
    }
    window.open(url, '_blank', 'noopener');
  }

  async function loadReferencesData() {
    try {
      const response = await fetchWithTimeout(chrome.runtime.getURL('data/references.json'), { cache: 'force-cache' });
      if (!response.ok) return null;
      return response.json();
    } catch (error) {
      console.warn('[e-Gov Enhancer] 参照データの読み込みに失敗しました', error);
      return null;
    }
  }

  function getReferencesData() {
    if (!referencesDataPromise) {
      referencesDataPromise = loadReferencesData().then((data) => {
        // 取得失敗（null）はキャッシュせず、次回の再取得を許可する
        if (!data) referencesDataPromise = null;
        return data;
      });
    }
    return referencesDataPromise;
  }

  async function getLawReferencesData(targetLawId) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'egov-get-imported-law-references',
        lawId: targetLawId,
      });
      if (response?.ok && response.lawReferences && Object.keys(response.lawReferences).length) {
        return response.lawReferences;
      }
    } catch (_) {}

    const references = await getReferencesData();
    return references?.[targetLawId] || {};
  }

  function clearExternalReferenceLinks() {
    hideReferencesPopup();
    contentEl.querySelectorAll('.egov-lite-reference-clickable').forEach((el) => {
      el.classList.remove('egov-lite-reference-clickable');
      delete el.dataset.egovReferenceTargetKey;
      el.removeAttribute('title');
      el.removeAttribute('tabindex');
    });
  }

  function makeReferenceClickable(target, targetKey, sources) {
    if (!(target instanceof Element) || !sources?.length) return;
    const clickable = findLiteReferenceClickableElement(target, targetKey);
    if (!(clickable instanceof Element)) return;
    clickable.classList.add('egov-lite-reference-clickable');
    clickable.tabIndex = clickable.tabIndex >= 0 ? clickable.tabIndex : 0;
    clickable.title = `外部法令からの参照元 ${sources.length}件`;
    clickable.dataset.egovReferenceTargetKey = targetKey;
    externalReferencesByElement.set(clickable, sources);
    if (clickable.dataset.egovReferenceBound === 'true') return;
    clickable.dataset.egovReferenceBound = 'true';
    clickable.addEventListener('click', (event) => {
      if (!externalReferencesEnabled) return;
      event.preventDefault();
      event.stopPropagation();
      showReferencesPopup({
        targetKey: clickable.dataset.egovReferenceTargetKey,
        sources: externalReferencesByElement.get(clickable),
        point: { x: event.clientX, y: event.clientY },
      });
    });
    clickable.addEventListener('keydown', (event) => {
      if (!externalReferencesEnabled) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const rect = clickable.getBoundingClientRect();
      showReferencesPopup({
        targetKey: clickable.dataset.egovReferenceTargetKey,
        sources: externalReferencesByElement.get(clickable),
        point: { x: rect.left, y: rect.bottom },
      });
    });
  }

  function applyExternalReferenceLinksForLaw(lawReferences) {
    clearExternalReferenceLinks();
    const entries = Object.entries(lawReferences || {});
    let index = 0;
    const step = () => {
      if (!externalReferencesEnabled) return;
      const end = Math.min(entries.length, index + 160);
      for (; index < end; index += 1) {
        if (!externalReferencesEnabled) return;
        const [targetKey, value] = entries[index];
        const sources = Array.isArray(value?.externalLawSources) ? value.externalLawSources : [];
        if (!sources.length) continue;
        const target = findLiteReferenceTargetElement(targetKey);
        if (!(target instanceof Element)) continue;
        makeReferenceClickable(target, targetKey, sources);
      }
      if (index < entries.length) runWhenIdle(step, 250);
    };
    step();
  }

  async function enableExternalReferenceLinks({ silent = false } = {}) {
    if (externalReferencesEnabled) return true;
    if (!contentEl.querySelector('.law-article')) {
      if (!silent) showToast('条文の読み込み完了後にもう一度試してください');
      return false;
    }
    if (!silent) showToast('外部法令からの参照元リンクを読み込んでいます');
    const lawReferences = await getLawReferencesData(lawId);
    if (!Object.keys(lawReferences).length) {
      if (!silent) showToast('外部法令からの参照元リンクはありません');
      return false;
    }
    externalReferencesEnabled = true;
    applyExternalReferenceLinksForLaw(lawReferences);
    if (!silent) showToast('外部法令からの参照元リンクを有効化しました');
    return true;
  }

  function disableExternalReferenceLinks({ silent = false } = {}) {
    if (!externalReferencesEnabled) return;
    externalReferencesEnabled = false;
    clearExternalReferenceLinks();
    if (!silent) showToast('外部法令からの参照元リンクを無効化しました');
  }

  function toggleExternalReferenceLinks() {
    if (externalReferencesEnabled) {
      disableExternalReferenceLinks();
      return;
    }
    enableExternalReferenceLinks();
  }

  function setupExternalReferenceInteractions() {
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.egov-lite-reference-popup, .egov-lite-reference-viewer-popup, .egov-lite-reference-clickable')) return;
      hideReferencesPopup();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideReferencesPopup();
        hideReferenceViewerPopup();
        hideLiteTooltip(true);
      }
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
    button.textContent = `ジャンプ前の位置に戻る${position.guide ? `（${position.guide}）` : ''}`;
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

  function getArticleAtViewportRatio(ratio = 0.25) {
    const articles = Array.from(contentEl.querySelectorAll('.law-article'));
    if (!articles.length) return null;
    const viewportTop = compareMode ? leftPaneEl.getBoundingClientRect().top : 0;
    const normalizedRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
    const y = viewportTop + (compareMode ? leftPaneEl.clientHeight : window.innerHeight) * normalizedRatio;
    let current = articles[0];
    for (const article of articles) {
      if (article.getBoundingClientRect().top <= y) current = article;
      else break;
    }
    return current;
  }

  function getArticleAtViewport() {
    return getArticleAtViewportRatio(0.25);
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
    const articles = Array.from(contentEl.querySelectorAll('.law-article'));
    if (!articles.length) return;
    const current = getArticleAtViewport();
    const idx = Math.max(0, articles.indexOf(current));
    const next = articles[Math.max(0, Math.min(articles.length - 1, idx + delta))];
    if (next) {
      scrollToElement(next, 'start');
      setTimeout(() => flashJumpTarget(next), scrollBehavior === 'smooth' ? 220 : 0);
    }
  }

  function navigateJumpHistory(dir) {
    const next = articleJumpCursor + dir;
    if (next < 0 || next >= articleJumpHistory.length) {
      showToast('履歴がありません');
      return;
    }
    articleJumpCursor = next;
    jumpToKey(articleJumpHistory[articleJumpCursor], false);
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
    if (compareMode) {
      const pane = leftPaneEl.contains(range.commonAncestorContainer) ? leftPaneEl : rightPaneEl;
      const paneRect = pane.getBoundingClientRect();
      pane.scrollTo({
        top: Math.max(0, rect.top - paneRect.top + pane.scrollTop - pane.clientHeight * 0.35),
        behavior: scrollBehavior,
      });
      return;
    }
    window.scrollTo({
      top: Math.max(0, rect.top + window.scrollY - window.innerHeight * 0.35),
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

  function collectSearchTextSegments(searchRoot) {
    const segments = [];
    let text = '';
    const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('script, style')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const nodeText = node.nodeValue || '';
      if (!nodeText) continue;
      segments.push({ node, start: text.length, text: nodeText });
      text += nodeText;
    }
    return { text, segments };
  }

  function findSearchSegment(segments, index) {
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const segment = segments[mid];
      const end = segment.start + segment.text.length;
      if (index < segment.start) high = mid - 1;
      else if (index >= end) low = mid + 1;
      else return segment;
    }
    return null;
  }

  function rangeFromSearchOffsets(segments, start, end) {
    const startSegment = findSearchSegment(segments, start);
    const endSegment = findSearchSegment(segments, end - 1);
    if (!startSegment || !endSegment) return null;
    const range = document.createRange();
    range.setStart(startSegment.node, start - startSegment.start);
    range.setEnd(endSegment.node, end - endSegment.start);
    return range;
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
      if (query) {
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
            title: itemLabel,
            copyTitle: itemLabel,
            url: `${baseUrl}#${encodeURIComponent(item.id)}`,
          });
        });
      });
    });
    return items;
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
    dialog.querySelector('.lite-dialog-body').innerHTML = `
      <div class="lite-shortcut-list">
        <div><kbd>Alt+s</kbd><span>並べて表示の切替</span></div>
        <div><kbd>Alt+O</kbd><span>設定画面を開く</span></div>
        <div><kbd>s</kbd><span>ページ内検索</span></div>
        <div><kbd>0-9</kbd><span>条文ジャンプダイアログ</span></div>
        <div><kbd>h / l</kbd><span>条文ジャンプ履歴を前後移動</span></div>
        <div><kbd>n / p</kbd><span>次/前の条へ移動</span></div>
        <div><kbd>d / u</kbd><span>下/上へ80%スクロール</span></div>
        <div><kbd>g / Shift+g</kbd><span>括弧内の表示切替</span></div>
        <div><kbd>e</kbd><span>外部法令からの参照元リンクを有効化/無効化する</span></div>
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
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue || '';
        if (!text.includes('\uFF08') && !text.includes('\uFF09')) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('script, style, mark, .law-title, .law-heading, .article-title, .article-caption, .egov-lite-paren')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const textNode of nodes) {
      const text = textNode.nodeValue || '';
      const frag = document.createDocumentFragment();
      let depth = 0;
      let group = '';
      let buffer = '';
      function flush() {
        if (!buffer) return;
        if (depth > 0 || buffer.startsWith('\uFF08')) {
          const span = document.createElement('span');
          span.className = 'egov-lite-paren';
          span.dataset.group = group;
          span.textContent = buffer;
          if (group) {
            if (!parenGroups.has(group)) parenGroups.set(group, []);
            parenGroups.get(group).push(span);
          }
          frag.appendChild(span);
        } else {
          frag.appendChild(document.createTextNode(buffer));
        }
        buffer = '';
      }
      for (const ch of text) {
        if (ch === '\uFF08') {
          flush();
          if (depth === 0) group = `p${++parenSeq}`;
          depth += 1;
          buffer += ch;
        } else if (ch === '\uFF09') {
          buffer += ch;
          flush();
          depth = Math.max(0, depth - 1);
          if (depth === 0) group = '';
        } else {
          buffer += ch;
        }
      }
      flush();
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  function toggleParenMode(mode) {
    document.body.dataset.parenMode = document.body.dataset.parenMode === mode ? '' : mode;
    if (!document.body.dataset.parenMode) document.body.removeAttribute('data-paren-mode');
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
    try {
      const data = await chrome.storage.local.get(['favorites']);
      return Array.isArray(data.favorites) ? data.favorites : [];
    } catch (_) {
      return [];
    }
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
    const idx = favorites.findIndex((fav) => fav.lawId === lawId);
    if (idx >= 0) {
      favorites.splice(idx, 1);
      showToast('お気に入りから削除しました');
    } else {
      favorites.unshift({ lawId, lawName: lawTitleText, lawNum: lawNumText, lawType: '', folderId: null });
      if (favorites.length > 50) favorites.length = 50;
      showToast('お気に入りに追加しました');
    }
    await chrome.storage.local.set({ favorites }).catch((error) => {
      console.warn('[e-Gov Enhancer] お気に入りの保存に失敗しました', error);
    });
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
    if (/^[0-9]$/.test(event.key)) { event.preventDefault(); showArticleDialog(event.key); return; }
    if (lower === 's') { event.preventDefault(); showSearchDialog(); return; }
    if (lower === 'h') { event.preventDefault(); navigateJumpHistory(-1); return; }
    if (lower === 'l') { event.preventDefault(); navigateJumpHistory(1); return; }
    if (lower === 'n') { event.preventDefault(); navigateArticle(1); return; }
    if (lower === 'p') { event.preventDefault(); navigateArticle(-1); return; }
    if (lower === 'd') { event.preventDefault(); scrollPage(0.8); return; }
    if (lower === 'u') { event.preventDefault(); scrollPage(-0.8); return; }
    if (lower === 'g' && event.shiftKey) { event.preventDefault(); toggleParenMode('nested'); return; }
    if (lower === 'g') { event.preventDefault(); toggleParenMode('flat'); return; }
    if (lower === 'e') { event.preventDefault(); toggleExternalReferenceLinks(); return; }
    if (lower === 'a') { event.preventDefault(); showArticleLinkDialog(); return; }
    if (lower === 't') { event.preventDefault(); showTocDialog(); }
  });

  setupExternalReferenceInteractions();
  loadLaw();
})();
