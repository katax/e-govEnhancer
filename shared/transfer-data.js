(function (global) {
  'use strict';
  const FAVORITES_EXPORT_TYPE = 'egov-extension-favorites';
  const FAVORITES_EXPORT_VERSION = 1;
  const FAVORITES_MAX = 50;
  const TEXT_HIGHLIGHTS_EXPORT_TYPE = 'egov-extension-text-highlights';
  const TEXT_HIGHLIGHTS_EXPORT_VERSION = 1;
  const TEXT_HIGHLIGHTS_RECORD_LIMIT = 10000;
  const TEXT_HIGHLIGHTS_COLORS = new Set(['yellow', 'pink', 'green']);
  const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
  function isTextHighlightLawId(value) {
    return /^[0-9A-Z]{12,20}$/.test(String(value || ''));
  }

  function sanitizeTextHighlightRecord(raw, path) {
    if (!isPlainObject(raw)) throw new Error(`${path} がオブジェクトではありません。`);

    const id = String(raw.id || '');
    const color = String(raw.c || '');
    const anchorId = String(raw.a || '');
    const start = Number(raw.s);
    const end = Number(raw.e);
    const length = Number(raw.l);
    if (!id || id.length > 80) throw new Error(`${path}.id が不正です。`);
    if (!TEXT_HIGHLIGHTS_COLORS.has(color)) throw new Error(`${path}.c が不正です。`);
    if (!anchorId || anchorId.length > 500) throw new Error(`${path}.a が不正です。`);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(length) ||
        start < 0 || end <= start || length <= 0) {
      throw new Error(`${path} の範囲情報が不正です。`);
    }
    const stringFields = [
      ['h', 120, false], ['k', 100, false], ['q', 256, true], ['z', 128, false],
      ['p', 32, false], ['n', 32, false], ['m', 2000, false],
    ];
    for (const [field, maxLength, required] of stringFields) {
      if (typeof raw[field] !== 'string' || (required && !raw[field]) || raw[field].length > maxLength) {
        throw new Error(`${path}.${field} が不正です。`);
      }
    }
    if (!Number.isFinite(raw.t) || raw.t < 0) throw new Error(`${path}.t が不正です。`);
    const hasPortableRange = raw.u !== undefined || raw.v !== undefined || raw.x !== undefined ||
      raw.y !== undefined || raw.f !== undefined;
    if (!hasPortableRange ||
        typeof raw.u !== 'string' || !raw.u || raw.u.length > 120 ||
         typeof raw.v !== 'string' || !raw.v || raw.v.length > 120 ||
         !Number.isSafeInteger(raw.x) || raw.x < 0 ||
         !Number.isSafeInteger(raw.y) || raw.y <= 0 ||
         raw.f !== 2 ||
         !(raw.w === undefined || (typeof raw.w === 'string' && raw.w.length <= 32))) {
      throw new Error(`${path} のモード共有用範囲情報が不正です。`);
    }

    const sanitized = {
      id,
      c: color,
      a: anchorId,
      h: raw.h,
      k: raw.k,
      s: start,
      e: end,
      l: length,
      q: raw.q,
      z: raw.z,
      p: raw.p,
      n: raw.n,
      m: raw.m,
      t: raw.t,
    };
    if (hasPortableRange) {
      sanitized.u = raw.u;
      sanitized.v = raw.v;
      sanitized.x = raw.x;
      sanitized.y = raw.y;
      sanitized.f = 2;
      if (raw.w) sanitized.w = raw.w;
    }
    return sanitized;
  }

  function validateTextHighlightsImport(raw) {
    if (!isPlainObject(raw)) throw new Error('JSON のトップレベルがオブジェクトではありません。');
    if (raw.type !== TEXT_HIGHLIGHTS_EXPORT_TYPE) {
      throw new Error('メモとハイライトのエクスポートファイルではありません。');
    }
    if (raw.version !== TEXT_HIGHLIGHTS_EXPORT_VERSION) {
      throw new Error(`対応していないバージョンです: ${String(raw.version)}`);
    }
    if (!isPlainObject(raw.laws)) throw new Error('laws がオブジェクトではありません。');

    const laws = {};
    let highlightCount = 0;
    let memoCount = 0;
    for (const [lawId, rawRecords] of Object.entries(raw.laws)) {
      if (!isTextHighlightLawId(lawId)) throw new Error(`法令IDが不正です: ${lawId}`);
      if (!Array.isArray(rawRecords)) throw new Error(`laws.${lawId} が配列ではありません。`);
      if (rawRecords.length > TEXT_HIGHLIGHTS_RECORD_LIMIT) {
        throw new Error(`${lawId} のハイライトは最大 ${TEXT_HIGHLIGHTS_RECORD_LIMIT} 件までです。`);
      }
      const ids = new Set();
      const records = rawRecords.map((record, index) => {
        const sanitized = sanitizeTextHighlightRecord(record, `laws.${lawId}[${index}]`);
        if (ids.has(sanitized.id)) throw new Error(`${lawId} に重複したハイライトIDがあります。`);
        ids.add(sanitized.id);
        if (sanitized.m) memoCount += 1;
        return sanitized;
      });
      if (records.length) laws[lawId] = records;
      highlightCount += records.length;
    }

    return {
      type: TEXT_HIGHLIGHTS_EXPORT_TYPE,
      version: TEXT_HIGHLIGHTS_EXPORT_VERSION,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      laws,
      summary: { lawCount: Object.keys(laws).length, highlightCount, memoCount },
    };
  }

  function buildTextHighlightsSummary(summary = {}) {
    return [
      `法令 ${summary.lawCount || 0} 件`,
      `ハイライト ${summary.highlightCount || 0} 件`,
      `メモ ${summary.memoCount || 0} 件`,
    ].join(' / ');
  }

  function sanitizeFavoriteRecord(raw, index, folderIds) {
    if (!isPlainObject(raw)) {
      throw new Error(`favorites[${index}] がオブジェクトではありません。`);
    }
    if (!isNonEmptyString(raw.lawId)) {
      throw new Error(`favorites[${index}].lawId が不正です。`);
    }
    if (!isNonEmptyString(raw.lawName)) {
      throw new Error(`favorites[${index}].lawName が不正です。`);
    }
    if (typeof raw.lawNum !== 'string') {
      throw new Error(`favorites[${index}].lawNum が文字列ではありません。`);
    }
    if (typeof raw.lawType !== 'string') {
      throw new Error(`favorites[${index}].lawType が文字列ではありません。`);
    }
    if (!(raw.folderId === null || raw.folderId === undefined || isNonEmptyString(raw.folderId))) {
      throw new Error(`favorites[${index}].folderId が不正です。`);
    }
    if (raw.folderId && !folderIds.has(raw.folderId)) {
      throw new Error(`favorites[${index}].folderId が存在しないフォルダを参照しています。`);
    }
    if (!(raw.lastScrollTop === undefined || (Number.isFinite(raw.lastScrollTop) && raw.lastScrollTop >= 0))) {
      throw new Error(`favorites[${index}].lastScrollTop が不正です。`);
    }
    if (!(raw.lastArticleKey === undefined || isNonEmptyString(raw.lastArticleKey))) {
      throw new Error(`favorites[${index}].lastArticleKey が不正です。`);
    }
    if (!(raw.lastArticleOffset === undefined ||
      (Number.isFinite(raw.lastArticleOffset) && raw.lastArticleOffset >= 0 && raw.lastArticleOffset <= 1))) {
      throw new Error(`favorites[${index}].lastArticleOffset が不正です。`);
    }

    const favorite = {
      lawId: raw.lawId.trim(),
      lawName: raw.lawName.trim(),
      lawNum: raw.lawNum,
      lawType: raw.lawType,
      folderId: raw.folderId ? raw.folderId.trim() : null,
    };

    if (raw.lastScrollTop !== undefined) {
      favorite.lastScrollTop = Math.round(raw.lastScrollTop);
    }
    if (raw.lastArticleKey !== undefined) {
      favorite.lastArticleKey = raw.lastArticleKey.trim();
      favorite.lastArticleOffset = raw.lastArticleOffset === undefined ? 0 : raw.lastArticleOffset;
    }

    return favorite;
  }

  function sanitizeFolderRecord(raw, index) {
    if (!isPlainObject(raw)) {
      throw new Error(`favFolders[${index}] がオブジェクトではありません。`);
    }
    if (!isNonEmptyString(raw.id)) {
      throw new Error(`favFolders[${index}].id が不正です。`);
    }
    if (!isNonEmptyString(raw.name)) {
      throw new Error(`favFolders[${index}].name が不正です。`);
    }
    return {
      id: raw.id.trim(),
      name: raw.name.trim(),
    };
  }

  function sanitizeFolderCollapsed(raw, folderIds) {
    if (raw === undefined) return {};
    if (!isPlainObject(raw)) {
      throw new Error('folderCollapsed がオブジェクトではありません。');
    }

    const normalized = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key !== '__uncat__' && !folderIds.has(key)) {
        throw new Error(`folderCollapsed.${key} が存在しないフォルダを参照しています。`);
      }
      if (typeof value !== 'boolean') {
        throw new Error(`folderCollapsed.${key} が真偽値ではありません。`);
      }
      normalized[key] = value;
    }
    return normalized;
  }

  function validateFavoritesImport(raw) {
    if (!isPlainObject(raw)) {
      throw new Error('JSON のトップレベルがオブジェクトではありません。');
    }
    if (raw.type !== FAVORITES_EXPORT_TYPE) {
      throw new Error('この拡張機能のエクスポートファイルではありません。');
    }
    if (raw.version !== FAVORITES_EXPORT_VERSION) {
      throw new Error(`対応していないバージョンです: ${String(raw.version)}`);
    }
    if (!Array.isArray(raw.favorites)) {
      throw new Error('favorites が配列ではありません。');
    }
    if (!Array.isArray(raw.favFolders)) {
      throw new Error('favFolders が配列ではありません。');
    }
    if (raw.favorites.length > FAVORITES_MAX) {
      throw new Error(`favorites は最大 ${FAVORITES_MAX} 件までです。`);
    }

    const favFolders = raw.favFolders.map((folder, index) => sanitizeFolderRecord(folder, index));
    const folderIds = new Set();
    for (const folder of favFolders) {
      if (folderIds.has(folder.id)) {
        throw new Error(`favFolders に重複した id があります: ${folder.id}`);
      }
      folderIds.add(folder.id);
    }

    const favorites = raw.favorites.map((favorite, index) => sanitizeFavoriteRecord(favorite, index, folderIds));
    const lawIds = new Set();
    for (const favorite of favorites) {
      if (lawIds.has(favorite.lawId)) {
        throw new Error(`favorites に重複した lawId があります: ${favorite.lawId}`);
      }
      lawIds.add(favorite.lawId);
    }

    const folderCollapsed = sanitizeFolderCollapsed(raw.folderCollapsed, folderIds);
    const exportedAt = typeof raw.exportedAt === 'string' ? raw.exportedAt : '';

    return {
      type: FAVORITES_EXPORT_TYPE,
      version: FAVORITES_EXPORT_VERSION,
      exportedAt,
      favorites,
      favFolders,
      folderCollapsed,
    };
  }

  global.EgovTransferData = { isTextHighlightLawId, validateFavoritesImport, validateTextHighlightsImport, buildTextHighlightsSummary };
})(globalThis);
