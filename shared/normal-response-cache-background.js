// Normal e-Gov pages keep their own renderer. Only public read responses are cached.
(() => {
  const ORIGIN = 'https://laws.e-gov.go.jp';
  const CACHE = 'egov-normal-responses-v1';
  const { NORMAL_RESPONSE_CACHE_LIMITS, normalizeNormalResponseCacheCapacity,
    NORMAL_RESPONSE_CACHE_FREQUENCY_KEY, normalizeNormalResponseCacheFrequency,
    withLawCache: withCache, trimLawCaches, putLawCacheEntry, deleteLawCacheEntry,
    touchLawCacheEntry } = globalThis.EgovShared;
  const MAX_ITEM = 8 * 1024 * 1024;
  async function capacityBytes() {
    const key = NORMAL_RESPONSE_CACHE_LIMITS.storageKey;
    const settings = await chrome.storage.local.get(key);
    return normalizeNormalResponseCacheCapacity(settings[key]) * 1024 * 1024;
  }
  const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
  const japanDay = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

  function validate(message, sender) {
    if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return null;
    const page = new URL(sender.url);
    const lawId = page.pathname.match(/^\/law\/([0-9A-Z]{15})(?:\/|$)/)?.[1];
    if (page.origin !== ORIGIN || !lawId) return null;
    if (!['get', 'put'].includes(message.action) || typeof message.page !== 'string'
        || message.page.length > 100 || typeof message.build !== 'string' || message.build.length > 2000) return null;
    const request = message.request;
    if (!request || typeof request.body !== 'string' || request.body.length > 256000
        || !Array.isArray(request.headers) || JSON.stringify(request.headers).length > 4000
        || request.headers.some(pair => !Array.isArray(pair) || pair.length !== 2
          || !['accept', 'content-type', 'content-encoding', 'x-requested-with'].includes(pair[0]) || typeof pair[1] !== 'string')) return null;
    const url = new URL(request.url);
    if (url.origin !== ORIGIN || url.search || url.hash || url.username || url.password) return null;
    if (request.method === 'POST' && /^\/internal-api\/SelectLaw(?:Revision|Toc|Text)?Data\.json$/.test(url.pathname)) {
      const body = JSON.parse(request.body);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      if (body.law_id !== undefined && body.law_id !== lawId) return null;
      if (url.pathname.endsWith('/SelectLawRevisionData.json') && body.law_id !== lawId) return null;
    } else if (!(request.method === 'GET' && request.body === ''
        && new RegExp('^/data/[A-Za-z]+/' + lawId + '/[0-9]+_[0-9]+/' + lawId + '_[0-9A-Z_]+_law\\.html$').test(url.pathname))) return null;
    let bodyKey = request.body;
    if (request.method === 'POST') {
      const body = JSON.parse(request.body);
      // The native app puts today's date into current-law text requests. Keep a
      // stable identity across days, while preserving explicitly dated views.
      if (page.pathname.replace(/\/$/, '') === `/law/${lawId}` && !page.searchParams.has('occasion_date')
          && body.occasion === japanDay().replaceAll('-', '/')) {
        body.occasion = '@current';
        bodyKey = JSON.stringify(body);
      }
    }
    return { lawId, request, bodyKey };
  }

  const trim = (cache, limit, incomingBytes, replacementKey) =>
    trimLawCaches(cache, CACHE, limit, incomingBytes, replacementKey);

  async function handle(message, sender) {
    const valid = validate(message, sender);
    if (!valid) return null;
    const settings = await chrome.storage.local.get(NORMAL_RESPONSE_CACHE_FREQUENCY_KEY);
    const frequency = normalizeNormalResponseCacheFrequency(settings[NORMAL_RESPONSE_CACHE_FREQUENCY_KEY]);
    if (message.action === 'get' && (message.force === true || frequency === 'always')) return { bypass: true };
    const identity = JSON.stringify(['scheduled-v2', chrome.runtime.getManifest().version, message.build,
      valid.lawId, valid.request.method, valid.request.url, valid.bodyKey, valid.request.headers]);
    // Cache Storage accepts HTTP(S) keys only; this synthetic URL is never fetched.
    const key = `${ORIGIN}/__enhancer_normal_cache__/${await digest(identity)}`;
    const cache = await caches.open(CACHE);
    if (message.action === 'get') {
      return withCache(async () => {
        const response = await cache.match(key);
        if (!response) return null;
        const saved = Number(response.headers.get('x-saved'));
        if (!saved || !Number.isFinite(saved) || saved > Date.now()) return null;
        const days = { daily: 1, weekly: 7, monthly: 30 }[frequency];
        if (days && Date.now() - saved >= days * 86400000) return { bypass: true };
        const text = await response.text();
        if (!text || text.length > MAX_ITEM || await digest(text) !== response.headers.get('x-sha256')) {
          await deleteLawCacheEntry(cache, CACHE, key);
          return null;
        }
        await touchLawCacheEntry(cache, CACHE, key, response, text);
        return { text, contentType: response.headers.get('content-type'), downloadedAt: saved };
      });
    }
    const value = message.value;
    if (!value || typeof value.text !== 'string' || !value.text || value.text.length > MAX_ITEM
        || typeof value.contentType !== 'string') return null;
    const isJson = valid.request.method === 'POST';
    if (isJson) {
      if (!/^application\/json(?:;|$)/i.test(value.contentType)) return null;
      const parsed = JSON.parse(value.text);
      if (!parsed?.result?.success) return null;
      // e-Gov also labels its already-decoded law HTML as application/gzip.
    } else if (!/^(?:text\/html|application\/gzip)(?:;|$)/i.test(value.contentType)) return null;
    const bytes = new TextEncoder().encode(value.text).length;
    if (bytes > MAX_ITEM) return null;
    if (frequency === 'always') return null;
    const downloadedAt = Number.isFinite(value.downloadedAt) && value.downloadedAt > 0
      && value.downloadedAt <= Date.now() && Date.now() - value.downloadedAt < 60000 ? value.downloadedAt : Date.now();
    const hash = await digest(value.text);
    const write = async () => {
      const limit = await capacityBytes();
      // Do not reserve space for an uncacheable response; still honor a reduced limit.
      if (bytes > limit) { await trim(cache, limit, 0, ''); return; }
      await trim(cache, limit, bytes, key);
      await putLawCacheEntry(cache, CACHE, key, new Response(value.text, { headers: {
        'content-type': value.contentType, 'x-saved': String(downloadedAt),
        'x-accessed': String(Date.now()), 'x-bytes': String(bytes), 'x-sha256': hash,
      } }));
    };
    await withCache(write);
    return null;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'egov-normal-response-cache') return undefined;
    handle(message, sender).then(sendResponse, () => sendResponse(null));
    return true;
  });
})();
