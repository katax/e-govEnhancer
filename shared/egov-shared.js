(function (global) {
  'use strict';

  const LAW_BASE_URL = 'https://laws.e-gov.go.jp';
  const REFERENCES_DB_NAME = 'egov-extension-references';
  const REFERENCES_DB_VERSION = 2;
  const REFERENCES_LAWS_STORE = 'laws';
  const REFERENCES_META_STORE = 'meta';
  const REFERENCES_BUNDLED_CACHE_STORE = 'bundled_cache';
  const REFERENCES_CURRENT_META_KEY = 'current';
  const REVERSE_REFERENCE_SCOPE_KEY = 'reverseReferenceScope';
  const REVERSE_REFERENCE_SCOPES = new Set(['internal', 'external', 'both']);
  const LITE_LAW_LEGACY_CACHE_NAMES = ['egov-lite-law-xml-v1', 'egov-lite-law-xml-v2'];
  // 旧キャッシュには法令IDの取得結果が現行改正IDとして保存されている可能性があるため、再利用しない。
  const LITE_LAW_CACHE_NAME = 'egov-lite-law-xml-v3';
  const LITE_LAW_CACHE_MAX_ENTRIES = 100;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeReverseReferenceScope(value) {
    return REVERSE_REFERENCE_SCOPES.has(value) ? value : 'both';
  }

  function getReverseReferenceScopeFlags(value) {
    const scope = normalizeReverseReferenceScope(value);
    return {
      includeInternal: scope !== 'external',
      includeExternal: scope !== 'internal',
    };
  }

  function formatLawNameHtml(name, mutedClassName = 'law-name-muted') {
    return escapeHtml(String(name || '')).replace(
      /\uFF08[^\uFF09]*\uFF09/g,
      (match) => `<span class="${mutedClassName}">${match}</span>`
    );
  }

  function buildLawUrl(lawId) {
    return `${LAW_BASE_URL}/law/${encodeURIComponent(lawId)}`;
  }

  function formatArticleNumber(article) {
    const [base, ...suffixes] = String(article || '').split('_').filter(Boolean);
    if (!base) return '';
    return `第${base}条${suffixes.map((suffix) => `の${suffix}`).join('')}`;
  }

  function formatProvisionBranch(value, unit) {
    const [base, ...suffixes] = String(value || '').split(/[-_]/).filter(Boolean);
    if (!base) return '';
    return `第${base}${unit}${suffixes.map((suffix) => `の${suffix}`).join('')}`;
  }

  function parseProvisionHash(hash) {
    const rawHash = decodeURIComponent(String(hash || '')).replace(/^#/, '');
    const articleMatch = rawHash.match(/(?:^|-)At_([0-9_]+)/);
    const article = articleMatch?.[1] || '';
    if (!article) return null;

    const prefix = rawHash.slice(0, articleMatch.index ?? 0);
    const scope = prefix.match(/(?:^|-)(Sp(?:_[0-9]+)?)(?:-|$)/)?.[1] || '';
    const suffix = rawHash.slice((articleMatch.index ?? 0) + articleMatch[0].length);
    const paragraph = suffix.match(/(?:^|-)(?:Co|Pa|Pr)_([0-9_]+)/)?.[1] || '';
    const item = suffix.match(/(?:^|-)(?:It|Sg)_([0-9_]+)/)?.[1] || '';
    return { scope, article, paragraph, item };
  }

  function splitReferenceTargetKey(key) {
    const raw = String(key || '');
    const scopeSeparator = raw.indexOf('::');
    const scope = scopeSeparator >= 0 ? raw.slice(0, scopeSeparator) : '';
    const provision = scopeSeparator >= 0 ? raw.slice(scopeSeparator + 2) : raw;
    const [article = '', paragraph = '', item = ''] = provision.split('.');
    return { scope, article, paragraph, item };
  }

  function getReferenceDomParts(parts) {
    if (parts?.article && parts.paragraph === '1' && !parts.item) {
      return { ...parts, paragraph: '', item: '' };
    }
    return parts;
  }

  function formatScopedReferenceTargetKey(scope, key) {
    const normalizedScope = String(scope || '').trim();
    return normalizedScope ? `${normalizedScope}::${key}` : key;
  }

  function cleanLawNameForSearch(name) {
    return String(name || '')
      .replace(/（[^）]*）/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/(?:施行規則|施行令)$/, '')
      .trim();
  }

  function parseProvisionPathFromEgovUrl(url, base = LAW_BASE_URL) {
    try {
      const parsed = new URL(String(url || ''), base);
      return parseProvisionHash(parsed.hash);
    } catch (_) {
      return null;
    }
  }

  function formatProvisionSourcePath(parts) {
    if (!parts?.article) return '';
    let text = parts.scope ? '附則' : '';
    text += formatProvisionBranch(parts.article, '条');
    if (parts.paragraph) text += formatProvisionBranch(parts.paragraph, '項');
    if (parts.item) text += formatProvisionBranch(parts.item, '号');
    return text;
  }

  function formatProvisionSourcePathFromEgovUrl(url, base = LAW_BASE_URL) {
    return formatProvisionSourcePath(parseProvisionPathFromEgovUrl(url, base));
  }

  function sortReferenceSources(sources, currentLawTitle, targetKey = '', normalize = normalizeLawNameForCopy) {
    const currentTitle = normalize(currentLawTitle || '');
    const currentPrefix = currentTitle.slice(0, 5);
    const targetParts = splitReferenceTargetKey(canonicalizeReferenceTargetKey(targetKey));
    const targetArticle = normalizeReferenceKeyPart(targetParts.article);
    return (Array.isArray(sources) ? sources : [])
      .map((source, index) => {
        const sourceTitle = normalize(source?.sourceLawTitle || '');
        const sourcePrefix = sourceTitle.slice(0, 5);
        const isInternal = source?.isInternalLawSource === true;
        const sourceParts = parseProvisionPathFromEgovUrl(source?.sourceUrl || '') || {};
        const sourceArticle = normalizeReferenceKeyPart(sourceParts.article);
        const sourceScope = String(source?.sourceProvisionScope || sourceParts.scope || '');
        return {
          source,
          index,
          isInternal,
          isSameArticle: !!(
            isInternal &&
            targetArticle &&
            sourceArticle === targetArticle &&
            sourceScope === String(targetParts.scope || '')
          ),
          isRelated: !!(!isInternal && (
            (currentPrefix && sourceTitle.includes(currentPrefix)) ||
            (sourcePrefix && currentTitle.includes(sourcePrefix))
          )),
        };
      })
      .sort((a, b) => {
        const getPriority = (row) => {
          if (row.isRelated) return 0;
          if (row.isInternal && !row.isSameArticle) return 1;
          if (row.isInternal && row.isSameArticle) return 2;
          return 3;
        };
        const priority = getPriority(a) - getPriority(b);
        if (priority) return priority;
        return a.index - b.index;
      });
  }

  function normalizeReferenceKeyPart(value) {
    return String(value || '').trim().replace(/_/g, '-');
  }

  function canonicalizeReferenceTargetKey(key) {
    const parts = splitReferenceTargetKey(key);
    const article = normalizeReferenceKeyPart(parts.article);
    const paragraph = normalizeReferenceKeyPart(parts.paragraph);
    const item = normalizeReferenceKeyPart(parts.item);
    if (!article) return '';
    if (paragraph === '1' && !item) return formatScopedReferenceTargetKey(parts.scope, article);
    return formatScopedReferenceTargetKey(
      parts.scope,
      [article, paragraph, item].filter(Boolean).join('.')
    );
  }

  function getReferenceTargetKeyFromEgovUrl(url, base = LAW_BASE_URL) {
    const parts = parseProvisionPathFromEgovUrl(url, base);
    if (!parts?.article) return '';
    return canonicalizeReferenceTargetKey(formatScopedReferenceTargetKey(parts.scope, [
      parts.article,
      parts.paragraph,
      parts.item,
    ].filter(Boolean).join('.')));
  }

  function getInternalReferenceSourceParts(anchor, root) {
    let current = anchor instanceof Element ? anchor : null;
    while (current && current !== root) {
      const article = normalizeReferenceKeyPart(current.dataset?.articleNum);
      const paragraph = normalizeReferenceKeyPart(current.dataset?.paragraphNum);
      const item = normalizeReferenceKeyPart(current.dataset?.itemNum);
      const scope = String(current.dataset?.referenceScope || parseProvisionHash(`#${current.id || ''}`)?.scope || '');
      if (article) return { scope, article, paragraph, item, id: current.id || '', element: current };

      const parsed = current.id ? parseProvisionHash(`#${current.id}`) : null;
      if (parsed?.article) {
        return {
          scope: String(parsed.scope || ''),
          article: normalizeReferenceKeyPart(parsed.article),
          paragraph: normalizeReferenceKeyPart(parsed.paragraph),
          item: normalizeReferenceKeyPart(parsed.item),
          id: current.id,
          element: current,
        };
      }
      current = current.parentElement;
    }
    return null;
  }

  function getInternalReferenceSourceDetails(anchor, root, sourceParts) {
    const article = sourceParts?.article || '';
    const scope = String(sourceParts?.scope || '');
    let current = anchor instanceof Element ? anchor : null;
    let articleElement = null;
    while (current && current !== root) {
      const currentArticle = normalizeReferenceKeyPart(current.dataset?.articleNum);
      const parsed = current.id ? parseProvisionHash(`#${current.id}`) : null;
      const parsedArticle = normalizeReferenceKeyPart(parsed?.article);
      const currentScope = String(current.dataset?.referenceScope || parsed?.scope || '');
      if ((currentArticle === article || parsedArticle === article) && currentScope === scope) {
        articleElement = current;
        const articleHeading = current.querySelector([
          ':scope > .article-caption',
          ':scope > .article-title',
          ':scope > .articlecaption',
          ':scope > .articletitle',
          ':scope > ._div_ArticleCaption',
          ':scope > ._div_ArticleTitle',
          ':scope > [class*="ArticleCaption"]',
          ':scope > [class*="ArticleTitle"]',
        ].join(', '));
        if (articleHeading) break;
      }
      current = current.parentElement;
    }
    if (!articleElement) return { text: '', paragraphCount: 0 };

    const paragraphNumbers = new Set();
    articleElement.querySelectorAll('[data-paragraph-num], [id]').forEach((element) => {
      const elementArticle = normalizeReferenceKeyPart(element.dataset?.articleNum);
      const elementParagraph = normalizeReferenceKeyPart(element.dataset?.paragraphNum);
      const parsed = element.id ? parseProvisionHash(`#${element.id}`) : null;
      const elementScope = String(element.dataset?.referenceScope || parsed?.scope || '');
      if (elementScope !== scope) return;
      if (elementArticle === article && elementParagraph) {
        paragraphNumbers.add(elementParagraph);
        return;
      }
      if (normalizeReferenceKeyPart(parsed?.article) === article && parsed?.paragraph) {
        paragraphNumbers.add(normalizeReferenceKeyPart(parsed.paragraph));
      }
    });

    const sourceElement = sourceParts?.element instanceof Element ? sourceParts.element : articleElement;
    const clone = sourceElement.cloneNode(true);
    const directNumberSelectors = sourceParts?.item
      ? [
          ':scope > .law-num',
          ':scope > .itemtitle',
          ':scope > .itemnum',
          ':scope > ._div_ItemTitle',
          ':scope > [class*="ItemTitle"]',
          ':scope > [class*="ItemNum"]',
        ]
      : sourceParts?.paragraph
        ? [
            ':scope > .law-num',
            ':scope > .paragraphtitle',
            ':scope > .paragraphnum',
            ':scope > ._div_ParagraphTitle',
            ':scope > [class*="ParagraphTitle"]',
            ':scope > [class*="ParagraphNum"]',
          ]
        : [
            ':scope > .article-caption',
            ':scope > .article-title',
            ':scope > .articlecaption',
            ':scope > .articletitle',
            ':scope > ._div_ArticleCaption',
            ':scope > [class*="ArticleCaption"]',
          ];
    clone.querySelectorAll(directNumberSelectors.join(', ')).forEach((node) => node.remove());
    const numberPattern = '[0-9０-９〇零一二三四五六七八九十百千万]+';
    const leadingHeadingPattern = new RegExp(`^(?:（[^）]*）|\\([^)]*\\))\\s*第${numberPattern}条(?:の${numberPattern})?\\s*`);
    let text = String(clone.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const hadEmbeddedHeading = leadingHeadingPattern.test(text);
    if (hadEmbeddedHeading) text = text.replace(leadingHeadingPattern, '').trim();
    const leadingArticleNumberPattern = new RegExp(`^第(${numberPattern})条(?:の(${numberPattern}))?\\s*`);
    const leadingArticleNumber = text.match(leadingArticleNumberPattern);
    const expectedArticleParts = String(article || '').split('-').map(Number);
    const sourceClassName = typeof sourceElement.className === 'string' ? sourceElement.className : '';
    const hasCombinedArticleSentence = /(?:^|\s)_div_ArticleTitle(?:\s|$)/.test(sourceClassName);
    if (
      !hadEmbeddedHeading &&
      ((!sourceParts?.paragraph && !sourceParts?.item) || hasCombinedArticleSentence) &&
      leadingArticleNumber &&
      parseJapaneseReferenceNumber(leadingArticleNumber[1]) === expectedArticleParts[0] &&
      (leadingArticleNumber[2] ? parseJapaneseReferenceNumber(leadingArticleNumber[2]) : 0) === (expectedArticleParts[1] || 0)
    ) {
      text = text.slice(leadingArticleNumber[0].length).trim();
    }

    const sourceUnit = sourceParts?.item ? '号' : sourceParts?.paragraph ? '項' : '';
    const sourceUnitValue = sourceParts?.item || sourceParts?.paragraph || '';
    if (sourceUnit && sourceUnitValue) {
      const leadingUnitPattern = new RegExp(`^(?:第(${numberPattern})${sourceUnit}|(${numberPattern})\\s+)`);
      const leadingUnit = text.match(leadingUnitPattern);
      const expectedUnitNumber = Number(String(sourceUnitValue).split('-')[0]);
      const actualUnitNumber = parseJapaneseReferenceNumber(leadingUnit?.[1] || leadingUnit?.[2]);
      if (Number.isInteger(expectedUnitNumber) && actualUnitNumber === expectedUnitNumber) {
        text = text.slice(leadingUnit[0].length).trim();
      }
    }
    return { text, paragraphCount: paragraphNumbers.size };
  }

  function buildInternalReferenceSourceUrl(lawId, parts) {
    if (!lawId || !parts?.article) return '';
    if (parts.id && /(?:^|-)At_[0-9_]+/.test(parts.id)) {
      return `${buildLawUrl(lawId)}#${encodeURIComponent(parts.id)}`;
    }
    const article = parts.article.replace(/-/g, '_');
    const paragraph = parts.paragraph ? `-Pr_${parts.paragraph.replace(/-/g, '_')}` : '';
    const item = parts.item ? `-It_${parts.item.replace(/-/g, '_')}` : '';
    const scope = parts.scope ? `${lawId}-${parts.scope}` : 'Mp';
    return `${buildLawUrl(lawId)}#${scope}-At_${article}${paragraph}${item}`;
  }

  function parseJapaneseReferenceNumber(value) {
    const normalized = String(value || '')
      .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
      .replace(/[〇零]/g, '0');
    if (!normalized) return NaN;
    if (/^\d+$/.test(normalized)) return Number(normalized);
    const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const units = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
    let total = 0;
    let section = 0;
    let digit = 0;
    for (const char of normalized) {
      if (digits[char]) {
        digit = digits[char];
        continue;
      }
      const unit = units[char];
      if (!unit) return NaN;
      if (unit === 10000) {
        total += (section + digit || 1) * unit;
        section = 0;
        digit = 0;
      } else {
        section += (digit || 1) * unit;
        digit = 0;
      }
    }
    return total + section + digit;
  }

  function buildSequentialReferenceKeys(start, end, buildKey, maxEntries = 500) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return [];
    if (end - start + 1 > maxEntries) return [];
    return Array.from({ length: end - start + 1 }, (_, index) => buildKey(start + index));
  }

  function buildInternalProvisionOrder(root) {
    const articlesByScope = new Map();
    const paragraphs = new Map();
    const items = new Map();
    const seenArticles = new Set();
    const seenParagraphs = new Map();
    const seenItems = new Map();
    root.querySelectorAll('[data-article-num], [id*="At_"]').forEach((element) => {
      const parsed = element.id ? parseProvisionHash(`#${element.id}`) : null;
      const article = normalizeReferenceKeyPart(element.dataset?.articleNum || parsed?.article);
      const paragraph = normalizeReferenceKeyPart(element.dataset?.paragraphNum || parsed?.paragraph);
      const item = normalizeReferenceKeyPart(element.dataset?.itemNum || parsed?.item);
      const scope = String(element.dataset?.referenceScope || parsed?.scope || '');
      if (!article) return;
      const articleKey = formatScopedReferenceTargetKey(scope, article);
      if (!articlesByScope.has(scope)) articlesByScope.set(scope, []);
      if (!seenArticles.has(articleKey)) {
        seenArticles.add(articleKey);
        articlesByScope.get(scope).push(article);
      }
      if (!paragraph) return;
      if (!paragraphs.has(articleKey)) paragraphs.set(articleKey, []);
      if (!seenParagraphs.has(articleKey)) seenParagraphs.set(articleKey, new Set());
      if (!seenParagraphs.get(articleKey).has(paragraph)) {
        seenParagraphs.get(articleKey).add(paragraph);
        paragraphs.get(articleKey).push(paragraph);
      }
      if (!item) return;
      const paragraphKey = formatScopedReferenceTargetKey(scope, `${article}.${paragraph}`);
      if (!items.has(paragraphKey)) items.set(paragraphKey, []);
      if (!seenItems.has(paragraphKey)) seenItems.set(paragraphKey, new Set());
      if (!seenItems.get(paragraphKey).has(item)) {
        seenItems.get(paragraphKey).add(item);
        items.get(paragraphKey).push(item);
      }
    });
    return { articlesByScope, paragraphs, items };
  }

  function getPriorReferenceKeys(parts, unit, count, provisionOrder) {
    if (!Number.isInteger(count) || count < 2 || count > 500) return [];
    let values = [];
    let startValue = '';
    let buildKey;
    const scope = String(parts.scope || '');
    const articleKey = formatScopedReferenceTargetKey(scope, parts.article);
    if (unit === '条') {
      values = provisionOrder?.articlesByScope?.get(scope) || [];
      startValue = parts.article;
      buildKey = (article) => formatScopedReferenceTargetKey(scope, article);
    } else if (unit === '項') {
      values = provisionOrder?.paragraphs?.get(articleKey) || [];
      startValue = parts.paragraph || '1';
      buildKey = (paragraph) => canonicalizeReferenceTargetKey(
        formatScopedReferenceTargetKey(scope, `${parts.article}.${paragraph}`)
      );
    } else if (unit === '号') {
      const paragraph = parts.paragraph || '1';
      values = provisionOrder?.items?.get(
        formatScopedReferenceTargetKey(scope, `${parts.article}.${paragraph}`)
      ) || [];
      startValue = parts.item || '1';
      buildKey = (item) => canonicalizeReferenceTargetKey(
        formatScopedReferenceTargetKey(scope, `${parts.article}.${paragraph}.${item}`)
      );
    }
    const startIndex = values.indexOf(startValue);
    if (startIndex >= 0) {
      const keys = values.slice(startIndex, startIndex + count).map(buildKey).filter(Boolean);
      if (keys.length === count) return keys;
    }

    const start = Number(String(startValue).split('-')[0]);
    return buildSequentialReferenceKeys(start, start + count - 1, (number) => {
      if (unit === '条') return formatScopedReferenceTargetKey(scope, String(number));
      if (unit === '項') {
        return canonicalizeReferenceTargetKey(
          formatScopedReferenceTargetKey(scope, `${parts.article}.${number}`)
        );
      }
      return canonicalizeReferenceTargetKey(
        formatScopedReferenceTargetKey(scope, `${parts.article}.${parts.paragraph || '1'}.${number}`)
      );
    });
  }

  function getAllParagraphReferenceKeys(parts, provisionOrder) {
    const scope = String(parts.scope || '');
    const articleKey = formatScopedReferenceTargetKey(scope, parts.article);
    return (provisionOrder?.paragraphs?.get(articleKey) || [])
      .map((paragraph) => canonicalizeReferenceTargetKey(
        formatScopedReferenceTargetKey(scope, `${parts.article}.${paragraph}`)
      ))
      .filter(Boolean);
  }

  function getAllItemReferenceKeys(parts, provisionOrder, includeAllParagraphs = false) {
    const scope = String(parts.scope || '');
    const paragraphs = includeAllParagraphs
      ? getAllParagraphReferenceKeys(parts, provisionOrder)
        .map((key) => splitReferenceTargetKey(key).paragraph || '1')
      : [parts.paragraph || '1'];
    return paragraphs.flatMap((paragraph) => {
      const paragraphKey = formatScopedReferenceTargetKey(scope, `${parts.article}.${paragraph}`);
      return (provisionOrder?.items?.get(paragraphKey) || [])
        .map((item) => canonicalizeReferenceTargetKey(
          formatScopedReferenceTargetKey(scope, `${parts.article}.${paragraph}.${item}`)
        ))
        .filter(Boolean);
    });
  }

  function getInternalReferenceTargetKeys(anchor, initialTargetKey, sourceParts, provisionOrder) {
    const targetKey = canonicalizeReferenceTargetKey(initialTargetKey);
    const parts = splitReferenceTargetKey(targetKey);
    if (!parts.article) return [];
    const text = String(anchor?.textContent || '').replace(/\s+/g, '');
    const numberPattern = '[0-9０-９〇零一二三四五六七八九十百千万]+';
    const priorMatch = text.match(new RegExp(`前(${numberPattern})(条|項|号)`));
    if (priorMatch) {
      const count = parseJapaneseReferenceNumber(priorMatch[1]);
      const keys = getPriorReferenceKeys(parts, priorMatch[2], count, provisionOrder);
      if (keys.length) return keys;
    }
    if (text.includes('各号')) {
      const keys = getAllItemReferenceKeys(parts, provisionOrder, text.includes('各項'));
      if (keys.length) return keys;
    }
    if (text.includes('各項')) {
      const keys = getAllParagraphReferenceKeys(parts, provisionOrder);
      if (keys.length) return keys;
    }
    if (!text.includes('から') || !text.includes('まで')) return [targetKey];

    const articleSegments = parts.article.split('-').map(Number);
    const startArticle = articleSegments[0];
    const startArticleBranch = articleSegments[1] || 0;

    if (parts.item) {
      const match = text.match(new RegExp(`から第?(${numberPattern})号まで`));
      const start = Number(parts.item.split('-')[0]);
      const end = parseJapaneseReferenceNumber(match?.[1]);
      const keys = buildSequentialReferenceKeys(start, end, (number) => (
        formatScopedReferenceTargetKey(
          parts.scope,
          `${parts.article}.${parts.paragraph || '1'}.${number}`
        )
      ));
      return keys.length ? keys : [targetKey];
    }

    if (parts.paragraph) {
      const match = text.match(new RegExp(`から第?(${numberPattern})項まで`));
      const start = Number(parts.paragraph.split('-')[0]);
      const end = parseJapaneseReferenceNumber(match?.[1]);
      const keys = buildSequentialReferenceKeys(start, end, (number) => (
        formatScopedReferenceTargetKey(parts.scope, `${parts.article}.${number}`)
      ));
      return keys.length ? keys : [targetKey];
    }

    const branchedEnd = text.match(new RegExp(`から第?(${numberPattern})条の(${numberPattern})まで`));
    if (branchedEnd) {
      const endArticle = parseJapaneseReferenceNumber(branchedEnd[1]);
      const endBranch = parseJapaneseReferenceNumber(branchedEnd[2]);
      if (endArticle === startArticle && Number.isInteger(endBranch)) {
        const firstBranch = startArticleBranch || 1;
        const keys = buildSequentialReferenceKeys(firstBranch, endBranch, (branch) => (
          formatScopedReferenceTargetKey(
            parts.scope,
            branch === 1 && !startArticleBranch ? String(startArticle) : `${startArticle}-${branch}`
          )
        ));
        return keys.length ? keys : [targetKey];
      }
    }

    const explicitEnd = text.match(new RegExp(`から第?(${numberPattern})条まで`));
    let endArticle = parseJapaneseReferenceNumber(explicitEnd?.[1]);
    if (!Number.isInteger(endArticle) && /から前条まで/.test(text)) {
      endArticle = Number(String(sourceParts?.article || '').split('-')[0]) - 1;
    }
    if (!startArticleBranch) {
      const keys = buildSequentialReferenceKeys(startArticle, endArticle, (number) => (
        formatScopedReferenceTargetKey(parts.scope, String(number))
      ));
      if (keys.length) return keys;
    }
    return [targetKey];
  }

  function collectInternalLawReferences(root, {
    lawId,
    lawTitle = '',
    baseUrl = global.location?.href || LAW_BASE_URL,
  } = {}) {
    if (!(root instanceof Element) || !lawId) return {};
    const result = {};
    const seenByTarget = new Map();
    const provisionOrder = buildInternalProvisionOrder(root);

    root.querySelectorAll('a[href]').forEach((anchor) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(anchor.getAttribute('href') || '', baseUrl);
      } catch (_) {
        return;
      }
      let baseOrigin = '';
      try {
        baseOrigin = new URL(baseUrl, LAW_BASE_URL).origin;
      } catch (_) {}
      if (baseOrigin && parsedUrl.origin !== baseOrigin) return;
      const targetLawId = parsedUrl.pathname.match(/\/law\/([^/?#]+)/)?.[1] || '';
      if (targetLawId !== lawId) return;

      const targetKey = getReferenceTargetKeyFromEgovUrl(parsedUrl.href, baseUrl);
      if (!targetKey) return;
      const sourceParts = getInternalReferenceSourceParts(anchor, root);
      if (!sourceParts?.article) return;
      const sourceUrl = buildInternalReferenceSourceUrl(lawId, sourceParts);
      if (!sourceUrl) return;
      const sourceDetails = getInternalReferenceSourceDetails(anchor, root, sourceParts);
      const sourceProvisionLabel = formatProvisionSourcePath({
        scope: sourceParts.scope,
        article: sourceParts.article,
        paragraph: sourceDetails.paragraphCount > 1 ? sourceParts.paragraph : '',
        item: sourceParts.item,
      });

      getInternalReferenceTargetKeys(anchor, targetKey, sourceParts, provisionOrder).forEach((resolvedTargetKey) => {
        let seen = seenByTarget.get(resolvedTargetKey);
        if (!seen) {
          seen = new Set();
          seenByTarget.set(resolvedTargetKey, seen);
        }
        if (seen.has(sourceUrl)) return;
        seen.add(sourceUrl);

        if (!result[resolvedTargetKey]) result[resolvedTargetKey] = { externalLawSources: [] };
        result[resolvedTargetKey].externalLawSources.push({
          sourceLawId: lawId,
          sourceLawTitle: lawTitle || lawId,
          sourceUrl,
          sourceProvisionLabel,
          sourceProvisionText: sourceDetails.text,
          sourceProvisionScope: sourceParts.scope || '',
          isInternalLawSource: true,
        });
      });
    });
    return result;
  }

  function mergeLawReferences(...referenceSets) {
    const merged = {};
    const seenByTarget = new Map();
    referenceSets.forEach((referenceSet) => {
      Object.entries(referenceSet || {}).forEach(([rawTargetKey, value]) => {
        const targetKey = canonicalizeReferenceTargetKey(rawTargetKey);
        if (!targetKey) return;
        if (!merged[targetKey]) merged[targetKey] = { externalLawSources: [] };
        let seen = seenByTarget.get(targetKey);
        if (!seen) {
          seen = new Set();
          seenByTarget.set(targetKey, seen);
        }
        const sources = Array.isArray(value?.externalLawSources) ? value.externalLawSources : [];
        sources.forEach((source) => {
          const identity = `${source?.sourceLawId || ''}\n${source?.sourceUrl || ''}`;
          if (seen.has(identity)) return;
          seen.add(identity);
          merged[targetKey].externalLawSources.push(source);
        });
      });
    });
    return merged;
  }

  function configureReferenceClickable({
    clickable,
    className,
    targetKey,
    sources,
    sourceMap,
    isEnabled,
    showPopup,
  }) {
    if (!clickable || !sources?.length) return;
    clickable.classList.add(className);
    clickable.tabIndex = clickable.tabIndex >= 0 ? clickable.tabIndex : 0;
    clickable.title = `参照元 ${sources.length}件`;
    clickable.dataset.egovReferenceTargetKey = targetKey;
    const targetParts = splitReferenceTargetKey(targetKey);
    if (targetParts.scope && !targetParts.paragraph && !targetParts.item) {
      clickable.dataset.egovReferenceSupplementArticle = 'true';
    } else {
      delete clickable.dataset.egovReferenceSupplementArticle;
    }
    sourceMap.set(clickable, sources);
    if (clickable.dataset.egovReferenceBound === 'true') return;
    clickable.dataset.egovReferenceBound = 'true';

    const open = (point, ctrlKey = false) => showPopup({
      targetKey: clickable.dataset.egovReferenceTargetKey,
      sources: sourceMap.get(clickable),
      point,
      ctrlKey,
    });
    clickable.addEventListener('click', (event) => {
      if (!isEnabled()) return;
      event.preventDefault();
      event.stopPropagation();
      open({ x: event.clientX, y: event.clientY }, event.ctrlKey);
    });
    clickable.addEventListener('keydown', (event) => {
      if (!isEnabled() || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      const rect = clickable.getBoundingClientRect();
      open({ x: rect.left, y: rect.bottom }, event.ctrlKey);
    });
  }

  function applyReferenceLinksInBatches(lawReferences, {
    isEnabled,
    findTarget,
    makeClickable,
    schedule,
    batchSize = 120,
  }) {
    const entries = Object.entries(lawReferences || {});
    let index = 0;
    return new Promise((resolve) => {
      const step = () => {
        if (!isEnabled()) {
          resolve(false);
          return;
        }
        const end = Math.min(entries.length, index + batchSize);
        for (; index < end; index += 1) {
          if (!isEnabled()) {
            resolve(false);
            return;
          }
          const [targetKey, value] = entries[index];
          const sources = Array.isArray(value?.externalLawSources) ? value.externalLawSources : [];
          if (!sources.length) continue;
          const target = findTarget(targetKey);
          if (target) makeClickable(target, targetKey, sources);
        }
        if (index < entries.length) {
          schedule(step);
          return;
        }
        resolve(true);
      };
      step();
    });
  }

  function formatProvisionNumber(parts, {
    isArticleLevel = false,
    omitSingleParagraphFirst = false,
  } = {}) {
    if (!parts?.article) return '';
    let text = formatArticleNumber(parts.article);
    if (
      parts.paragraph &&
      !isArticleLevel &&
      !(omitSingleParagraphFirst && parts.paragraph === '1' && !parts.item)
    ) {
      text += formatProvisionBranch(parts.paragraph, '項');
    }
    if (parts.item) text += formatProvisionBranch(parts.item, '号');
    return text;
  }

  function normalizeLawNameForCopy(name) {
    return String(name || '')
      .replace(/\s*（[^）]*第[^）]*号）\s*$/, '')
      .trim();
  }

  function buildProvisionCopyPayload({ lawName, numberLabel, bodyText = '', url = '' } = {}, mode = 'url') {
    if (mode === 'url') return url;
    const titleLine = `${normalizeLawNameForCopy(lawName)} ${numberLabel || ''}`.trim();
    if (mode === 'law-number-url') return `${titleLine}\n${url}`;
    if (mode === 'text-url') return `${titleLine}\n---\n${bodyText || ''}\n${url}`;
    return url;
  }

  const DEFINITION_PATTERNS = Object.freeze({
    patternA: /この(法律|政令|省令|規則|章|節|条)(?:[^に]{0,20})?において、?「([^」]+)」とは、([\s\S]+?)をいう/g,
    patternC: /（以下(?:この(?:条|章|節|款)において)?(?:単に)?「([^」]+)」という。）/g,
    patternD: /（([^（）]{2,260}?をいう。以下同じ。)）/g,
  });

  function cloneDefinitionPatterns() {
    return {
      patternA: new RegExp(DEFINITION_PATTERNS.patternA.source, 'g'),
      patternC: new RegExp(DEFINITION_PATTERNS.patternC.source, 'g'),
      patternD: new RegExp(DEFINITION_PATTERNS.patternD.source, 'g'),
    };
  }

  function stripPriorDefinitionParentheses(text, patterns) {
    return patterns.reduce((current, pattern) => current.replace(new RegExp(pattern.source, 'g'), ''), String(text || ''));
  }

  function extractTermBeforeParentheticalDefinition(text, matchIndex, cleanupPatterns = [], normalize = (value) => String(value || '')) {
    const before = stripPriorDefinitionParentheses(String(text || '').slice(0, matchIndex), cleanupPatterns);
    const sentenceTail = before.split(/[。；;]/).pop() || before;
    const clauseTail = sentenceTail.split(/[、，]/).pop() || sentenceTail;
    const match = normalize(clauseTail).match(/([^ 　、。，．；;（）()「」『』]{2,40})$/);
    const term = match?.[1] || '';
    // 「株式会社がその発行済株式（…をいう。以下同じ。）」のような文では、
    // 括弧直前の主語句ではなく、指示語に続く語だけを定義用語として扱う。
    const scopedTerm = term.match(/^.+?[はがも](?:その|当該)(.{2,40})$/);
    return scopedTerm?.[1] || term;
  }

  function extractInlineAliasDefinition(text, matchIndex, cleanupPatterns = [], normalize = (value) => String(value || '')) {
    const before = String(text || '').slice(0, matchIndex);
    const withoutPriorAliases = stripPriorDefinitionParentheses(before, cleanupPatterns);
    const sentenceTail = withoutPriorAliases.split(/[。；;]/).pop() || withoutPriorAliases;
    const clauseTail = sentenceTail.split(/[、，]/).pop() || sentenceTail;
    const connectiveParts = clauseTail.split(/(?:に対して|において|について|に関して|として)/);
    return normalize(connectiveParts.pop() || clauseTail).replace(/^[はがをにへとで、。\s　]+/, '');
  }

  function isJapaneseWordChar(ch) {
    return !!ch && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}]/u.test(ch);
  }

  function isAllowedDefinitionBoundaryChar(ch) {
    return !ch || /[\s　、。，．・（）()「」『』【】［］〔〕《》〈〉・／/]/u.test(ch) || /[はがをにへとでものや及び又はか]/u.test(ch);
  }

  function isTermBoundarySafe(text, start, end) {
    const value = String(text || '');
    const prevText = value.slice(Math.max(0, start - 2), start);
    const prevChar = value[start - 1] || '';
    const nextChar = value[end] || '';
    if (/(?:当該|同|各|本|旧|新)$/.test(prevText)) {
      return !(isJapaneseWordChar(nextChar) && !isAllowedDefinitionBoundaryChar(nextChar));
    }
    if (isJapaneseWordChar(prevChar) && !isAllowedDefinitionBoundaryChar(prevChar)) return false;
    if (isJapaneseWordChar(nextChar) && !isAllowedDefinitionBoundaryChar(nextChar)) return false;
    return true;
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
      lawId: info.law_id || law?.law_id || law?.lawId || '',
      lawName: rev.law_title || rev.abbrev || law?.law_title || law?.law_name || law?.lawName || '(名称不明)',
      lawNum: info.law_num || law?.law_num || law?.lawNum || '',
      lawType: info.law_type || rev.law_type || law?.law_type || law?.lawType || '',
    };
  }

  async function searchLawsByTitle(query, { limit = 31 } = {}) {
    const url =
      `${LAW_BASE_URL}/api/2/laws?law_title=${encodeURIComponent(query)}` +
      `&limit=${encodeURIComponent(limit)}&response_format=json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return extractLaws(data);
  }

  function collectSearchTextSegments(searchRoot, { excludeSelector = '' } = {}) {
    const segments = [];
    let text = '';
    const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el || !node.textContent) return NodeFilter.FILTER_SKIP;
        if (excludeSelector && el.closest(excludeSelector)) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const nodeText = node.textContent || '';
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

  function getJapanDateString(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function findCurrentLawRevisionId(revisions, today = getJapanDateString()) {
    const list = Array.isArray(revisions) ? revisions : [];
    const current = list.find((revision) => revision?.current_revision_status === 'CurrentEnforced');
    if (current?.law_revision_id) return current.law_revision_id;

    const enforced = list
      .filter((revision) => {
        if (!revision?.law_revision_id || revision.current_revision_status === 'UnEnforced') return false;
        const date = revision.amendment_enforcement_date || revision.amendment_scheduled_enforcement_date || '';
        return date && date <= today;
      })
      .sort((a, b) => {
        const aDate = a.amendment_enforcement_date || a.amendment_scheduled_enforcement_date || '';
        const bDate = b.amendment_enforcement_date || b.amendment_scheduled_enforcement_date || '';
        return bDate.localeCompare(aDate);
      });
    if (enforced[0]?.law_revision_id) return enforced[0].law_revision_id;

    return list.find((revision) => (
      revision?.current_revision_status === 'PreviousEnforced' && revision.law_revision_id
    ))?.law_revision_id || '';
  }

  function getLiteLawDataUrl(target, asOf = '') {
    const asOfParam = asOf ? `&asof=${encodeURIComponent(asOf)}` : '';
    return `${LAW_BASE_URL}/api/2/law_data/${encodeURIComponent(target)}?response_format=xml&law_full_text_format=xml${asOfParam}`;
  }

  async function readCachedLiteLawXml(target, cachesApi = global.caches) {
    if (!target || !cachesApi) return '';
    try {
      const cache = await cachesApi.open(LITE_LAW_CACHE_NAME);
      const response = await cache.match(getLiteLawDataUrl(target));
      return response ? response.text() : '';
    } catch (_) {
      return '';
    }
  }

  async function trimLiteLawCache(cache) {
    const requests = await cache.keys();
    if (requests.length <= LITE_LAW_CACHE_MAX_ENTRIES) return;
    const entries = await Promise.all(requests.map(async (request) => {
      const response = await cache.match(request);
      return {
        request,
        cachedAt: Number(response?.headers.get('X-Egov-Cached-At')) || 0,
      };
    }));
    entries.sort((a, b) => a.cachedAt - b.cachedAt);
    const deleteCount = entries.length - LITE_LAW_CACHE_MAX_ENTRIES;
    await Promise.all(entries.slice(0, deleteCount).map(({ request }) => cache.delete(request)));
  }

  async function cacheLiteLawXml(target, xmlText, cachesApi = global.caches) {
    if (!target || !xmlText || !cachesApi) return;
    const cache = await cachesApi.open(LITE_LAW_CACHE_NAME);
    await cache.put(getLiteLawDataUrl(target), new Response(xmlText, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'X-Egov-Cached-At': String(Date.now()),
      },
    }));
    await trimLiteLawCache(cache);
    if (typeof cachesApi.delete === 'function') {
      await Promise.all(LITE_LAW_LEGACY_CACHE_NAMES.map((name) => cachesApi.delete(name).catch(() => false)));
    }
  }

  function openReferencesDb({ openErrorMessage = 'IndexedDB open failed' } = {}) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(REFERENCES_DB_NAME, REFERENCES_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(REFERENCES_LAWS_STORE)) {
          db.createObjectStore(REFERENCES_LAWS_STORE, { keyPath: 'lawId' });
        }
        if (!db.objectStoreNames.contains(REFERENCES_META_STORE)) {
          db.createObjectStore(REFERENCES_META_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(REFERENCES_BUNDLED_CACHE_STORE)) {
          db.createObjectStore(REFERENCES_BUNDLED_CACHE_STORE, { keyPath: 'lawId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(openErrorMessage));
    });
  }

  function idbRequest(request, errorMessage = 'IndexedDB request failed') {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(errorMessage));
    });
  }

  function waitForTransaction(
    tx,
    {
      abortMessage = 'IndexedDB transaction aborted',
      errorMessage = 'IndexedDB transaction failed',
    } = {}
  ) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error(abortMessage));
      tx.onerror = () => reject(tx.error || new Error(errorMessage));
    });
  }

  async function getLawReferencesData(lawId, runtime = global.chrome?.runtime) {
    if (!lawId || !runtime?.sendMessage) return {};
    try {
      const response = await runtime.sendMessage({
        type: 'egov-get-imported-law-references',
        lawId,
      });
      if (response?.ok && isPlainObject(response.lawReferences)) {
        return response.lawReferences;
      }
    } catch (_) {}
    return {};
  }

  global.EgovShared = Object.freeze({
    LAW_BASE_URL,
    REFERENCES_BUNDLED_CACHE_STORE,
    REFERENCES_CURRENT_META_KEY,
    REFERENCES_DB_NAME,
    REFERENCES_DB_VERSION,
    REFERENCES_LAWS_STORE,
    REFERENCES_META_STORE,
    REVERSE_REFERENCE_SCOPE_KEY,
    applyReferenceLinksInBatches,
    buildLawUrl,
    buildProvisionCopyPayload,
    cacheLiteLawXml,
    canonicalizeReferenceTargetKey,
    cleanLawNameForSearch,
    cloneDefinitionPatterns,
    collectInternalLawReferences,
    collectSearchTextSegments,
    configureReferenceClickable,
    DEFINITION_PATTERNS,
    escapeHtml,
    extractInlineAliasDefinition,
    extractLaws,
    extractTermBeforeParentheticalDefinition,
    formatArticleNumber,
    formatLawNameHtml,
    formatProvisionNumber,
    formatProvisionSourcePath,
    formatProvisionSourcePathFromEgovUrl,
    findCurrentLawRevisionId,
    getJapanDateString,
    getLawReferencesData,
    getReferenceTargetKeyFromEgovUrl,
    getLiteLawDataUrl,
    getLawFields,
    getReferenceDomParts,
    getReverseReferenceScopeFlags,
    idbRequest,
    isAllowedDefinitionBoundaryChar,
    isJapaneseWordChar,
    isPlainObject,
    isTermBoundarySafe,
    normalizeLawNameForCopy,
    normalizeReverseReferenceScope,
    openReferencesDb,
    parseProvisionHash,
    parseJapaneseReferenceNumber,
    parseProvisionPathFromEgovUrl,
    rangeFromSearchOffsets,
    readCachedLiteLawXml,
    searchLawsByTitle,
    sortReferenceSources,
    splitReferenceTargetKey,
    mergeLawReferences,
    stripPriorDefinitionParentheses,
    waitForTransaction,
  });
})(globalThis);
