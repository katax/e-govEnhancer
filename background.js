importScripts('shared/egov-shared.js');

chrome.runtime.onStartup?.addListener(() => {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
});

chrome.runtime.onInstalled?.addListener((details) => {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
  if (details?.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(() => {});
  }
  // 未パッケージ拡張の「再読み込み」でも update が発火するため、実際にバージョンが変わったときだけクリアする
  if (details?.reason === 'update' && details.previousVersion !== chrome.runtime.getManifest().version) {
    clearReferencesCache().catch(() => {});
  }
});

async function openManualPage() {
  return chrome.tabs.create({
    url: chrome.runtime.getURL('docs/user-manual.html'),
    active: true,
  });
}

const {
  REFERENCES_BUNDLED_CACHE_STORE,
  REFERENCES_CURRENT_META_KEY,
  REFERENCES_LAWS_STORE,
  REFERENCES_META_STORE,
  cacheLiteLawXml,
  findCurrentLawRevisionId,
  getJapanDateString,
  getLiteLawDataUrl,
  idbRequest,
  isPlainObject,
  openReferencesDb,
  waitForTransaction,
} = globalThis.EgovShared;
let bundledReferencesParsePromise = null;
let bundledReferencesReaderCount = 0;
const EGOV_API_V2_BASE = 'https://laws.e-gov.go.jp/api/2';
const liteLawLoadPromises = new Map();
const GOOGLE_DRIVE_FAVORITES_FILE_NAME = 'egov-enhancer-favorites.json';
const GOOGLE_DRIVE_FAVORITES_TYPE = 'egov-extension-google-drive-favorites';
const GOOGLE_DRIVE_FAVORITES_VERSION = 4;
const GOOGLE_DRIVE_HIGHLIGHTS_FILE_NAME = 'egov-enhancer-highlights-memos.json';
const GOOGLE_DRIVE_HIGHLIGHTS_TYPE = 'egov-extension-google-drive-highlights-memos';
const GOOGLE_DRIVE_HIGHLIGHTS_VERSION = 1;
const TEXT_HIGHLIGHTS_STORAGE_PREFIX = 'textHighlights:v1:';
const GOOGLE_DRIVE_SYNC_ALARM = 'egov-google-drive-favorites-sync';
const GOOGLE_DRIVE_PERIODIC_ALARM = 'egov-google-drive-favorites-periodic';
const GOOGLE_DRIVE_SYNC_KEYS = Object.freeze({
  enabled: 'googleDriveFavoritesSyncEnabled',
  accountEmail: 'googleDriveFavoritesAccountEmail',
  localUpdatedAt: 'googleDriveFavoritesLocalUpdatedAt',
  lastSyncAt: 'googleDriveFavoritesLastSyncAt',
  lastError: 'googleDriveFavoritesLastError',
  deviceId: 'googleDriveFavoritesDeviceId',
  syncFavorites: 'googleDriveSyncFavoritesEnabled',
  syncHighlights: 'googleDriveSyncHighlightsEnabled',
  highlightRecords: 'googleDriveHighlightRecordState',
});
const GOOGLE_DRIVE_FAVORITE_STORAGE_KEYS = ['favorites', 'favFolders', 'folderCollapsed', 'articleBookmarks'];
let applyingGoogleDriveFavorites = false;
let applyingGoogleDriveHighlights = false;
let googleDriveFavoriteTimestampPromise = Promise.resolve();
let googleDriveFavoriteChangeRevision = 0;
let googleDriveHighlightChangeRevision = 0;
let googleDriveSyncPromise = null;

function getAuthTokenValue(result) {
  return typeof result === 'string' ? result : result?.token || '';
}

async function getGoogleDriveAccessToken(interactive = false) {
  const result = await chrome.identity.getAuthToken({
    interactive,
    enableGranularPermissions: true,
    scopes: ['https://www.googleapis.com/auth/drive.appdata'],
  });
  const token = getAuthTokenValue(result);
  if (!token) throw new Error('Googleアカウントの認証を完了できませんでした。');
  return token;
}

async function googleDriveFetch(url, options = {}, { interactive = false, retry = true } = {}) {
  const token = await getGoogleDriveAccessToken(interactive);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && retry) {
    await chrome.identity.removeCachedAuthToken({ token }).catch(() => {});
    return googleDriveFetch(url, options, { interactive, retry: false });
  }
  return response;
}

async function readGoogleDriveError(response, fallback) {
  try {
    const payload = await response.clone().json();
    return payload?.error?.message || fallback;
  } catch (_) {
    return fallback;
  }
}

function sanitizeSyncedFavorite(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lawId = String(raw.lawId || '').trim();
  const lawName = String(raw.lawName || '').trim();
  if (!lawId || !lawName) return null;
  const favorite = {
    lawId: lawId.slice(0, 40),
    lawName: lawName.slice(0, 500),
    lawNum: String(raw.lawNum || '').slice(0, 200),
    lawType: String(raw.lawType || '').slice(0, 80),
    folderId: raw.folderId ? String(raw.folderId).slice(0, 100) : null,
  };
  if (Number.isFinite(raw.lastScrollTop) && raw.lastScrollTop >= 0) {
    favorite.lastScrollTop = Math.round(raw.lastScrollTop);
  }
  if (typeof raw.lastArticleKey === 'string' && raw.lastArticleKey.trim()) {
    favorite.lastArticleKey = raw.lastArticleKey.trim().slice(0, 100);
    favorite.lastArticleOffset = Number.isFinite(raw.lastArticleOffset)
      ? Math.max(0, Math.min(1, raw.lastArticleOffset))
      : 0;
  }
  return favorite;
}

function sanitizeSyncedFolder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim();
  if (!id || !name) return null;
  return { id: id.slice(0, 100), name: name.slice(0, 200) };
}

