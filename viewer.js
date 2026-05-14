(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const lawId = params.get('lawId') || '';
  const revisionIdParam = params.get('revisionId') || '';
  const sourceUrl = params.get('sourceUrl') || (lawId ? `https://laws.e-gov.go.jp/law/${encodeURIComponent(lawId)}` : '');
  const fallbackLawName = params.get('lawName') || '法令ビューア';
  const embeddedMode = params.get('embedded') === '1';
  const API_V2_BASE = 'https://laws.e-gov.go.jp/api/2';
  const LITE_FONT_SIZE_KEY = 'liteFontSize';
  const LITE_CONTENT_WIDTH_KEY = 'liteContentWidth';
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
    chrome.storage.local.set({ [LITE_FONT_SIZE_KEY]: fontSizeSelect.value }).catch(() => {});
  });
  contentWidthSelect.addEventListener('change', () => {
    applyContentWidth(contentWidthSelect.value);
    chrome.storage.local.set({ [LITE_CONTENT_WIDTH_KEY]: contentWidthSelect.value }).catch(() => {});
  });
  normalModeButton.addEventListener('click', () => {
    location.href = sourceUrl || `https://laws.e-gov.go.jp/law/${encodeURIComponent(lawId)}`;
  });
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

  chrome.storage.local.get(['scrollBehavior', LITE_FONT_SIZE_KEY, LITE_CONTENT_WIDTH_KEY]).then((stored) => {
    applyFontSize(stored[LITE_FONT_SIZE_KEY]);
    applyContentWidth(stored[LITE_CONTENT_WIDTH_KEY]);
    if (stored.scrollBehavior === 'smooth') scrollBehavior = 'smooth';
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.scrollBehavior) {
      scrollBehavior = changes.scrollBehavior.newValue === 'smooth' ? 'smooth' : 'instant';
    }
    if (area === 'local' && changes[LITE_FONT_SIZE_KEY]) applyFontSize(changes[LITE_FONT_SIZE_KEY].newValue);
    if (area === 'local' && changes[LITE_CONTENT_WIDTH_KEY]) applyContentWidth(changes[LITE_CONTENT_WIDTH_KEY].newValue);
  });

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function extractLaws(data) {
    if (Array.isArray(data?.laws)) return data.laws;
    if (Array.isArray(data?.data?.laws)) return data.data.laws;
    if (Array.isArray(data?.result)) return data.result;
    if (Array.isArray(data)) return data;
    if (data?.law_lists) {
      const lawList = data.law_lists;
      if (Array.isArray(lawList.law)) return lawList.law;
      if (lawList.law) return [lawList.law];
    }
    return [];
  }

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

  function copyLine(value) {
    return normalizeCopyText(value);
  }

  function ownCopyText(el, excludedSelector = '') {
    if (!el) return '';
    const clone = el.cloneNode(true);
    if (excludedSelector) clone.querySelectorAll(excludedSelector).forEach((node) => node.remove());
    return copyLine(clone.textContent || '');
  }

  function buildItemCopyLines(el) {
    const lines = [];
    const num = copyLine(el.querySelector(':scope > .law-num')?.textContent || '');
    const body = el.children[1] || null;
    const text = ownCopyText(body, '.law-subitem');
    const line = copyLine([num, text].filter(Boolean).join(' '));
    if (line) lines.push(line);
    el.querySelectorAll(':scope > div:nth-child(2) > .law-subitem').forEach((subitem) => {
      lines.push(...buildItemCopyLines(subitem));
    });
    return lines;
  }

  function buildParagraphCopyLines(paragraph) {
    const lines = [];
    const num = copyLine(paragraph.querySelector(':scope > .law-num')?.textContent || '');
    const body = paragraph.children[1] || null;
    const text = ownCopyText(body, '.law-item,.law-subitem');
    const line = copyLine([num, text].filter(Boolean).join(' '));
    if (line) lines.push(line);
    paragraph.querySelectorAll(':scope > div:nth-child(2) > .law-item').forEach((item) => {
      lines.push(...buildItemCopyLines(item));
    });
    return lines;
  }

  function buildArticleCopyText(article) {
    return Array.from(article.querySelectorAll(':scope > .law-paragraph'))
      .flatMap((paragraph) => buildParagraphCopyLines(paragraph))
      .filter(Boolean)
      .join('\n');
  }

  function buildParagraphCopyText(paragraph) {
    return buildParagraphCopyLines(paragraph).filter(Boolean).join('\n');
  }

  function childElements(el, tagName = '') {
    return Array.from(el?.children || []).filter((child) => !tagName || child.tagName === tagName);
  }

  function firstChild(el, tagName) {
    return childElements(el, tagName)[0] || null;
  }

  function getNodeText(el) {
    return normalizeText(el?.textContent || '');
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
      const href = refHref || (refLawId ? `https://laws.e-gov.go.jp/law/${encodeURIComponent(refLawId)}` : '');
      return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${children}</a>` : children;
    }
    if (INLINE_ALLOWED.has(lowerTag)) {
      const children = renderInlineChildren(node);
      if (!children) return '';
      if (lowerTag === 'a') {
        const href = node.getAttribute('href') || node.getAttribute('xlink:href') || '#';
        const id = node.getAttribute('id') || node.getAttribute('name') || '';
        return `<a${id ? ` id="${escapeHtml(id)}"` : ''} href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${children}</a>`;
      }
      return `<${lowerTag}>${children}</${lowerTag}>`;
    }
    if (tag === 'ArithFormula') return `<strong>${escapeHtml(getNodeText(node))}</strong>`;
    if (tag === 'Ruby') return escapeHtml(getNodeText(node));
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
    const num = getNodeText(firstChild(paragraph, 'ParagraphNum')) || (rawNum && rawNum !== '1' ? rawNum : '');
    const normalizedNum = rawNum || (num ? num : '1');
    const sentence = firstChild(paragraph, 'ParagraphSentence') || paragraph;
    const id = getChildId('paragraph', articleNum, normalizedNum);
    const textHtml = renderTextBlock(sentence);
    const itemHtml = childElements(paragraph, 'Item').map((item) => renderItem(item, articleNum, normalizedNum)).join('');
    return `<div class="law-paragraph" id="${escapeHtml(id)}" data-article-num="${escapeHtml(articleNum)}" data-paragraph-num="${escapeHtml(normalizedNum)}">${num ? `<div class="law-num">${escapeHtml(num)}</div>` : '<div class="law-num" aria-hidden="true"></div>'}<div>${textHtml}${itemHtml}</div></div>`;
  }

  function renderItemLike(el, titleTag, sentenceTag, className, articleNum, paragraphNum, parentPath = '') {
    const title = getNodeText(firstChild(el, titleTag)) || el.getAttribute('Num') || '';
    const itemNum = el.getAttribute('Num') || title || parentPath;
    const id = getChildId('item', articleNum, paragraphNum, itemNum);
    const sentence = firstChild(el, sentenceTag) || el;
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
    const articleNum = article.getAttribute('Num') || getNodeText(firstChild(article, 'ArticleTitle')) || '';
    const title = firstChild(article, 'ArticleTitle');
    const caption = firstChild(article, 'ArticleCaption');
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
        const range = getNodeText(firstChild(child, 'ArticleRange'));
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

  function renderLaw(law, doc) {
    const body = law.querySelector('LawBody') || law;
    lawTitleText = getNodeText(firstChild(body, 'LawTitle')) || fallbackLawName;
    lawNumText = getNodeText(law.querySelector('LawNum')) || getNodeText(doc.querySelector('law_info > law_num')) || '';
    anchorCounts = new Map();
    buildTocItems(firstChild(body, 'TOC'));
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
  }

  async function loadRevisions() {
    if (!lawId) return;
    try {
      const url = `${API_V2_BASE}/law_revisions/${encodeURIComponent(lawId)}?response_format=json`;
      const response = await fetch(url);
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
    const revisionsPromise = loadRevisions();
    const target = currentRevisionId || lawId;
    try {
      const url = `${API_V2_BASE}/law_data/${encodeURIComponent(target)}?response_format=xml&law_full_text_format=xml&omit_amendment_suppl_provision=true`;
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const xmlText = await response.text();
      const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('XML parse error');
      const law = parseLawFromResponse(doc);
      if (!law) throw new Error('Law XML was not found');
      renderLaw(law, doc);
      await refreshFavoriteButton();
      revisionsPromise.catch(() => {});
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
    const params = new URLSearchParams();
    params.set('lawId', targetLawId);
    params.set('lawName', lawName || targetLawId);
    params.set('sourceUrl', `https://laws.e-gov.go.jp/law/${targetLawId}`);
    params.set('embedded', '1');
    return chrome.runtime.getURL(`viewer.html?${params.toString()}`);
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
      const response = await fetch(url);
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
    articleJumpHistory.splice(articleJumpCursor + 1, articleJumpHistory.length - articleJumpCursor - 1, key);
    articleJumpCursor = articleJumpHistory.length - 1;
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
    scrollToElement(target, 'start');
    setTimeout(() => flashJumpTarget(target), scrollBehavior === 'smooth' ? 220 : 0);
    if (record) pushJumpHistory(key);
    showJumpHistoryIndicator();
    return true;
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

  function getArticleAtViewport() {
    const articles = Array.from(contentEl.querySelectorAll('.law-article'));
    if (!articles.length) return null;
    const viewportTop = compareMode ? leftPaneEl.getBoundingClientRect().top : 0;
    const y = viewportTop + (compareMode ? leftPaneEl.clientHeight : window.innerHeight) * 0.25;
    let current = articles[0];
    for (const article of articles) {
      if (article.getBoundingClientRect().top <= y) current = article;
      else break;
    }
    return current;
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
    const parents = new Set();
    for (const mark of searchState.marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parents.add(parent);
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    }
    parents.forEach((parent) => parent.normalize());
    searchState = { marks: [], current: -1, query: '' };
  }

  function markCurrentSearch() {
    searchState.marks.forEach((mark) => mark.classList.remove('egov-lite-mark-current'));
    const current = searchState.marks[searchState.current];
    if (!current) return;
    current.classList.add('egov-lite-mark-current');
    scrollToElement(current, 'center');
  }

  function findInPage(query) {
    clearSearchMarks();
    const q = normalizeText(query);
    if (!q) return 0;
    const lowerQuery = q.toLowerCase();
    const pattern = new RegExp(escapeRegExp(q), 'gi');
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(lowerQuery)) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('mark, script, style')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const textNode of nodes) {
      const text = textNode.nodeValue || '';
      const frag = document.createDocumentFragment();
      let last = 0;
      text.replace(pattern, (hit, offset) => {
        frag.appendChild(document.createTextNode(text.slice(last, offset)));
        const mark = document.createElement('mark');
        mark.className = 'egov-lite-mark';
        mark.textContent = hit;
        frag.appendChild(mark);
        searchState.marks.push(mark);
        last = offset + hit.length;
        return hit;
      });
      frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    }
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
    Array.from(contentEl.querySelectorAll('.law-article')).forEach((article) => {
      const articleTitle = normalizeCopyText(article.querySelector('.article-title')?.textContent || article.dataset.articleNum || '');
      items.push({
        el: article,
        id: article.id,
        type: 'article',
        title: articleTitle,
        url: `${sourceUrl.split('#')[0]}#${encodeURIComponent(article.id)}`,
      });
      article.querySelectorAll('.law-paragraph[data-paragraph-num]').forEach((paragraph) => {
        const paragraphNum = paragraph.dataset.paragraphNum || '';
        const visibleNum = normalizeCopyText(paragraph.querySelector(':scope > .law-num')?.textContent || '');
        const label = paragraphNum === '1' && !visibleNum
          ? articleTitle
          : `${articleTitle}第${visibleNum || paragraphNum}項`;
        items.push({
          el: paragraph,
          id: paragraph.id,
          type: 'paragraph',
          title: label,
          url: `${sourceUrl.split('#')[0]}#${encodeURIComponent(paragraph.id)}`,
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
    return item.type === 'paragraph' ? buildParagraphCopyText(item.el) : buildArticleCopyText(item.el);
  }

  function buildProvisionCopyPayload(item, mode) {
    if (mode === 'url') return item.url;
    if (mode === 'law-number-url') return `${lawTitleText} ${item.title}\n${item.url}`;
    return `${lawTitleText} ${item.title}\n${getProvisionCopyText(item)}\n${item.url}`;
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
        <p class="lite-hint">↑/↓ または u/p/n/d: コピー対象移動（条・項）</p>
        <p class="lite-hint"><kbd>Enter</kbd>: URL / <kbd>Shift+Enter</kbd>: 法令名+条項+URL / <kbd>Ctrl+Enter</kbd>: 本文付き</p>
        <div class="lite-link-preview" id="lite-link-preview-url"></div>
        <div class="lite-link-preview" id="lite-link-preview-meta"></div>
        <div class="lite-link-preview" id="lite-link-preview-text"></div>
      </div>
    `;
    const panel = body.querySelector('#lite-link-panel');
    const urlEl = body.querySelector('#lite-link-preview-url');
    const metaEl = body.querySelector('#lite-link-preview-meta');
    const textEl = body.querySelector('#lite-link-preview-text');
    let selected = currentArticleIndex(items);
    function update(scroll = false) {
      const item = items[selected];
      urlEl.textContent = buildProvisionCopyPayload(item, 'url');
      metaEl.textContent = buildProvisionCopyPayload(item, 'law-number-url');
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

  leftPaneEl.addEventListener('focusin', () => {
    if (compareMode) setFocusedPane('left');
  });
  rightPaneEl.addEventListener('focusin', () => {
    if (compareMode) setFocusedPane('right');
  });
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.data?.type !== 'egov-lite-focus-left') return;
    if (compareMode) setFocusedPane('left');
  });
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.data?.type !== 'egov-lite-toggle-compare') return;
    if (compareMode) toggleCompareMode(false);
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
    await chrome.storage.local.set({ favorites }).catch(() => {});
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
    if (lower === 'a') { event.preventDefault(); showArticleLinkDialog(); return; }
    if (lower === 't') { event.preventDefault(); showTocDialog(); }
  });

  loadLaw();
})();
