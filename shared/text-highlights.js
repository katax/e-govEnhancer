(function (global) {
  'use strict';

  const STORAGE_PREFIX = 'textHighlights:v1:';
  const DISPLAY_LIMIT = 1000;
  const QUOTE_HEAD_LENGTH = 256;
  const QUOTE_TAIL_LENGTH = 128;
  const CONTEXT_LENGTH = 32;
  const MEMO_MAX_LENGTH = 2000;
  const TEXT_EXCLUDE_SELECTOR =
    '#egov-ext-text-highlight-popup,#egov-ext-text-highlight-memo-tooltip,' +
    '#egov-ext-text-highlight-target-outline,#egov-ext-text-highlight-restore-notice,' +
    '#egov-ext-text-highlight-overlap-notice,' +
    '.lite-definition-tooltip,.egov-reference-popup';
  const PORTABLE_TEXT_EXCLUDE_SELECTOR =
    `${TEXT_EXCLUDE_SELECTOR},.article-caption,.article-title,.law-num,rt,rp`;
  const COLORS = [
    { key: 'yellow', label: '薄い黄色' },
    { key: 'pink', label: '薄いピンク' },
    { key: 'green', label: '薄い緑' },
  ];

  function create({ root, lawId, onBeforeOpen = null } = {}) {
    if (!(root instanceof Element) || !lawId || !global.CSS?.highlights || typeof global.Highlight !== 'function') {
      return null;
    }

    const shared = global.EgovShared;
    const storageKey = `${STORAGE_PREFIX}${lawId}`;
    const rangesByColor = { yellow: [], pink: [], green: [] };
    const records = new Map();
    const dirtyRecordIds = new Set();
    const deletedRecordIds = new Set();
    const rangeRecordIds = new WeakMap();
    const rangeSequences = new WeakMap();
    let sequence = 0;
    let popup = null;
    let targetOutline = null;
    let targetOutlineRaf = 0;
    let tooltip = null;
    let tooltipRecordId = '';
    let tooltipSource = null;
    let tooltipHideTimer = 0;
    let hitTestCache = null;
    let pendingRange = null;
    let pendingSource = null;
    let rangeAdjusting = false;
    let rangeButtonResetTimer = 0;
    let overlapNoticeTimer = 0;
    let loaded = false;
    let loadPromise = null;
    let saveTimer = 0;
    let restoreTimer = 0;
    let restoreNoticeTimer = 0;
    let unrestoredRecords = [];
    let unrestoredSignature = '';
    let unrestoredStablePasses = 0;
    let restoreNoticeIgnored = false;
    let pendingStorageRecords = null;

    function getContainerElement(node) {
      return node instanceof Element ? node : node?.parentElement || null;
    }

    function isRangeInsideRoot(range) {
      const start = getContainerElement(range?.startContainer);
      const end = getContainerElement(range?.endContainer);
      return !!start && !!end && root.contains(start) && root.contains(end);
    }

    function normalizeKeyPart(value) {
      return String(value || '').trim().replace(/[\u2010-\u2015\u2212-]+/g, '_');
    }

    function getProvisionParts(element) {
      if (!(element instanceof Element)) return null;
      const provision = element.closest('.law-item[data-item-num],.law-subitem[data-item-num],.law-paragraph[data-paragraph-num],.law-article[data-article-num]');
      if (!provision || !root.contains(provision)) return null;
      const article = provision.closest('.law-article[data-article-num]');
      const paragraph = provision.closest('.law-paragraph[data-paragraph-num]');
      const item = provision.closest('.law-item[data-item-num],.law-subitem[data-item-num]');
      const scope = provision.closest('[data-reference-scope]')?.dataset.referenceScope || '';
      const articleNum = normalizeKeyPart(article?.dataset.articleNum || provision.dataset.articleNum);
      if (!articleNum) return null;
      return {
        scope: normalizeKeyPart(scope),
        article: articleNum,
        paragraph: normalizeKeyPart(paragraph?.dataset.paragraphNum || provision.dataset.paragraphNum),
        item: normalizeKeyPart(item?.dataset.itemNum || provision.dataset.itemNum),
        element: provision,
      };
    }

    function formatProvisionKey(parts, { scoped = true } = {}) {
      if (!parts?.article) return '';
      let key = parts.article;
      if (parts.paragraph) key += `.${parts.paragraph}`;
      if (parts.item) key += `.${parts.item}`;
      return scoped && parts.scope ? `${parts.scope}::${key}` : key;
    }

    function getRangeAnchor(range) {
      const end = getContainerElement(range?.endContainer);
      let element = getContainerElement(range?.startContainer);
      while (element && element !== root) {
        if (getProvisionParts(element)?.element === element && element.contains(end)) return element;
        element = element.parentElement;
      }
      return root.contains(end) ? root : null;
    }

    function getTextOffset(anchor, node, offset) {
      try {
        const range = document.createRange();
        range.selectNodeContents(anchor);
        range.setEnd(node, offset);
        return range.toString().length;
      } catch (_) {
        return -1;
      }
    }

    function getSearchOffset(anchor, node, offset) {
      const options = { excludeSelector: PORTABLE_TEXT_EXCLUDE_SELECTOR };
      try {
        const prefixRange = document.createRange();
        prefixRange.selectNodeContents(anchor);
        prefixRange.setEnd(node, offset);
        return shared.getTextRangeText(prefixRange, options).replace(/\s+/g, '').length;
      } catch (_) {
        return -1;
      }
    }

    function getPortableText(range) {
      return shared.getTextRangeText(range, {
        excludeSelector: PORTABLE_TEXT_EXCLUDE_SELECTOR,
      }).replace(/\s+/g, '');
    }

    function portableRangeMatchesRecord(range, record) {
      const selectedText = getPortableText(range);
      if (!selectedText || !record.q) return false;
      if (!record.z) return selectedText === record.q;
      return selectedText.startsWith(record.q) && selectedText.endsWith(record.z);
    }

    function getPortableAnchorParts(node) {
      const element = getContainerElement(node);
      if (!element) return null;
      const paragraph = element.closest('.law-paragraph[data-article-num][data-paragraph-num]');
      if (paragraph && root.contains(paragraph)) return getProvisionParts(paragraph);
      const article = element.closest('.law-article[data-article-num]');
      if (article && root.contains(article)) return getProvisionParts(article);
      return getProvisionParts(element);
    }

    function updatePortableFields(record, range) {
      const startParts = getPortableAnchorParts(range.startContainer);
      const endParts = getPortableAnchorParts(range.endContainer);
      const portableStart = startParts?.element
        ? getSearchOffset(startParts.element, range.startContainer, range.startOffset)
        : -1;
      const portableEnd = endParts?.element
        ? getSearchOffset(endParts.element, range.endContainer, range.endOffset)
        : -1;
      if (!startParts?.element || !endParts?.element || portableStart < 0 || portableEnd <= 0) return false;
      const portableText = getPortableText(range);
      if (!portableText) return false;
      const fields = {
        u: formatProvisionKey(startParts),
        v: formatProvisionKey(endParts),
        x: portableStart,
        y: portableEnd,
        f: 2,
        l: portableText.length,
        q: portableText.slice(0, QUOTE_HEAD_LENGTH),
        z: portableText.length > QUOTE_HEAD_LENGTH ? portableText.slice(-QUOTE_TAIL_LENGTH) : '',
        w: shared.getNormalizedTextSignature(portableText),
      };
      if (!fields.u || !fields.v) return false;
      const changed = Object.entries(fields).some(([key, value]) => record[key] !== value);
      Object.assign(record, fields);
      return changed;
    }

    function createRecord(range, colorKey, recordId = '', memo = '') {
      const anchor = getRangeAnchor(range);
      if (!anchor || !rangesByColor[colorKey]) return null;
      const start = getTextOffset(anchor, range.startContainer, range.startOffset);
      const end = getTextOffset(anchor, range.endContainer, range.endOffset);
      const selectedText = range.toString();
      if (start < 0 || end <= start || !selectedText) return null;
      const anchorText = anchor.textContent || '';
      const anchorParts = getProvisionParts(anchor);
      const startParts = getProvisionParts(getContainerElement(range.startContainer));
      const id = recordId || global.crypto.randomUUID?.() ||
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
      const record = {
        id,
        c: colorKey,
        a: anchor.id || '',
        h: formatProvisionKey(anchorParts),
        k: formatProvisionKey(startParts, { scoped: false }),
        s: start,
        e: end,
        l: selectedText.length,
        q: selectedText.slice(0, QUOTE_HEAD_LENGTH),
        z: selectedText.length > QUOTE_HEAD_LENGTH ? selectedText.slice(-QUOTE_TAIL_LENGTH) : '',
        p: anchorText.slice(Math.max(0, start - CONTEXT_LENGTH), start),
        n: anchorText.slice(end, end + CONTEXT_LENGTH),
        m: String(memo || '').slice(0, MEMO_MAX_LENGTH),
        t: Date.now(),
      };
      if (!updatePortableFields(record, range)) return null;
      return record;
    }

    function normalizeRecord(record) {
      if (!record || typeof record !== 'object') return null;
      const colorKey = String(record.c || '');
      const id = String(record.id || '');
      const anchorId = String(record.a || '');
      const start = Number(record.s);
      const end = Number(record.e);
      const length = Number(record.l);
      if (!rangesByColor[colorKey] || !id || !anchorId || !Number.isInteger(start) ||
          !Number.isInteger(end) || !Number.isInteger(length) || start < 0 || end <= start || length <= 0) {
        return null;
      }
      const normalized = {
        id: id.slice(0, 80),
        c: colorKey,
        a: anchorId.slice(0, 500),
        h: String(record.h || '').slice(0, 120),
        k: String(record.k || '').slice(0, 100),
        s: start,
        e: end,
        l: length,
        q: String(record.q || '').slice(0, QUOTE_HEAD_LENGTH),
        z: String(record.z || '').slice(-QUOTE_TAIL_LENGTH),
        p: String(record.p || '').slice(-CONTEXT_LENGTH),
        n: String(record.n || '').slice(0, CONTEXT_LENGTH),
        m: String(record.m || '').slice(0, MEMO_MAX_LENGTH),
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

    async function loadRecords() {
      if (loaded) return;
      if (loadPromise) return loadPromise;
      loadPromise = global.chrome.storage.local.get([storageKey]).then((stored) => {
        const list = Array.isArray(stored[storageKey]) ? stored[storageKey] : [];
        list.forEach((raw) => {
          const record = normalizeRecord(raw);
          if (record) records.set(record.id, record);
        });
      }).catch(() => {}).finally(() => {
        loaded = true;
        loadPromise = null;
      });
      return loadPromise;
    }

    function getRecordSignature(record) {
      return record ? JSON.stringify([
        record.c, record.a, record.h, record.k, record.s, record.e, record.l,
        record.q, record.z, record.p, record.n, record.m, record.t,
        record.u, record.v, record.x, record.y, record.w,
        record.f,
      ]) : '';
    }

    function syncRecordsFromStorage(rawRecords) {
      if (isMemoDirty()) {
        pendingStorageRecords = rawRecords;
        return;
      }
      const external = new Map();
      (Array.isArray(rawRecords) ? rawRecords : []).forEach((raw) => {
        const record = normalizeRecord(raw);
        if (record) external.set(record.id, record);
      });
      const changedIds = new Set();
      records.forEach((record, id) => {
        if (dirtyRecordIds.has(id) || deletedRecordIds.has(id)) return;
        if (getRecordSignature(record) !== getRecordSignature(external.get(id))) changedIds.add(id);
      });
      external.forEach((record, id) => {
        if (dirtyRecordIds.has(id) || deletedRecordIds.has(id)) return;
        if (getRecordSignature(record) !== getRecordSignature(records.get(id))) changedIds.add(id);
      });
      if (!changedIds.size) return;
      if (isMemoEditing()) hidePopup({ force: true });
      changedIds.forEach((id) => {
        const record = external.get(id);
        if (record) records.set(id, record);
        else records.delete(id);
      });
      Object.keys(rangesByColor).forEach((colorKey) => {
        rangesByColor[colorKey] = rangesByColor[colorKey].filter((range) => !changedIds.has(rangeRecordIds.get(range)));
        refreshColor(colorKey);
      });
      scheduleRestore(0);
    }

    async function persistNow() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = 0;
      await loadRecords();
      if (!dirtyRecordIds.size && !deletedRecordIds.size) return;
      const dirtySnapshot = new Map();
      dirtyRecordIds.forEach((id) => {
        const record = records.get(id);
        if (record) dirtySnapshot.set(id, record);
      });
      const deletedSnapshot = new Set(deletedRecordIds);
      const stored = await global.chrome.storage.local.get([storageKey]).catch(() => ({}));
      const merged = new Map();
      (Array.isArray(stored[storageKey]) ? stored[storageKey] : []).forEach((raw) => {
        const record = normalizeRecord(raw);
        if (record) merged.set(record.id, record);
      });
      deletedSnapshot.forEach((id) => merged.delete(id));
      dirtySnapshot.forEach((record, id) => merged.set(id, record));
      const list = Array.from(merged.values())
        .sort((first, second) => (second.t || 0) - (first.t || 0));
      let saved = false;
      try {
        if (list.length) await global.chrome.storage.local.set({ [storageKey]: list });
        else await global.chrome.storage.local.remove(storageKey);
        saved = true;
      } catch (_) {}
      if (!saved) return;
      dirtySnapshot.forEach((record, id) => {
        if (records.get(id) === record) dirtyRecordIds.delete(id);
      });
      deletedSnapshot.forEach((id) => deletedRecordIds.delete(id));
      new Map(list.map((record) => [record.id, record])).forEach((record, id) => {
        if (!dirtyRecordIds.has(id) && !deletedRecordIds.has(id)) records.set(id, record);
      });
    }

    function persistSoon() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(persistNow, 180);
    }

    function buildAnchorIndex() {
      const index = new Map();
      root.querySelectorAll('.law-article[data-article-num],.law-paragraph[data-paragraph-num],.law-item[data-item-num],.law-subitem[data-item-num]')
        .forEach((element) => {
          const parts = getProvisionParts(element);
          [formatProvisionKey(parts), formatProvisionKey(parts, { scoped: false })].filter(Boolean).forEach((key) => {
            if (!index.has(key)) index.set(key, []);
            index.get(key).push(element);
          });
        });
      return index;
    }

    function restorePortableRange(record, anchorIndex) {
      if (!record.u || !record.v || !Number.isInteger(record.x) || !Number.isInteger(record.y)) return null;
      const startAnchors = anchorIndex.get(record.u) || [];
      const endAnchors = anchorIndex.get(record.v) || [];
      const options = {
        excludeSelector: PORTABLE_TEXT_EXCLUDE_SELECTOR,
      };
      for (const startAnchor of startAnchors) {
        for (const endAnchor of endAnchors) {
          const range = shared.rangeFromNormalizedTextAnchorOffsets(
            startAnchor, record.x, endAnchor, record.y, options,
          );
          if (!range || !isRangeInsideRoot(range)) continue;
          if (!portableRangeMatchesRecord(range, record)) continue;
          return range;
        }
      }
      return null;
    }

    function restoreRecord(record, anchorIndex) {
      const portableRange = restorePortableRange(record, anchorIndex);
      if (!portableRange) return false;
      const restored = portableRange.cloneRange();
      rangeSequences.set(restored, ++sequence);
      rangeRecordIds.set(restored, record.id);
      rangesByColor[record.c].push(restored);
      const pendingRecordId = pendingSource ? rangeRecordIds.get(pendingSource.range) : '';
      if (popup && pendingRecordId === record.id) {
        pendingRange = restored.cloneRange();
        pendingSource = { colorKey: record.c, range: restored };
      }
      return true;
    }

    function refreshColor(colorKey) {
      hitTestCache = null;
      rangesByColor[colorKey] = rangesByColor[colorKey]
        .filter((range) => range.startContainer?.isConnected && range.endContainer?.isConnected);
      global.CSS.highlights.set(`egov-ext-text-highlight-${colorKey}`, new global.Highlight(...rangesByColor[colorKey]));
    }

    function rangeMatchesRecord(range, record) {
      if (!range || !record || range.collapsed ||
          !range.startContainer?.isConnected || !range.endContainer?.isConnected) return false;
      return portableRangeMatchesRecord(range, record);
    }

    function getUnrestoredRecords() {
      const restoredIds = new Set();
      const displayIds = new Set(getDisplayRecords().map((record) => record.id));
      Object.values(rangesByColor).forEach((ranges) => {
        ranges.forEach((range) => {
          const id = rangeRecordIds.get(range);
          if (id && displayIds.has(id) && rangeMatchesRecord(range, records.get(id))) restoredIds.add(id);
        });
      });
      return Array.from(records.values()).filter((record) => !restoredIds.has(record.id));
    }

    function getDisplayRecords() {
      return Array.from(records.values())
        .sort((first, second) => (second.t || 0) - (first.t || 0))
        .slice(0, DISPLAY_LIMIT);
    }

    function getDisplayLimitExceededCount() {
      return Math.max(0, records.size - DISPLAY_LIMIT);
    }

    function formatUnrestoredTarget(record, end = false) {
      const key = end ? (record.v || record.h) : (record.u || record.h || record.k);
      const label = global.EgovApp?.getReferenceTargetLabel?.(key);
      return key ? (label || key) : '不明';
    }

    function buildUnrestoredReport(list) {
      const items = list.map((record) => [
        '【対象条文】',
        `開始位置：${formatUnrestoredTarget(record)}`,
        `終了位置：${formatUnrestoredTarget(record, true)}`,
        '',
        '【対象メモ】',
        String(record.m || '').trim() ? String(record.m || '') : 'なし',
        '---',
      ].join('\n'));
      return ['改正等により、描画できなかったハイライト/メモ', ...items].join('\n');
    }

    function downloadUnrestoredReport() {
      const list = getUnrestoredRecords();
      if (!list.length) {
        clearRestoreNotice();
        return;
      }
      const date = new Date();
      const stamp = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
        .map((value) => String(value).padStart(2, '0')).join('');
      const safeLawId = String(lawId).replace(/[^0-9A-Za-z_-]/g, '') || 'law';
      const blob = new Blob(['\uFEFF', buildUnrestoredReport(list)], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `描画できなかったハイライト・メモ_${safeLawId}_${stamp}.txt`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function deleteUnrestoredHighlights() {
      const list = getUnrestoredRecords();
      if (!list.length) {
        clearRestoreNotice();
        return;
      }
      if (!global.confirm('復元できなかったハイライト/メモを削除してよいですか？')) return;
      list.forEach((record) => {
        records.delete(record.id);
        dirtyRecordIds.delete(record.id);
        deletedRecordIds.add(record.id);
      });
      Object.keys(rangesByColor).forEach((colorKey) => {
        rangesByColor[colorKey] = rangesByColor[colorKey].filter((range) => (
          !deletedRecordIds.has(rangeRecordIds.get(range))
        ));
        refreshColor(colorKey);
      });
      persistSoon();
      clearRestoreNotice();
    }

    function ignoreRestoreNotice() {
      restoreNoticeIgnored = true;
      clearRestoreNotice();
    }

    function renderRestoreNotice() {
      const list = getUnrestoredRecords();
      const signature = list.map((record) => record.id).sort().join('\n');
      if (signature !== unrestoredSignature) {
        scheduleRestoreNotice(list);
        return;
      }
      let notice = document.querySelector('#egov-ext-text-highlight-restore-notice');
      if (!list.length) {
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
        button.addEventListener('click', downloadUnrestoredReport);
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'egov-ext-text-highlight-restore-delete';
        deleteButton.textContent = '削除';
        deleteButton.addEventListener('click', deleteUnrestoredHighlights);
        const ignoreButton = document.createElement('button');
        ignoreButton.type = 'button';
        ignoreButton.textContent = '無視';
        ignoreButton.addEventListener('click', ignoreRestoreNotice);
        const actions = document.createElement('div');
        actions.className = 'egov-ext-text-highlight-restore-actions';
        actions.append(button, deleteButton, ignoreButton);
        notice.append(message, actions);
        document.body.appendChild(notice);
      }
      const message = notice.querySelector('.egov-ext-text-highlight-restore-message');
      if (message) {
        const limitExceededCount = getDisplayLimitExceededCount();
        message.textContent = limitExceededCount
          ? `表示できなかったハイライト/メモが${list.length}件あります（うち${limitExceededCount}件は表示上限1,000件を超えています）。`
          : `復元できなかったハイライト/メモが${list.length}件あります。`;
      }
    }

    function clearRestoreNotice() {
      if (restoreNoticeTimer) clearTimeout(restoreNoticeTimer);
      restoreNoticeTimer = 0;
      unrestoredRecords = [];
      unrestoredSignature = '';
      unrestoredStablePasses = 0;
      document.querySelector('#egov-ext-text-highlight-restore-notice')?.remove();
    }

    function scheduleRestoreNotice(list, delay = 1500) {
      if (restoreNoticeIgnored) {
        clearRestoreNotice();
        return;
      }
      unrestoredRecords = Array.from(list || []);
      const signature = unrestoredRecords.map((record) => record.id).sort().join('\n');
      if (restoreNoticeTimer) clearTimeout(restoreNoticeTimer);
      const notice = document.querySelector('#egov-ext-text-highlight-restore-notice');
      if (!signature && !notice) {
        restoreNoticeTimer = 0;
        unrestoredSignature = '';
        unrestoredStablePasses = 0;
        return;
      }
      if (signature === unrestoredSignature) {
        unrestoredStablePasses += 1;
      } else {
        unrestoredSignature = signature;
        unrestoredStablePasses = 1;
      }
      if (unrestoredStablePasses < 3) {
        restoreNoticeTimer = setTimeout(() => {
          restoreNoticeTimer = 0;
          restore().catch(() => {});
        }, 550);
        return;
      }
      restoreNoticeTimer = setTimeout(() => {
        restoreNoticeTimer = 0;
        if (signature) renderRestoreNotice();
        else clearRestoreNotice();
      }, delay);
    }

    async function restore() {
      await loadRecords();
      if (!root.isConnected || !records.size) {
        Object.keys(rangesByColor).forEach(refreshColor);
        scheduleRestoreNotice([]);
        return;
      }
      const connected = new Set();
      const displayRecords = getDisplayRecords();
      const displayIds = new Set(displayRecords.map((record) => record.id));
      Object.keys(rangesByColor).forEach((colorKey) => {
        rangesByColor[colorKey] = rangesByColor[colorKey].filter((range) => {
          const id = rangeRecordIds.get(range);
          const record = records.get(id);
          const valid = displayIds.has(id) && rangeMatchesRecord(range, record);
          if (valid && id) connected.add(id);
          return valid;
        });
      });
      const anchorIndex = buildAnchorIndex();
      let restored = 0;
      for (const record of displayRecords) {
        if (connected.has(record.id)) continue;
        if (restoreRecord(record, anchorIndex)) {
          connected.add(record.id);
          restored += 1;
        }
        if (restored && restored % 25 === 0) await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      Object.keys(rangesByColor).forEach(refreshColor);
      scheduleRestoreNotice(Array.from(records.values()).filter((record) => !connected.has(record.id)));
    }

    function scheduleRestore(delay = 120) {
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        restoreTimer = 0;
        restore().catch(() => {});
      }, delay);
    }

    function contentChanged() {
      hitTestCache = null;
      if (popup && !isMemoDirty()) hidePopup({ force: true });
      scheduleRestore(0);
    }

    function layoutChanged() {
      hitTestCache = null;
      hideTooltip();
      if (popup) scheduleTargetOutline();
    }

    function isMemoEditing() {
      return !!popup?.querySelector('.egov-ext-text-highlight-memo-editor.is-visible');
    }

    function isMemoDirty() {
      const textarea = popup?.querySelector('.egov-ext-text-highlight-memo-editor.is-visible textarea');
      return !!textarea && textarea.value !== (textarea.dataset.initialValue || '');
    }

    function updateDirtyState() {
      const editor = popup?.querySelector('.egov-ext-text-highlight-memo-editor');
      const textarea = editor?.querySelector('textarea');
      const status = editor?.querySelector('.egov-ext-text-highlight-memo-status');
      if (!editor || !textarea || !status) return false;
      const dirty = textarea.value !== (textarea.dataset.initialValue || '');
      editor.classList.toggle('is-dirty', dirty);
      status.textContent = dirty ? '未保存のメモの変更があります' : '';
      return dirty;
    }

    function hideTargetOutline() {
      if (targetOutlineRaf) global.cancelAnimationFrame(targetOutlineRaf);
      targetOutlineRaf = 0;
      targetOutline?.remove();
      targetOutline = null;
    }

    function getTargetRects(range) {
      if (!range?.startContainer?.isConnected || !range?.endContainer?.isConnected) return [];
      const rects = shared.getTextRangeClientRects(range, {
        excludeSelector: '#egov-ext-text-highlight-popup,#egov-ext-text-highlight-memo-tooltip,#egov-ext-text-highlight-target-outline',
      })
        .filter((rect) => rect.width > 0.5 && rect.height > 0.5 &&
          rect.right > 0 && rect.bottom > 0 && rect.left < global.innerWidth && rect.top < global.innerHeight)
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

    function showTargetOutline(range = pendingRange) {
      hideTargetOutline();
      const rects = getTargetRects(range);
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
      targetOutline = outline;
    }

    function scheduleTargetOutline() {
      if (targetOutlineRaf) return;
      targetOutlineRaf = global.requestAnimationFrame(() => {
        targetOutlineRaf = 0;
        if (popup) showTargetOutline();
      });
    }

    function hidePopup({ force = false } = {}) {
      if (!force && isMemoEditing()) return false;
      if (rangeButtonResetTimer) clearTimeout(rangeButtonResetTimer);
      rangeButtonResetTimer = 0;
      rangeAdjusting = false;
      popup?.remove();
      popup = null;
      hideTargetOutline();
      pendingRange = null;
      pendingSource = null;
      if (pendingStorageRecords) {
        const nextRecords = pendingStorageRecords;
        pendingStorageRecords = null;
        setTimeout(() => syncRecordsFromStorage(nextRecords), 0);
      }
      return true;
    }

    function hideTooltip() {
      if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
      tooltipHideTimer = 0;
      tooltip?.remove();
      tooltip = null;
      tooltipRecordId = '';
      tooltipSource = null;
    }

    function cancelTooltipHide() {
      if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
      tooltipHideTimer = 0;
    }

    function scheduleTooltipHide(delay = 500) {
      if (tooltipHideTimer) return;
      tooltipHideTimer = setTimeout(() => {
        tooltipHideTimer = 0;
        hideTooltip();
      }, delay);
    }

    function positionPopup(element, clientX, clientY) {
      const gap = 10;
      const padding = 8;
      const rect = element.getBoundingClientRect();
      let left = clientX + gap;
      let top = clientY + gap;
      if (left + rect.width > innerWidth - padding) left = clientX - rect.width - gap;
      if (top + rect.height > innerHeight - padding) top = clientY - rect.height - gap;
      element.style.left = `${Math.max(padding, left)}px`;
      element.style.top = `${Math.max(padding, top)}px`;
      element.classList.toggle('memo-above', clientY > innerHeight / 2);
      element.classList.toggle('memo-align-right', left + 550 > innerWidth - padding);
    }

    function positionTooltip(element, clientX, clientY) {
      const gap = 12;
      const padding = 8;
      const rect = element.getBoundingClientRect();
      let left = clientX + gap;
      let top = clientY + gap;
      if (left + rect.width > innerWidth - padding) left = clientX - rect.width - gap;
      if (top + rect.height > innerHeight - padding) top = clientY - rect.height - gap;
      element.style.left = `${Math.max(padding, left)}px`;
      element.style.top = `${Math.max(padding, top)}px`;
    }

    function getHitTestEntries() {
      if (hitTestCache) return hitTestCache;
      const entries = [];
      Object.entries(rangesByColor).forEach(([colorKey, colorRanges]) => {
        colorRanges.forEach((range) => {
          if (!range.startContainer?.isConnected || !range.endContainer?.isConnected) return;
          entries.push({
            colorKey,
            range,
            rects: Array.from(range.getClientRects()),
            sequence: rangeSequences.get(range) || 0,
          });
        });
      });
      hitTestCache = entries;
      return entries;
    }

    function findAtPoint(clientX, clientY) {
      const caret = document.caretPositionFromPoint?.(clientX, clientY);
      const fallback = !caret ? document.caretRangeFromPoint?.(clientX, clientY) : null;
      const node = caret?.offsetNode || fallback?.startContainer;
      const offset = caret?.offset ?? fallback?.startOffset;
      if (!node || !Number.isInteger(offset)) return null;
      const matches = [];
      getHitTestEntries().forEach((entry) => {
        if (!entry.rects.some((rect) => clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom)) return;
        try {
          if (entry.range.comparePoint(node, offset) === 0) matches.push(entry);
        } catch (_) {}
      });
      matches.sort((first, second) => second.sequence - first.sequence);
      return matches[0] || null;
    }

    function showMemoEditor({ focus = false } = {}) {
      const editor = popup?.querySelector('.egov-ext-text-highlight-memo-editor');
      const button = popup?.querySelector('[data-highlight-memo]');
      const textarea = editor?.querySelector('textarea');
      if (!editor) return;
      if (!editor.classList.contains('is-visible') && textarea) textarea.dataset.initialValue = textarea.value;
      editor.classList.add('is-visible');
      button?.setAttribute('aria-expanded', 'true');
      updateDirtyState();
      if (focus) {
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    }

    function cancelMemoEdit({ focusButton = true } = {}) {
      const editor = popup?.querySelector('.egov-ext-text-highlight-memo-editor.is-visible');
      const textarea = editor?.querySelector('textarea');
      if (!editor || !textarea) return true;
      const initial = textarea.dataset.initialValue || '';
      if (isMemoDirty() && !global.confirm('メモを保存せずに閉じていいですか？')) {
        textarea.focus();
        return false;
      }
      textarea.value = initial;
      updateDirtyState();
      editor.classList.remove('is-visible');
      popup.querySelector('[data-highlight-memo]')?.setAttribute('aria-expanded', 'false');
      if (focusButton) popup.querySelector('[data-highlight-memo]')?.focus();
      return true;
    }

    function applyHighlight(colorKey) {
      const range = pendingRange;
      if (!range || !isRangeInsideRoot(range) || !rangesByColor[colorKey]) {
        const status = popup?.querySelector('.egov-ext-text-highlight-memo-status');
        if (status) status.textContent = '本文が更新されたため、ハイライト位置を再確認しています';
        scheduleRestore(0);
        popup?.querySelector('textarea')?.focus();
        return;
      }
      if (findOverlappingRange(range, pendingSource?.range || null)) {
        showOverlapNotice();
        flashRangeButton('重複不可');
        return;
      }
      const sourceId = pendingSource ? rangeRecordIds.get(pendingSource.range) || '' : '';
      const memo = popup?.querySelector('.egov-ext-text-highlight-memo-input')?.value || '';
      if (pendingSource) {
        rangesByColor[pendingSource.colorKey] = rangesByColor[pendingSource.colorKey]
          .filter((item) => item !== pendingSource.range);
        refreshColor(pendingSource.colorKey);
      }
      const nextRange = range.cloneRange();
      const record = createRecord(nextRange, colorKey, sourceId, memo);
      if (!record) {
        const status = popup?.querySelector('.egov-ext-text-highlight-memo-status');
        if (status) status.textContent = 'この位置には保存できません。メモをコピーしてからキャンセルしてください';
        scheduleRestore(0);
        popup?.querySelector('textarea')?.focus();
        return;
      }
      rangeSequences.set(nextRange, ++sequence);
      if (sourceId) records.delete(sourceId);
      records.set(record.id, record);
      rangeRecordIds.set(nextRange, record.id);
      dirtyRecordIds.add(record.id);
      deletedRecordIds.delete(record.id);
      rangesByColor[colorKey].push(nextRange);
      refreshColor(colorKey);
      persistSoon();
      hidePopup({ force: true });
      getSelection()?.removeAllRanges();
    }

    function rangesOverlap(first, second) {
      try {
        return first.compareBoundaryPoints(Range.START_TO_END, second) > 0 &&
          first.compareBoundaryPoints(Range.END_TO_START, second) < 0;
      } catch (_) {
        return false;
      }
    }

    function findOverlappingRange(range, excludedRange = null) {
      return Object.values(rangesByColor).flat().find((item) => (
        item !== excludedRange && rangesOverlap(item, range)
      )) || null;
    }

    function showOverlapNotice(clientX = null, clientY = null) {
      if (overlapNoticeTimer) clearTimeout(overlapNoticeTimer);
      document.querySelector('#egov-ext-text-highlight-overlap-notice')?.remove();
      const notice = document.createElement('div');
      notice.id = 'egov-ext-text-highlight-overlap-notice';
      notice.setAttribute('role', 'status');
      notice.textContent = '既存のハイライトと重なる範囲にハイライトを設定することはできません';
      document.body.appendChild(notice);
      const anchorRect = popup?.getBoundingClientRect();
      const left = Number.isFinite(clientX) ? clientX : anchorRect?.left;
      const top = Number.isFinite(clientY) ? clientY : anchorRect?.bottom;
      notice.style.left = `${Math.max(8, Math.min(Number(left) || 8, innerWidth - notice.offsetWidth - 8))}px`;
      notice.style.top = `${Math.max(8, Math.min((Number(top) || 8) + 10, innerHeight - notice.offsetHeight - 8))}px`;
      overlapNoticeTimer = setTimeout(() => {
        overlapNoticeTimer = 0;
        notice.remove();
      }, 2200);
    }

    function updateRangeButton(label = '') {
      const button = popup?.querySelector('[data-highlight-range]');
      if (!button) return;
      button.textContent = label || (rangeAdjusting ? '選択中…' : '範囲');
      button.setAttribute('aria-pressed', String(rangeAdjusting));
    }

    function flashRangeButton(label) {
      if (rangeButtonResetTimer) clearTimeout(rangeButtonResetTimer);
      updateRangeButton(label);
      rangeButtonResetTimer = setTimeout(() => {
        rangeButtonResetTimer = 0;
        updateRangeButton();
      }, 1400);
    }

    function toggleRangeAdjustment() {
      rangeAdjusting = !rangeAdjusting;
      updateRangeButton();
      if (rangeAdjusting) getSelection()?.removeAllRanges();
    }

    function applyAdjustedRange(range, clientX, clientY) {
      if (!range || !isRangeInsideRoot(range) || range.collapsed || !range.toString().trim()) {
        flashRangeButton('範囲を選択');
        return false;
      }
      if (findOverlappingRange(range, pendingSource?.range || null)) {
        showOverlapNotice(clientX, clientY);
        flashRangeButton('重複不可');
        return false;
      }
      const source = pendingSource;
      const sourceId = source ? rangeRecordIds.get(source.range) || '' : '';
      const sourceRecord = sourceId ? records.get(sourceId) : null;
      if (!source || !sourceId || !sourceRecord) {
        flashRangeButton('変更失敗');
        return false;
      }
      const nextRange = range.cloneRange();
      const nextRecord = createRecord(nextRange, source.colorKey, sourceId, sourceRecord.m);
      if (!nextRecord) {
        flashRangeButton('変更失敗');
        return false;
      }
      rangesByColor[source.colorKey] = rangesByColor[source.colorKey]
        .filter((item) => item !== source.range);
      rangeSequences.set(nextRange, ++sequence);
      rangeRecordIds.set(nextRange, sourceId);
      records.set(sourceId, nextRecord);
      dirtyRecordIds.add(sourceId);
      deletedRecordIds.delete(sourceId);
      rangesByColor[source.colorKey].push(nextRange);
      refreshColor(source.colorKey);
      persistSoon();
      pendingRange = nextRange.cloneRange();
      pendingSource = { colorKey: source.colorKey, range: nextRange };
      showTargetOutline(pendingRange);
      rangeAdjusting = false;
      flashRangeButton('変更済み');
      getSelection()?.removeAllRanges();
      return true;
    }

    function removeHighlight() {
      const range = pendingRange;
      if (!range || !isRangeInsideRoot(range)) {
        hidePopup({ force: true });
        return;
      }
      const removing = pendingSource ? [pendingSource.range] : Object.values(rangesByColor).flat().filter((item) => rangesOverlap(item, range));
      const removesMemo = removing.some((item) => records.get(rangeRecordIds.get(item))?.m);
      if (removesMemo && !global.confirm('ハイライトとともにメモも削除されますが良いですか？')) return;
      Object.keys(rangesByColor).forEach((colorKey) => {
        rangesByColor[colorKey] = rangesByColor[colorKey].filter((item) => {
          const shouldRemove = pendingSource ? item === pendingSource.range : rangesOverlap(item, range);
          if (!shouldRemove) return true;
          const id = rangeRecordIds.get(item);
          if (id) {
            records.delete(id);
            dirtyRecordIds.delete(id);
            deletedRecordIds.add(id);
          }
          return false;
        });
        refreshColor(colorKey);
      });
      persistSoon();
      scheduleRestoreNotice(getUnrestoredRecords(), 0);
      hidePopup({ force: true });
      getSelection()?.removeAllRanges();
    }

    function showPopup(range, clientX, clientY, source = null) {
      if (isMemoEditing()) return;
      hidePopup({ force: true });
      hideTooltip();
      onBeforeOpen?.();
      pendingRange = range.cloneRange();
      pendingSource = source;
      showTargetOutline(pendingRange);
      const sourceRecord = source ? records.get(rangeRecordIds.get(source.range)) : null;
      const element = document.createElement('div');
      element.id = 'egov-ext-text-highlight-popup';
      element.setAttribute('role', 'toolbar');
      element.setAttribute('aria-label', 'ハイライトの編集');
      element.innerHTML = COLORS.map(({ key, label }) => (
        `<button type="button" class="egov-ext-text-highlight-swatch is-${key}${source?.colorKey === key ? ' is-active' : ''}" ` +
        `data-highlight-color="${key}" aria-label="${label}" aria-pressed="${source?.colorKey === key}" title="${label}"></button>`
      )).join('') +
        '<span class="egov-ext-text-highlight-divider" aria-hidden="true"></span>' +
        (source ? '<button type="button" class="egov-ext-text-highlight-range-button" data-highlight-range aria-label="ハイライト範囲を変更" aria-pressed="false" title="ハイライト範囲を選び直す">範囲</button>' : '') +
        '<button type="button" class="egov-ext-text-highlight-memo-button" data-highlight-memo aria-label="メモを追加・編集" aria-expanded="false" title="メモを追加・編集">メモ</button>' +
        '<button type="button" class="egov-ext-text-highlight-remove" data-highlight-remove aria-label="ハイライトを消す" title="ハイライトを消す">×</button>' +
        '<div class="egov-ext-text-highlight-memo-editor">' +
        `<textarea class="egov-ext-text-highlight-memo-input" rows="6" maxlength="${MEMO_MAX_LENGTH}" aria-label="ハイライトのメモ" placeholder="メモを入力…"></textarea>` +
        '<div class="egov-ext-text-highlight-memo-footer"><div class="egov-ext-text-highlight-memo-status" aria-live="polite"></div>' +
        '<div class="egov-ext-text-highlight-memo-hint">色選択・Ctrl+Enterで確定/「メモ」かESCでキャンセル</div></div></div>';
      const memoInput = element.querySelector('.egov-ext-text-highlight-memo-input');
      memoInput.value = sourceRecord?.m || '';
      element.addEventListener('pointerdown', (event) => {
        if (!event.target.closest('textarea')) event.preventDefault();
      });
      element.addEventListener('click', (event) => {
        const rangeButton = event.target.closest('[data-highlight-range]');
        if (rangeButton) {
          event.preventDefault();
          event.stopPropagation();
          toggleRangeAdjustment();
          return;
        }
        const memoButton = event.target.closest('[data-highlight-memo]');
        if (memoButton) {
          event.preventDefault();
          event.stopPropagation();
          if (isMemoEditing()) cancelMemoEdit();
          else showMemoEditor({ focus: true });
          return;
        }
        if (event.target.closest('[data-highlight-remove]')) {
          event.preventDefault();
          event.stopPropagation();
          removeHighlight();
          return;
        }
        const colorButton = event.target.closest('[data-highlight-color]');
        if (!colorButton) return;
        event.preventDefault();
        event.stopPropagation();
        applyHighlight(colorButton.dataset.highlightColor || '');
      });
      document.body.appendChild(element);
      popup = element;
      memoInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && event.ctrlKey) {
          event.preventDefault();
          event.stopPropagation();
          const selected = element.querySelector('[data-highlight-color].is-active') || element.querySelector('[data-highlight-color]');
          applyHighlight(selected?.dataset.highlightColor || COLORS[0].key);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancelMemoEdit();
        }
      });
      memoInput.addEventListener('input', updateDirtyState);
      memoInput.addEventListener('focusout', () => {
        setTimeout(() => {
          // Losing focus because the browser window/tab itself became inactive
          // must not close the memo editor. Only an in-page focus move may close
          // an unchanged editor.
          if (!document.hasFocus()) return;
          if (!isMemoEditing() || isMemoDirty()) return;
          cancelMemoEdit({ focusButton: false });
        }, 0);
      });
      positionPopup(element, clientX, clientY);
      if (sourceRecord?.m) showMemoEditor({ focus: true });
    }

    function showTooltip(record, source, clientX, clientY) {
      if (!record?.m || popup) {
        hideTooltip();
        return;
      }
      cancelTooltipHide();
      if (tooltip && tooltipRecordId === record.id) return;
      hideTooltip();
      const element = document.createElement('div');
      element.id = 'egov-ext-text-highlight-memo-tooltip';
      element.className = `is-${source.colorKey}`;
      element.setAttribute('role', 'tooltip');
      element.textContent = record.m;
      element.addEventListener('pointerenter', cancelTooltipHide);
      element.addEventListener('pointerleave', () => scheduleTooltipHide(500));
      element.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const active = tooltipSource;
        if (active?.range?.startContainer?.isConnected) showPopup(active.range, event.clientX, event.clientY, active);
      });
      document.body.appendChild(element);
      tooltip = element;
      tooltipRecordId = record.id;
      tooltipSource = source;
      positionTooltip(element, clientX, clientY);
    }

    function setupInteractions() {
      const longPressDelay = 550;
      const moveTolerance = 8;
      let longPressTimer = 0;
      let longPressStart = null;
      let suppressClick = null;
      let ignoreSelectionUntil = 0;
      let hoverRaf = 0;
      let hoverTimer = 0;
      let pendingHoverId = '';
      let hoverPoint = null;

      function clearHover({ immediate = false } = {}) {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = 0;
        pendingHoverId = '';
        if (immediate) hideTooltip();
        else scheduleTooltipHide(500);
      }

      function scheduleHover(event) {
        if (event.pointerType === 'touch') return;
        hoverPoint = { clientX: event.clientX, clientY: event.clientY, target: event.target };
        if (hoverRaf) return;
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0;
          const point = hoverPoint;
          if (point?.target?.closest?.('#egov-ext-text-highlight-memo-tooltip')) {
            cancelTooltipHide();
            return;
          }
          if (!point || popup || !root.contains(point.target)) {
            clearHover();
            return;
          }
          const source = findAtPoint(point.clientX, point.clientY);
          const record = source ? records.get(rangeRecordIds.get(source.range)) : null;
          if (!record?.m) {
            clearHover();
            return;
          }
          if (tooltipRecordId === record.id) {
            cancelTooltipHide();
            return;
          }
          if (pendingHoverId === record.id) return;
          if (hoverTimer) clearTimeout(hoverTimer);
          pendingHoverId = record.id;
          hoverTimer = setTimeout(() => {
            hoverTimer = 0;
            pendingHoverId = '';
            if (!hoverPoint || popup) return;
            const current = findAtPoint(hoverPoint.clientX, hoverPoint.clientY);
            const currentRecord = current ? records.get(rangeRecordIds.get(current.range)) : null;
            if (currentRecord?.id === record.id) showTooltip(record, current, hoverPoint.clientX, hoverPoint.clientY);
          }, 220);
        });
      }

      function clearLongPress() {
        if (longPressTimer) clearTimeout(longPressTimer);
        longPressTimer = 0;
        longPressStart = null;
      }

      function matchesTarget(target, pressed) {
        if (!(target instanceof Node) || !(pressed instanceof Node)) return false;
        return target === pressed || (target instanceof Element && target.contains(pressed)) ||
          (pressed instanceof Element && pressed.contains(target));
      }

      function isPriorityClickTarget(target) {
        const element = target instanceof Element ? target : target?.parentElement;
        return !!element?.closest(
          'a[href], .lite-defined-term[data-term], .egov-lite-reference-clickable'
        );
      }

      document.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.isPrimary === false ||
            event.target.closest?.('#egov-ext-text-highlight-popup,#egov-ext-text-highlight-memo-tooltip') ||
            isMemoEditing() || !root.contains(event.target)) return;
        clearHover({ immediate: true });
        const source = findAtPoint(event.clientX, event.clientY);
        if (!source) return;
        clearLongPress();
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
          ignoreSelectionUntil = performance.now() + 1200;
          suppressClick = { target: pressed.target, expiresAt: performance.now() + 1200 };
          getSelection()?.removeAllRanges();
          showPopup(pressed.source.range, pressed.clientX, pressed.clientY, pressed.source);
          longPressStart = null;
        }, longPressDelay);
      }, true);
      document.addEventListener('pointermove', (event) => {
        if (longPressStart && event.pointerId === longPressStart.pointerId &&
            Math.hypot(event.clientX - longPressStart.clientX, event.clientY - longPressStart.clientY) > moveTolerance) {
          clearLongPress();
        }
        scheduleHover(event);
      }, true);
      document.addEventListener('pointerup', clearLongPress, true);
      document.addEventListener('pointercancel', clearLongPress, true);
      document.addEventListener('click', (event) => {
        if (rangeAdjusting && !event.target.closest?.('#egov-ext-text-highlight-popup')) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          return;
        }
        if (suppressClick) {
          if (performance.now() > suppressClick.expiresAt) suppressClick = null;
          else if (matchesTarget(event.target, suppressClick.target)) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            suppressClick = null;
            return;
          }
        }
        if (isMemoEditing() && !event.target.closest?.('#egov-ext-text-highlight-popup')) {
          if (isMemoDirty()) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            popup?.querySelector('textarea')?.focus();
            return;
          }
          cancelMemoEdit({ focusButton: false });
          hidePopup();
        }
      }, true);
      document.addEventListener('contextmenu', (event) => {
        if (!suppressClick || performance.now() > suppressClick.expiresAt || !matchesTarget(event.target, suppressClick.target)) return;
        event.preventDefault();
        event.stopPropagation();
      }, true);
      document.addEventListener('mouseup', (event) => {
        if (event.button !== 0 || event.target.closest?.('#egov-ext-text-highlight-popup,#egov-ext-text-highlight-memo-tooltip') ||
            (!rangeAdjusting && isMemoEditing()) || performance.now() < ignoreSelectionUntil) return;
        const { clientX, clientY } = event;
        setTimeout(() => {
          const selection = getSelection();
          if (rangeAdjusting) {
            const adjusted = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
            applyAdjustedRange(adjusted, clientX, clientY);
            return;
          }
          if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || !selection.toString().trim()) {
            const clickedSource = findAtPoint(clientX, clientY);
            if (clickedSource && !isPriorityClickTarget(event.target)) {
              showPopup(clickedSource.range, clientX, clientY, clickedSource);
              return;
            }
            hidePopup();
            return;
          }
          const range = selection.getRangeAt(0);
          if (!isRangeInsideRoot(range)) {
            hidePopup();
            return;
          }
          if (findOverlappingRange(range)) {
            hidePopup({ force: true });
            showOverlapNotice(clientX, clientY);
            return;
          }
          showPopup(range, clientX, clientY);
        }, 0);
      });
      document.addEventListener('mousedown', (event) => {
        if (event.target.closest?.('#egov-ext-text-highlight-popup')) return;
        if (rangeAdjusting) return;
        if (isMemoEditing()) {
          if (isMemoDirty()) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            popup?.querySelector('textarea')?.focus();
            return;
          }
          cancelMemoEdit({ focusButton: false });
        }
        hidePopup();
      }, true);
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if (isMemoEditing()) cancelMemoEdit();
        else hidePopup();
      });
      document.addEventListener('scroll', () => {
        hitTestCache = null;
        if (!hidePopup()) scheduleTargetOutline();
        clearHover({ immediate: true });
      }, true);
      global.addEventListener('blur', () => {
        // Keep the highlight/memo popup open while the memo editor is visible,
        // even when no text has been changed yet. The user may temporarily move
        // to another window to check or copy information for the memo.
        if (isMemoEditing()) {
          clearHover({ immediate: true });
          return;
        }
        hidePopup();
        clearHover({ immediate: true });
      });
      global.addEventListener('resize', () => {
        hitTestCache = null;
        if (!hidePopup()) scheduleTargetOutline();
        clearHover({ immediate: true });
      });
    global.addEventListener('pagehide', () => {
        if (saveTimer) persistNow();
      });
    }

    async function getEntries() {
      await loadRecords();
      await restore();
      const live = new Map();
      Object.entries(rangesByColor).forEach(([colorKey, colorRanges]) => {
        colorRanges.forEach((range) => {
          const id = rangeRecordIds.get(range);
          if (id && !live.has(id)) live.set(id, { colorKey, range });
        });
      });
      return getDisplayRecords().map((record) => {
        const source = live.get(record.id) || null;
        return {
          id: record.id,
          colorKey: source?.colorKey || record.c,
          memo: record.m || '',
          text: source?.range ? source.range.toString() : `${record.q || ''}${record.z ? `…${record.z}` : ''}`,
          startKey: record.u || record.k || '',
          endKey: record.v || record.u || record.k || '',
          range: source?.range || null,
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

    function removeById(recordId) {
      const id = String(recordId || '');
      if (!id || !records.has(id)) return false;
      Object.keys(rangesByColor).forEach((colorKey) => {
        rangesByColor[colorKey] = rangesByColor[colorKey]
          .filter((range) => rangeRecordIds.get(range) !== id);
        refreshColor(colorKey);
      });
      records.delete(id);
      dirtyRecordIds.delete(id);
      deletedRecordIds.add(id);
      persistSoon();
      scheduleRestoreNotice(getUnrestoredRecords(), 0);
      return true;
    }

    function closeUi() {
      if (isMemoDirty()) {
        popup?.querySelector('textarea')?.focus();
        return false;
      }
      hidePopup({ force: true });
      hideTooltip();
      return true;
    }

    const observer = new MutationObserver(() => {
      hitTestCache = null;
      if (popup) scheduleTargetOutline();
      if (records.size) scheduleRestore(100);
    });
    observer.observe(root, { childList: true, subtree: true });
    global.chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[storageKey]) {
        syncRecordsFromStorage(changes[storageKey].newValue);
      }
    });
    setupInteractions();
    loadRecords().then(restore).catch(() => {});

    return Object.freeze({
      contentChanged,
      layoutChanged,
      restore,
      persistNow,
      getEntries,
      removeById,
      closeUi,
      displayLimit: DISPLAY_LIMIT,
    });
  }

  global.EgovTextHighlights = Object.freeze({ create });
})(globalThis);