function sanitizeSyncedArticleBookmark(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lawId = String(raw.lawId || '').trim().slice(0, 40);
  const targetKey = String(raw.targetKey || '').trim().slice(0, 120);
  if (!lawId || !/^(?:Sp(?:_[0-9]+)?::)?[0-9]+(?:-[0-9]+)*(?:\.[0-9]+(?:-[0-9]+)*){0,2}$/.test(targetKey)) {
    return null;
  }
  return {
    id: `${lawId}::${targetKey}`,
    lawId,
    lawName: String(raw.lawName || '').trim().slice(0, 500),
    targetKey,
    articleId: String(raw.articleId || '').slice(0, 500),
    numberLabel: String(raw.numberLabel || '').slice(0, 200),
    createdAt: sanitizeSyncTimestamp(raw.createdAt),
    updatedAt: sanitizeSyncTimestamp(raw.updatedAt),
  };
}

function sanitizeSyncTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(timestamp))
    : 0;
}

function normalizeLegacyMergePayload(raw) {
  if (!raw?.entries || typeof raw.entries !== 'object') return null;
  const activeFolders = Object.values(raw.entries.folders || {})
    .filter((record) => record?.v && typeof record.v === 'object')
    .sort((left, right) => (Number(left.o) || 0) - (Number(right.o) || 0))
    .map((record) => record.v);
  const activeFavorites = Object.values(raw.entries.favorites || {})
    .filter((record) => record?.v && typeof record.v === 'object')
    .sort((left, right) => (Number(left.o) || 0) - (Number(right.o) || 0))
    .map((record) => record.v);
  const folderCollapsed = {};
  Object.entries(raw.entries.collapsed || {}).forEach(([key, record]) => {
    if (typeof record?.v === 'boolean') folderCollapsed[key] = record.v;
  });
  return {
    ...raw,
    favorites: activeFavorites,
    favFolders: activeFolders,
    folderCollapsed,
  };
}

function normalizeGoogleDriveFavoritesPayload(raw) {
  if (!raw || typeof raw !== 'object' || raw.type !== GOOGLE_DRIVE_FAVORITES_TYPE) return null;
  const source = raw.version === 2 ? normalizeLegacyMergePayload(raw) : raw;
  if (!source || ![1, 2, 3, GOOGLE_DRIVE_FAVORITES_VERSION].includes(raw.version)) return null;

  const folders = [];
  const folderIds = new Set();
  for (const item of Array.isArray(source.favFolders) ? source.favFolders : []) {
    const folder = sanitizeSyncedFolder(item);
    if (!folder || folderIds.has(folder.id) || folders.length >= 100) continue;
    folderIds.add(folder.id);
    folders.push(folder);
  }
  const favorites = [];
  const lawIds = new Set();
  for (const item of Array.isArray(source.favorites) ? source.favorites : []) {
    const favorite = sanitizeSyncedFavorite(item);
    if (!favorite || lawIds.has(favorite.lawId) || favorites.length >= 50) continue;
    lawIds.add(favorite.lawId);
    if (favorite.folderId && !folderIds.has(favorite.folderId)) favorite.folderId = null;
    favorites.push(favorite);
  }
  const folderCollapsed = {};
  if (source.folderCollapsed && typeof source.folderCollapsed === 'object' && !Array.isArray(source.folderCollapsed)) {
    Object.entries(source.folderCollapsed).forEach(([key, value]) => {
      if ((key === '__uncat__' || folderIds.has(key)) && typeof value === 'boolean') {
        folderCollapsed[key] = value;
      }
    });
  }
  const articleBookmarks = [];
  const bookmarkIds = new Set();
  for (const item of Array.isArray(source.articleBookmarks) ? source.articleBookmarks : []) {
    const bookmark = sanitizeSyncedArticleBookmark(item);
    if (!bookmark || bookmarkIds.has(bookmark.id) || articleBookmarks.length >= 10000) continue;
    bookmarkIds.add(bookmark.id);
    articleBookmarks.push(bookmark);
  }
  return {
    type: GOOGLE_DRIVE_FAVORITES_TYPE,
    version: GOOGLE_DRIVE_FAVORITES_VERSION,
    updatedAt: sanitizeSyncTimestamp(source.updatedAt),
    deviceId: String(source.deviceId || '').slice(0, 100),
    favorites,
    favFolders: folders,
    folderCollapsed,
    articleBookmarks,
  };
}

async function getGoogleDriveDeviceId() {
  const stored = await chrome.storage.local.get([GOOGLE_DRIVE_SYNC_KEYS.deviceId]);
  let deviceId = String(stored[GOOGLE_DRIVE_SYNC_KEYS.deviceId] || '');
  if (!deviceId) {
    deviceId = crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    await chrome.storage.local.set({ [GOOGLE_DRIVE_SYNC_KEYS.deviceId]: deviceId });
  }
  return deviceId;
}

async function buildLocalGoogleDriveFavoritesPayload(updatedAt = 0) {
  const deviceId = await getGoogleDriveDeviceId();
  const stored = await chrome.storage.local.get(GOOGLE_DRIVE_FAVORITE_STORAGE_KEYS);
  return normalizeGoogleDriveFavoritesPayload({
    type: GOOGLE_DRIVE_FAVORITES_TYPE,
    version: GOOGLE_DRIVE_FAVORITES_VERSION,
    updatedAt,
    deviceId,
    favorites: Array.isArray(stored.favorites) ? stored.favorites : [],
    favFolders: Array.isArray(stored.favFolders) ? stored.favFolders : [],
    folderCollapsed: stored.folderCollapsed && typeof stored.folderCollapsed === 'object'
      ? stored.folderCollapsed
      : {},
    articleBookmarks: Array.isArray(stored.articleBookmarks) ? stored.articleBookmarks : [],
  });
}

