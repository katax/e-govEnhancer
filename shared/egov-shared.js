(function (global) {
  'use strict';

  const LAW_BASE_URL = 'https://laws.e-gov.go.jp';
  const REFERENCES_DB_NAME = 'egov-extension-references';
  const REFERENCES_DB_VERSION = 2;
  const REFERENCES_LAWS_STORE = 'laws';
  const REFERENCES_META_STORE = 'meta';
  const REFERENCES_BUNDLED_CACHE_STORE = 'bundled_cache';
  const REFERENCES_CURRENT_META_KEY = 'current';
  const LITE_LAW_CACHE_NAME = 'egov-lite-law-xml-v1';
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

    const suffix = rawHash.slice((articleMatch.index ?? 0) + articleMatch[0].length);
    const paragraph = suffix.match(/(?:^|-)(?:Co|Pr)_([0-9_]+)/)?.[1] || '';
    const item = suffix.match(/(?:^|-)(?:It|Sg)_([0-9_]+)/)?.[1] || '';
    return { article, paragraph, item };
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
    let text = formatProvisionBranch(parts.article, '条');
    if (parts.paragraph) text += formatProvisionBranch(parts.paragraph, '項');
    if (parts.item) text += formatProvisionBranch(parts.item, '号');
    return text;
  }

  function formatProvisionSourcePathFromEgovUrl(url, base = LAW_BASE_URL) {
    return formatProvisionSourcePath(parseProvisionPathFromEgovUrl(url, base));
  }

  function sortReferenceSources(sources, currentLawTitle, normalize = normalizeLawNameForCopy) {
    const currentTitle = normalize(currentLawTitle || '');
    const currentPrefix = currentTitle.slice(0, 5);
    return (Array.isArray(sources) ? sources : [])
      .map((source, index) => {
        const sourceTitle = normalize(source?.sourceLawTitle || '');
        const sourcePrefix = sourceTitle.slice(0, 5);
        return {
          source,
          index,
          isRelated: !!(
            (currentPrefix && sourceTitle.includes(currentPrefix)) ||
            (sourcePrefix && currentTitle.includes(sourcePrefix))
          ),
        };
      })
      .sort((a, b) => {
        if (a.isRelated !== b.isRelated) return a.isRelated ? -1 : 1;
        return a.index - b.index;
      });
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
    clickable.title = `外部法令からの参照元 ${sources.length}件`;
    clickable.dataset.egovReferenceTargetKey = targetKey;
    sourceMap.set(clickable, sources);
    if (clickable.dataset.egovReferenceBound === 'true') return;
    clickable.dataset.egovReferenceBound = 'true';

    const open = (point) => showPopup({
      targetKey: clickable.dataset.egovReferenceTargetKey,
      sources: sourceMap.get(clickable),
      point,
    });
    clickable.addEventListener('click', (event) => {
      if (!isEnabled()) return;
      event.preventDefault();
      event.stopPropagation();
      open({ x: event.clientX, y: event.clientY });
    });
    clickable.addEventListener('keydown', (event) => {
      if (!isEnabled() || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      const rect = clickable.getBoundingClientRect();
      open({ x: rect.left, y: rect.bottom });
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
    const step = () => {
      if (!isEnabled()) return;
      const end = Math.min(entries.length, index + batchSize);
      for (; index < end; index += 1) {
        if (!isEnabled()) return;
        const [targetKey, value] = entries[index];
        const sources = Array.isArray(value?.externalLawSources) ? value.externalLawSources : [];
        if (!sources.length) continue;
        const target = findTarget(targetKey);
        if (target) makeClickable(target, targetKey, sources);
      }
      if (index < entries.length) schedule(step);
    };
    step();
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

  function getLiteLawDataUrl(target) {
    return `${LAW_BASE_URL}/api/2/law_data/${encodeURIComponent(target)}?response_format=xml&law_full_text_format=xml`;
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
    applyReferenceLinksInBatches,
    buildLawUrl,
    buildProvisionCopyPayload,
    cacheLiteLawXml,
    cloneDefinitionPatterns,
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
    getLawReferencesData,
    getLiteLawDataUrl,
    getLawFields,
    idbRequest,
    isAllowedDefinitionBoundaryChar,
    isJapaneseWordChar,
    isPlainObject,
    isTermBoundarySafe,
    normalizeLawNameForCopy,
    openReferencesDb,
    parseProvisionHash,
    parseProvisionPathFromEgovUrl,
    rangeFromSearchOffsets,
    readCachedLiteLawXml,
    searchLawsByTitle,
    sortReferenceSources,
    stripPriorDefinitionParentheses,
    waitForTransaction,
  });
})(globalThis);