function isEmptyGoogleDriveFavoritesPayload(payload) {
  return payload.favorites.length === 0 && payload.favFolders.length === 0 &&
    Object.keys(payload.folderCollapsed).length === 0 && payload.articleBookmarks.length === 0;
}

function isGoogleDriveHighlightLawId(value) {
  return /^[0-9A-Z]{12,20}$/.test(String(value || ''));
}

function sanitizeGoogleDriveHighlightRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').slice(0, 80);
  const color = String(raw.c || '');
  const anchor = String(raw.a || '').slice(0, 500);
  const start = Number(raw.s);
  const end = Number(raw.e);
  const length = Number(raw.l);
  const portableStart = Number(raw.x);
  const portableEnd = Number(raw.y);
  if (!id || !['yellow', 'pink', 'green'].includes(color) || !anchor ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(length) ||
      start < 0 || end <= start || length <= 0 || raw.f !== 2 || !raw.u || !raw.v ||
      !Number.isSafeInteger(portableStart) || !Number.isSafeInteger(portableEnd) ||
      portableStart < 0 || portableEnd <= 0) return null;
  return {
    id,
    c: color,
    a: anchor,
    h: String(raw.h || '').slice(0, 120),
    k: String(raw.k || '').slice(0, 100),
    s: start,
    e: end,
    l: length,
    q: String(raw.q || '').slice(0, 256),
    z: String(raw.z || '').slice(-128),
    p: String(raw.p || '').slice(-32),
    n: String(raw.n || '').slice(0, 32),
    m: String(raw.m || '').slice(0, 2000),
    t: sanitizeSyncTimestamp(raw.t),
    u: String(raw.u).slice(0, 120),
    v: String(raw.v).slice(0, 120),
    x: portableStart,
    y: portableEnd,
    f: 2,
    w: String(raw.w || '').slice(0, 32),
  };
}

function createGoogleDriveHighlightsPayload(deviceId = '') {
  return {
    type: GOOGLE_DRIVE_HIGHLIGHTS_TYPE,
    version: GOOGLE_DRIVE_HIGHLIGHTS_VERSION,
    updatedAt: 0,
    deviceId: String(deviceId || '').slice(0, 100),
    records: Object.create(null),
  };
}

function normalizeGoogleDriveHighlightsPayload(raw) {
  if (!raw || raw.type !== GOOGLE_DRIVE_HIGHLIGHTS_TYPE ||
      raw.version !== GOOGLE_DRIVE_HIGHLIGHTS_VERSION || !raw.records ||
      typeof raw.records !== 'object' || Array.isArray(raw.records)) return null;
  const payload = createGoogleDriveHighlightsPayload(raw.deviceId);
  let totalRecords = 0;
  for (const [lawId, rawRecords] of Object.entries(raw.records).slice(0, 1000)) {
    if (!isGoogleDriveHighlightLawId(lawId) || !rawRecords ||
        typeof rawRecords !== 'object' || Array.isArray(rawRecords)) continue;
    const records = Object.create(null);
    const candidates = Object.entries(rawRecords)
      .sort((left, right) => sanitizeSyncTimestamp(right[1]?.t) - sanitizeSyncTimestamp(left[1]?.t))
      .slice(0, 10000);
    for (const [recordId, rawState] of candidates) {
      if (totalRecords >= 10000) break;
      if (!recordId || recordId.length > 80 || !rawState || typeof rawState !== 'object') continue;
      const timestamp = sanitizeSyncTimestamp(rawState.t);
      const deviceId = String(rawState.d || '').slice(0, 100);
      if (!timestamp || !deviceId) continue;
      const value = rawState.v === null ? null : sanitizeGoogleDriveHighlightRecord(rawState.v);
      if (rawState.v !== null && (!value || value.id !== recordId)) continue;
      records[recordId] = { v: value, t: timestamp, d: deviceId };
      payload.updatedAt = Math.max(payload.updatedAt, timestamp);
      totalRecords += 1;
    }
    if (Object.keys(records).length) payload.records[lawId] = records;
  }
  payload.updatedAt = Math.max(payload.updatedAt, sanitizeSyncTimestamp(raw.updatedAt));
  return payload;
}

function isGoogleDriveRecordStateNewer(candidate, current) {
  if (!current) return true;
  if (candidate.t !== current.t) return candidate.t > current.t;
  if (candidate.d !== current.d) return candidate.d > current.d;
  return JSON.stringify(candidate) > JSON.stringify(current);
}

function getGoogleDriveHighlightRecordFingerprint(record) {
  const content = JSON.stringify(record);
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

function normalizeLocalGoogleDriveHighlightMetadata(raw) {
  const metadata = { version: 1, updatedAt: 0, records: Object.create(null) };
  const sourceRecords = raw?.type === GOOGLE_DRIVE_HIGHLIGHTS_TYPE ? raw.records : raw?.records;
  if (!sourceRecords || typeof sourceRecords !== 'object' || Array.isArray(sourceRecords)) return metadata;
  Object.entries(sourceRecords).slice(0, 1000).forEach(([lawId, rawRecords]) => {
    if (!isGoogleDriveHighlightLawId(lawId) || !rawRecords || typeof rawRecords !== 'object') return;
    const records = Object.create(null);
    Object.entries(rawRecords).slice(0, 10000).forEach(([recordId, rawState]) => {
      const timestamp = sanitizeSyncTimestamp(rawState?.t);
      const deviceId = String(rawState?.d || '').slice(0, 100);
      if (!recordId || recordId.length > 80 || !timestamp || !deviceId) return;
      const deleted = rawState.v === null || rawState.deleted === true;
      const fingerprint = deleted ? '' : String(
        rawState.h || (rawState.v ? getGoogleDriveHighlightRecordFingerprint(rawState.v) : ''),
      ).slice(0, 40);
      if (!deleted && !fingerprint) return;
      records[recordId] = { t: timestamp, d: deviceId, h: fingerprint, deleted };
      metadata.updatedAt = Math.max(metadata.updatedAt, timestamp);
    });
    if (Object.keys(records).length) metadata.records[lawId] = records;
  });
  metadata.updatedAt = Math.max(metadata.updatedAt, sanitizeSyncTimestamp(raw?.updatedAt));
  return metadata;
}

async function buildLocalGoogleDriveHighlightsPayload() {
  const deviceId = await getGoogleDriveDeviceId();
  const stored = await chrome.storage.local.get(null);
  const metadata = normalizeLocalGoogleDriveHighlightMetadata(stored[GOOGLE_DRIVE_SYNC_KEYS.highlightRecords]);
  const payload = createGoogleDriveHighlightsPayload(deviceId);
  const timestamp = Math.min(Number.MAX_SAFE_INTEGER, Math.max(Date.now(), metadata.updatedAt + 1));
  const present = new Map();
  Object.entries(stored).forEach(([key, value]) => {
    if (!key.startsWith(TEXT_HIGHLIGHTS_STORAGE_PREFIX) || !Array.isArray(value)) return;
    const lawId = key.slice(TEXT_HIGHLIGHTS_STORAGE_PREFIX.length);
    if (!isGoogleDriveHighlightLawId(lawId)) return;
    const records = new Map();
    value.slice(0, 10000).forEach((rawRecord) => {
      const record = sanitizeGoogleDriveHighlightRecord(rawRecord);
      if (record && !records.has(record.id)) records.set(record.id, record);
    });
    present.set(lawId, records);
  });

  const lawIds = new Set([...Object.keys(metadata.records), ...present.keys()]);
  lawIds.forEach((lawId) => {
    const metadataRecords = metadata.records[lawId] || Object.create(null);
    const stateRecords = Object.create(null);
    const localRecords = present.get(lawId) || new Map();
    localRecords.forEach((record, recordId) => {
      const fingerprint = getGoogleDriveHighlightRecordFingerprint(record);
      const current = metadataRecords[recordId];
      if (!current || current.deleted || current.h !== fingerprint) {
        stateRecords[recordId] = { v: record, t: timestamp, d: deviceId };
      } else {
        stateRecords[recordId] = { v: record, t: current.t, d: current.d };
      }
    });
    Object.entries(metadataRecords).forEach(([recordId, current]) => {
      if (!localRecords.has(recordId)) {
        if (current.deleted) stateRecords[recordId] = { v: null, t: current.t, d: current.d };
        else {
          stateRecords[recordId] = { v: null, t: timestamp, d: deviceId };
        }
      }
    });
    if (Object.keys(stateRecords).length) payload.records[lawId] = stateRecords;
  });
  Object.values(payload.records).forEach((records) => {
    Object.values(records).forEach((state) => { payload.updatedAt = Math.max(payload.updatedAt, state.t); });
  });
  return payload;
}

function mergeGoogleDriveHighlightsPayloads(local, remote) {
  const merged = createGoogleDriveHighlightsPayload(local.deviceId);
  const lawIds = new Set([...Object.keys(remote?.records || {}), ...Object.keys(local.records)]);
  lawIds.forEach((lawId) => {
    const records = Object.create(null);
    for (const source of [remote?.records?.[lawId], local.records[lawId]]) {
      Object.entries(source || {}).forEach(([recordId, state]) => {
        if (isGoogleDriveRecordStateNewer(state, records[recordId])) records[recordId] = state;
      });
    }
    if (Object.keys(records).length) merged.records[lawId] = records;
  });
  merged.updatedAt = Math.max(local.updatedAt, remote?.updatedAt || 0);
  return merged;
}

function areGoogleDriveHighlightsEquivalent(left, right) {
  const leftLaws = left?.records || {};
  const rightLaws = right?.records || {};
  const lawIds = new Set([...Object.keys(leftLaws), ...Object.keys(rightLaws)]);
  for (const lawId of lawIds) {
    const leftRecords = leftLaws[lawId] || {};
    const rightRecords = rightLaws[lawId] || {};
    const recordIds = new Set([...Object.keys(leftRecords), ...Object.keys(rightRecords)]);
    for (const recordId of recordIds) {
      if (JSON.stringify(leftRecords[recordId]) !== JSON.stringify(rightRecords[recordId])) return false;
    }
  }
  return true;
}

function materializeGoogleDriveHighlights(payload) {
  const laws = Object.create(null);
  Object.entries(payload.records).forEach(([lawId, records]) => {
    const active = Object.values(records)
      .filter((state) => state.v !== null)
      .map((state) => state.v)
      .sort((left, right) => (right.t || 0) - (left.t || 0));
    if (active.length) laws[lawId] = active;
  });
  return laws;
}

async function applyGoogleDriveHighlightsPayload(payload) {
  const laws = materializeGoogleDriveHighlights(payload);
  const stored = await chrome.storage.local.get(null);
  const currentKeys = Object.keys(stored).filter((key) => key.startsWith(TEXT_HIGHLIGHTS_STORAGE_PREFIX));
  const metadata = { version: 1, updatedAt: payload.updatedAt, records: Object.create(null) };
  Object.entries(payload.records).forEach(([lawId, records]) => {
    const lawMetadata = Object.create(null);
    Object.entries(records).forEach(([recordId, state]) => {
      lawMetadata[recordId] = {
        t: state.t,
        d: state.d,
        h: state.v === null ? '' : getGoogleDriveHighlightRecordFingerprint(state.v),
        deleted: state.v === null,
      };
    });
    if (Object.keys(lawMetadata).length) metadata.records[lawId] = lawMetadata;
  });
  const updates = { [GOOGLE_DRIVE_SYNC_KEYS.highlightRecords]: metadata };
  Object.entries(laws).forEach(([lawId, records]) => {
    const key = `${TEXT_HIGHLIGHTS_STORAGE_PREFIX}${lawId}`;
    if (JSON.stringify(stored[key]) !== JSON.stringify(records)) updates[key] = records;
  });
  const activeKeys = new Set(Object.keys(laws).map((lawId) => `${TEXT_HIGHLIGHTS_STORAGE_PREFIX}${lawId}`));
  const removals = currentKeys.filter((key) => !activeKeys.has(key));
  applyingGoogleDriveHighlights = true;
  try {
    await chrome.storage.local.set(updates);
    if (removals.length) await chrome.storage.local.remove(removals);
  } finally {
    applyingGoogleDriveHighlights = false;
  }
}

async function findGoogleDriveDataFile(fileName, interactive = false) {
  const query = `name = '${fileName}' and trashed = false`;
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: query,
    orderBy: 'modifiedTime desc',
    pageSize: '10',
    fields: 'files(id,name,modifiedTime,size)',
  });
  const response = await googleDriveFetch(
    `https://www.googleapis.com/drive/v3/files?${params}`,
    {},
    { interactive },
  );
  if (!response.ok) throw new Error(await readGoogleDriveError(response, `Driveの確認に失敗しました（${response.status}）`));
  const payload = await response.json();
  return Array.isArray(payload.files) ? payload.files[0] || null : null;
}

async function readGoogleDriveDataFile(fileId, normalizer, dataLabel, interactive = false) {
  const response = await googleDriveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {},
    { interactive },
  );
  if (!response.ok) throw new Error(await readGoogleDriveError(response, `Driveの読み込みに失敗しました（${response.status}）`));
  const payload = normalizer(await response.json());
  if (!payload) throw new Error(`Google Drive上の${dataLabel}ファイルの形式が不正です。`);
  return payload;
}

async function writeGoogleDriveDataFile(fileId, payload, fileName, interactive = false) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  let response;
  if (fileId) {
    response = await googleDriveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,modifiedTime`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body,
      },
      { interactive },
    );
  } else {
    const boundary = `egov-enhancer-${crypto.randomUUID?.() || Date.now()}`;
    const multipartBody = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify({
        name: fileName,
        mimeType: 'application/json',
        parents: ['appDataFolder'],
      }),
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      body,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    response = await googleDriveFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipartBody,
      },
      { interactive },
    );
  }
  if (!response.ok) throw new Error(await readGoogleDriveError(response, `Driveへの保存に失敗しました（${response.status}）`));
  return response.json();
}

async function applyGoogleDriveFavoritesPayload(payload) {
  applyingGoogleDriveFavorites = true;
  try {
    await chrome.storage.local.set({
      favorites: payload.favorites,
      favFolders: payload.favFolders,
      folderCollapsed: payload.folderCollapsed,
      articleBookmarks: payload.articleBookmarks,
      [GOOGLE_DRIVE_SYNC_KEYS.localUpdatedAt]: payload.updatedAt,
    });
  } finally {
    applyingGoogleDriveFavorites = false;
  }
}

async function updateGoogleDriveSyncStatus({ email, error = '', synced = false } = {}) {
  const updates = { [GOOGLE_DRIVE_SYNC_KEYS.lastError]: String(error || '').slice(0, 1000) };
  if (email !== undefined) updates[GOOGLE_DRIVE_SYNC_KEYS.accountEmail] = String(email || '').slice(0, 320);
  if (synced) updates[GOOGLE_DRIVE_SYNC_KEYS.lastSyncAt] = Date.now();
  await chrome.storage.local.set(updates);
}

async function captureLocalGoogleDriveFavoritesPayload() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const revision = googleDriveFavoriteChangeRevision;
    await googleDriveFavoriteTimestampPromise.catch(() => {});
    const settings = await chrome.storage.local.get([GOOGLE_DRIVE_SYNC_KEYS.localUpdatedAt]);
    const updatedAt = sanitizeSyncTimestamp(settings[GOOGLE_DRIVE_SYNC_KEYS.localUpdatedAt]);
    const payload = await buildLocalGoogleDriveFavoritesPayload(updatedAt);
    if (revision === googleDriveFavoriteChangeRevision) {
      return { payload, updatedAt, revision };
    }
  }
  throw new Error('お気に入りが編集中のため同期を延期しました。');
}

async function syncGoogleDriveFavoritesData({ interactive = false, forceUpload = false } = {}) {
  const file = await findGoogleDriveDataFile(GOOGLE_DRIVE_FAVORITES_FILE_NAME, interactive);
  const remote = file ? await readGoogleDriveDataFile(
    file.id,
    normalizeGoogleDriveFavoritesPayload,
    'お気に入り',
    interactive,
  ) : null;
  // Driveの読み込み中にお気に入りが編集されることがあるため、
  // ローカルの更新時刻と内容は通信完了後にまとめて取得する。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const captured = await captureLocalGoogleDriveFavoritesPayload();
    let localUpdatedAt = captured.updatedAt;
    let local = captured.payload;
    if (!localUpdatedAt && remote && isEmptyGoogleDriveFavoritesPayload(local)) {
      if (captured.revision !== googleDriveFavoriteChangeRevision) continue;
      await applyGoogleDriveFavoritesPayload(remote);
      return { favoriteCount: remote.favorites.length, bookmarkCount: remote.articleBookmarks.length };
    }
    if (!localUpdatedAt || forceUpload) {
      localUpdatedAt = Math.max(Date.now(), (remote?.updatedAt || 0) + 1);
      local = { ...local, updatedAt: localUpdatedAt };
    }
    const localWins = !remote || local.updatedAt > remote.updatedAt ||
      (local.updatedAt === remote.updatedAt && local.deviceId > remote.deviceId);
    if (localWins) {
      await writeGoogleDriveDataFile(file?.id || '', local, GOOGLE_DRIVE_FAVORITES_FILE_NAME, interactive);
      // 同期中にさらに編集された内容を古いスナップショットで巻き戻さない。
      // localUpdatedAtを新規採番した場合だけ、その時刻を保存する。
      if (local.updatedAt !== captured.updatedAt) {
        await chrome.storage.local.set({ [GOOGLE_DRIVE_SYNC_KEYS.localUpdatedAt]: local.updatedAt });
      }
      return { favoriteCount: local.favorites.length, bookmarkCount: local.articleBookmarks.length };
    }
    if (captured.revision !== googleDriveFavoriteChangeRevision) continue;
    await applyGoogleDriveFavoritesPayload(remote);
    return { favoriteCount: remote.favorites.length, bookmarkCount: remote.articleBookmarks.length };
  }
  throw new Error('お気に入りが編集中のため同期を延期しました。');
}

async function syncGoogleDriveHighlightsData({ interactive = false } = {}) {
  const file = await findGoogleDriveDataFile(GOOGLE_DRIVE_HIGHLIGHTS_FILE_NAME, interactive);
  const remote = file ? await readGoogleDriveDataFile(
    file.id,
    normalizeGoogleDriveHighlightsPayload,
    'ハイライト／メモ',
    interactive,
  ) : null;
  // Driveの読み込み中やローカル状態の取得中に編集された内容を、
  // 古いスナップショットで巻き戻さないよう安定した状態を取得してから反映する。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const revision = googleDriveHighlightChangeRevision;
    const local = await buildLocalGoogleDriveHighlightsPayload();
    if (revision !== googleDriveHighlightChangeRevision) continue;
    const merged = mergeGoogleDriveHighlightsPayloads(local, remote);
    if (revision !== googleDriveHighlightChangeRevision) continue;
    await applyGoogleDriveHighlightsPayload(merged);
    if (!remote || !areGoogleDriveHighlightsEquivalent(merged, remote)) {
      await writeGoogleDriveDataFile(file?.id || '', merged, GOOGLE_DRIVE_HIGHLIGHTS_FILE_NAME, interactive);
    }
    const laws = materializeGoogleDriveHighlights(merged);
    return {
      highlightCount: Object.values(laws).reduce((count, records) => count + records.length, 0),
      memoCount: Object.values(laws).reduce(
        (count, records) => count + records.filter((record) => record.m).length,
        0,
      ),
    };
  }
  throw new Error('ハイライト／メモが編集中のため同期を延期しました。');
}

async function syncGoogleDriveFavorites({ interactive = false, forceUpload = false } = {}) {
  if (googleDriveSyncPromise) return googleDriveSyncPromise;
  googleDriveSyncPromise = (async () => {
    const settings = await chrome.storage.local.get([
      GOOGLE_DRIVE_SYNC_KEYS.enabled,
      GOOGLE_DRIVE_SYNC_KEYS.syncFavorites,
      GOOGLE_DRIVE_SYNC_KEYS.syncHighlights,
    ]);
    if (settings[GOOGLE_DRIVE_SYNC_KEYS.enabled] !== true) return { skipped: true };
    if (interactive) await getGoogleDriveAccessToken(true);
    const profile = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }).catch(() => ({}));
    const syncFavorites = settings[GOOGLE_DRIVE_SYNC_KEYS.syncFavorites] !== false;
    const syncHighlights = settings[GOOGLE_DRIVE_SYNC_KEYS.syncHighlights] !== false;
    const favoritesResult = syncFavorites
      ? await syncGoogleDriveFavoritesData({ interactive, forceUpload })
      : { favoriteCount: 0, bookmarkCount: 0 };
    const highlightsResult = syncHighlights
      ? await syncGoogleDriveHighlightsData({ interactive })
      : { highlightCount: 0, memoCount: 0 };

    await updateGoogleDriveSyncStatus({ email: profile?.email || '', synced: true });
    return {
      ok: true,
      accountEmail: profile?.email || '',
      ...favoritesResult,
      ...highlightsResult,
    };
  })().catch(async (error) => {
    await updateGoogleDriveSyncStatus({ error: error?.message || String(error || '') }).catch(() => {});
    throw error;
  }).finally(() => {
    googleDriveSyncPromise = null;
  });
  return googleDriveSyncPromise;
}

function scheduleGoogleDriveFavoritesSync(delayMs = 15000) {
  chrome.alarms.create(GOOGLE_DRIVE_SYNC_ALARM, { when: Date.now() + Math.max(1000, delayMs) });
}

function ensureGoogleDrivePeriodicSync() {
  chrome.alarms.create(GOOGLE_DRIVE_PERIODIC_ALARM, { periodInMinutes: 5 });
}

async function enableGoogleDriveFavoritesSync() {
  const stored = await chrome.storage.local.get([
    GOOGLE_DRIVE_SYNC_KEYS.syncFavorites,
    GOOGLE_DRIVE_SYNC_KEYS.syncHighlights,
  ]);
  const updates = {
    [GOOGLE_DRIVE_SYNC_KEYS.enabled]: true,
    [GOOGLE_DRIVE_SYNC_KEYS.lastError]: '',
  };
  if (typeof stored[GOOGLE_DRIVE_SYNC_KEYS.syncFavorites] !== 'boolean') {
    updates[GOOGLE_DRIVE_SYNC_KEYS.syncFavorites] = true;
  }
  if (typeof stored[GOOGLE_DRIVE_SYNC_KEYS.syncHighlights] !== 'boolean') {
    updates[GOOGLE_DRIVE_SYNC_KEYS.syncHighlights] = true;
  }
  await chrome.storage.local.set(updates);
  try {
    const result = await syncGoogleDriveFavorites({ interactive: true });
    ensureGoogleDrivePeriodicSync();
    return result;
  } catch (error) {
    await chrome.storage.local.set({ [GOOGLE_DRIVE_SYNC_KEYS.enabled]: false });
    chrome.alarms.clear(GOOGLE_DRIVE_SYNC_ALARM);
    chrome.alarms.clear(GOOGLE_DRIVE_PERIODIC_ALARM);
    throw error;
  }
}

async function disableGoogleDriveFavoritesSync() {
  await chrome.storage.local.set({
    [GOOGLE_DRIVE_SYNC_KEYS.enabled]: false,
    [GOOGLE_DRIVE_SYNC_KEYS.accountEmail]: '',
    [GOOGLE_DRIVE_SYNC_KEYS.lastError]: '',
  });
  await Promise.all([
    chrome.alarms.clear(GOOGLE_DRIVE_SYNC_ALARM),
    chrome.alarms.clear(GOOGLE_DRIVE_PERIODIC_ALARM),
  ]);
  await chrome.identity.clearAllCachedAuthTokens().catch(() => {});
  return { ok: true };
}

function getLiteLawRevisionStorageKey(lawId) {
  return `liteLawCurrentRevision:${lawId}`;
}

async function fetchLiteLawRevisions(lawId) {
  const response = await fetch(`${EGOV_API_V2_BASE}/law_revisions/${encodeURIComponent(lawId)}?response_format=json`);
  if (!response.ok) throw new Error(`Revision fetch failed: HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.revisions) ? data.revisions : [];
}

async function fetchLiteLawXml(target, asOf = '') {
  const response = await fetch(getLiteLawDataUrl(target, asOf), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Law fetch failed: HTTP ${response.status}`);
  const xmlText = await response.text();
  if (!xmlText.trim()) throw new Error('Law fetch returned an empty response');
  return xmlText;
}

async function loadAndCacheLiteLaw(lawId, revisionId = '') {
  const promiseKey = `${lawId}:${revisionId || 'current'}`;
  if (liteLawLoadPromises.has(promiseKey)) return liteLawLoadPromises.get(promiseKey);

  const loadPromise = (async () => {
    const revisionStorageKey = getLiteLawRevisionStorageKey(lawId);
    const initialTarget = revisionId || lawId;

    // 改正履歴と本文を同時に開始し、従来の直列待ちをなくす。
    const revisionsPromise = fetchLiteLawRevisions(lawId).catch(() => []);
    // 法令IDだけの取得は未施行版になり得るため、改正ID未指定時は今日時点を明示する。
    const initialXmlPromise = fetchLiteLawXml(initialTarget, revisionId ? '' : getJapanDateString())
      .then((xmlText) => ({ xmlText, error: null }))
      .catch((error) => ({ xmlText: '', error }));
    const [revisions, initialResult] = await Promise.all([revisionsPromise, initialXmlPromise]);
    const currentRevisionId = findCurrentLawRevisionId(revisions);
    const resolvedTarget = revisionId || currentRevisionId || initialTarget;

    let xmlText = initialResult.xmlText;
    // 法令IDの取得結果は未施行版を含むことがあるため、現行改正IDが判明したら必ずそのIDで取得し直す。
    if (resolvedTarget !== initialTarget) {
      xmlText = await fetchLiteLawXml(resolvedTarget);
    } else if (!xmlText) {
      throw initialResult.error || new Error('Law XML could not be loaded');
    }

    const cacheTarget = resolvedTarget || initialTarget;
    await cacheLiteLawXml(cacheTarget, xmlText);
    if (!revisionId && currentRevisionId) {
      await chrome.storage.local.set({ [revisionStorageKey]: currentRevisionId }).catch(() => {});
    }
    return { cacheTarget, currentRevisionId, revisions };
  })().finally(() => {
    liteLawLoadPromises.delete(promiseKey);
  });

  liteLawLoadPromises.set(promiseKey, loadPromise);
  return loadPromise;
}

async function clearReferencesCache() {
  const db = await openReferencesDb();
  try {
    const tx = db.transaction(REFERENCES_BUNDLED_CACHE_STORE, 'readwrite');
    await idbRequest(tx.objectStore(REFERENCES_BUNDLED_CACHE_STORE).clear());
  } finally {
    db.close();
  }
}

async function getImportedLawReferences(lawId) {
  if (!lawId) return {};
  try {
    const cached = await readCachedLawReferences(lawId);
    if (cached) return cached.references;
  } catch (error) {
    console.warn('[e-Gov Enhancer] 参照キャッシュの読み込みに失敗しました', error);
  }

  bundledReferencesReaderCount += 1;
  try {
    const referencesData = await getBundledReferencesData();
    const references = isPlainObject(referencesData?.[lawId]) ? referencesData[lawId] : {};
    // 要求された法令は参照ゼロ（空オブジェクト）でも保存し、次回以降の再パースを防ぐ
    try {
      await saveBundledCacheRecord(lawId, references);
    } catch (error) {
      console.warn('[e-Gov Enhancer] 参照キャッシュの保存に失敗しました', error);
    }
    return references;
  } finally {
    bundledReferencesReaderCount -= 1;
    if (bundledReferencesReaderCount === 0) bundledReferencesParsePromise = null;
  }
}

async function saveBundledCacheRecord(lawId, references) {
  const db = await openReferencesDb();
  try {
    const tx = db.transaction(REFERENCES_BUNDLED_CACHE_STORE, 'readwrite');
    tx.objectStore(REFERENCES_BUNDLED_CACHE_STORE).put({
      lawId,
      references: isPlainObject(references) ? references : {},
    });
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

async function readCachedLawReferences(lawId) {
  const db = await openReferencesDb();
  try {
    const metaTx = db.transaction(REFERENCES_META_STORE, 'readonly');
    const meta = await idbRequest(metaTx.objectStore(REFERENCES_META_STORE).get(REFERENCES_CURRENT_META_KEY));
    if (meta) {
      const lawTx = db.transaction(REFERENCES_LAWS_STORE, 'readonly');
      const record = await idbRequest(lawTx.objectStore(REFERENCES_LAWS_STORE).get(lawId));
      return { references: isPlainObject(record?.references) ? record.references : {} };
    }

    const bundledTx = db.transaction(REFERENCES_BUNDLED_CACHE_STORE, 'readonly');
    const record = await idbRequest(bundledTx.objectStore(REFERENCES_BUNDLED_CACHE_STORE).get(lawId));
    return record ? { references: isPlainObject(record.references) ? record.references : {} } : null;
  } finally {
    db.close();
  }
}

function getBundledReferencesData() {
  if (!bundledReferencesParsePromise) {
    bundledReferencesParsePromise = (async () => {
      const response = await fetch(chrome.runtime.getURL('data/references.json'));
      if (!response.ok) throw new Error(`References fetch failed: HTTP ${response.status}`);
      return response.json();
    })();
  }
  return bundledReferencesParsePromise;
}

async function openActionPopup(mode = '') {
  await chrome.storage.session.set({ requestedPopupMode: mode || '' }).catch(() => {});

  if (typeof chrome.action?.openPopup !== 'function') {
    await chrome.storage.session.remove('requestedPopupMode').catch(() => {});
    return false;
  }

  try {
    await chrome.action.openPopup();
    return true;
  } catch (_) {
    await chrome.storage.session.remove('requestedPopupMode').catch(() => {});
    return false;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const favoritesChanged = !applyingGoogleDriveFavorites &&
    GOOGLE_DRIVE_FAVORITE_STORAGE_KEYS.some((key) => changes[key]);
  const highlightsChanged = !applyingGoogleDriveHighlights &&
    Object.keys(changes).some((key) => key.startsWith(TEXT_HIGHLIGHTS_STORAGE_PREFIX));
  if (!favoritesChanged && !highlightsChanged) return;

  if (favoritesChanged) {
    googleDriveFavoriteChangeRevision += 1;
    googleDriveFavoriteTimestampPromise = googleDriveFavoriteTimestampPromise.then(async () => {
      const stored = await chrome.storage.local.get([GOOGLE_DRIVE_SYNC_KEYS.localUpdatedAt]);
      const updatedAt = Math.max(
        Date.now(),
        sanitizeSyncTimestamp(stored[GOOGLE_DRIVE_SYNC_KEYS.localUpdatedAt]) + 1,
      );
      await chrome.storage.local.set({ [GOOGLE_DRIVE_SYNC_KEYS.localUpdatedAt]: updatedAt });
    }).catch(() => {});
  }
  if (highlightsChanged) googleDriveHighlightChangeRevision += 1;

  chrome.storage.local.get([
    GOOGLE_DRIVE_SYNC_KEYS.enabled,
    GOOGLE_DRIVE_SYNC_KEYS.syncFavorites,
    GOOGLE_DRIVE_SYNC_KEYS.syncHighlights,
  ]).then((stored) => {
    if (stored[GOOGLE_DRIVE_SYNC_KEYS.enabled] !== true) return;
    const shouldSchedule = (favoritesChanged && stored[GOOGLE_DRIVE_SYNC_KEYS.syncFavorites] !== false) ||
      (highlightsChanged && stored[GOOGLE_DRIVE_SYNC_KEYS.syncHighlights] !== false);
    if (shouldSchedule) scheduleGoogleDriveFavoritesSync();
  }).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== GOOGLE_DRIVE_SYNC_ALARM && alarm.name !== GOOGLE_DRIVE_PERIODIC_ALARM) return;
  syncGoogleDriveFavorites().catch(() => {});
});

async function restoreGoogleDriveSyncSchedule() {
  const stored = await chrome.storage.local.get([GOOGLE_DRIVE_SYNC_KEYS.enabled]);
  const enabled = stored[GOOGLE_DRIVE_SYNC_KEYS.enabled] === true;
  if (enabled) ensureGoogleDrivePeriodicSync();
  return enabled;
}

chrome.runtime.onStartup?.addListener(() => {
  restoreGoogleDriveSyncSchedule().then((enabled) => {
    if (enabled) scheduleGoogleDriveFavoritesSync(3000);
  }).catch(() => {});
});

chrome.runtime.onInstalled?.addListener(() => {
  restoreGoogleDriveSyncSchedule().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'egov-google-drive-favorites-enable') {
    enableGoogleDriveFavoritesSync()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error || '') }));
    return true;
  }
  if (message?.type === 'egov-google-drive-favorites-disable') {
    disableGoogleDriveFavoritesSync()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error || '') }));
    return true;
  }
  if (message?.type === 'egov-google-drive-favorites-sync-now') {
    syncGoogleDriveFavorites({ forceUpload: message.forceUpload === true })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error || '') }));
    return true;
  }
  if (message?.type === 'egov-open-options-page') {
    chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'egov-open-manual-page') {
    openManualPage().then((tab) => sendResponse({ ok: true, tabId: tab?.id })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'egov-get-imported-law-references') {
    getImportedLawReferences(message.lawId)
      .then((lawReferences) => sendResponse({ ok: true, lawReferences }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error || '') }));
    return true;
  }
  if ((message?.type === 'egov-prefetch-lite-law' || message?.type === 'egov-load-lite-law') && message.lawId) {
    loadAndCacheLiteLaw(message.lawId, message.revisionId || '')
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error || '') }));
    return true;
  }
  if (message?.type === 'egov-open-law-reference-tab' && message.url) {
    chrome.tabs.create({ url: message.url, active: true })
      .then((tab) => sendResponse({ ok: true, tabId: tab?.id }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return undefined;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open_favorites_popup') {
    openActionPopup('favorites').catch(() => {});
    return;
  }
  if (command === 'open_history_popup') {
    openActionPopup('law').catch(() => {});
    return;
  }
});
