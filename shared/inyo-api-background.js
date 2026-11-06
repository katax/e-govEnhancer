// Experimental reverse references. Separate storage never enters the law-cache budget.
(() => {
  const ORIGIN = 'https://laws.e-gov.go.jp';
  const CACHE = 'egov-inyo-api-v1';
  const pending = new Map();
  const latest = new Map();
  const invalidations = new Map();
  let writes = Promise.resolve();
  const slotFor = context => `${ORIGIN}/__enhancer_inyo__/${context.mode}/${context.lawId}/${encodeURIComponent(context.view)}`;
  function mutate(task) {
    const next = writes.then(task, task);
    writes = next.catch(() => {});
    return next;
  }
  function invalidate(context) {
    if (!context || !/^[0-9A-Z]{15}$/.test(context.lawId) || !['normal', 'lite'].includes(context.mode)
        || typeof context.view !== 'string' || context.view.length > 2000) return Promise.reject(new Error('法令の識別情報が不正です'));
    const slot = slotFor(context);
    latest.set(slot, Symbol('invalidated'));
    for (const key of pending.keys()) if (key.startsWith(slot + '[')) pending.delete(key);
    const task = mutate(async () => {
      const cache = await caches.open(CACHE);
      await cache.delete(slot);
    });
    invalidations.set(slot, task);
    task.finally(() => {
      if (invalidations.get(slot) === task) invalidations.delete(slot);
    }).catch(() => {});
    return task;
  }
  async function prepare(context, fresh = false) {
    if (fresh) await invalidate(context);
    return (await load(context)).cacheStatus;
  }
  const shared = globalThis.EgovShared;
  const date = value => {
    const match = String(value || '').match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
  };
  async function post(endpoint, body) {
    const response = await fetch(`${ORIGIN}/internal-api/${endpoint}.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`引用元API HTTP ${response.status}`);
    let result;
    try { result = (await response.json()).result; }
    catch (_) { throw new Error('引用元APIから正しいJSONが返りませんでした'); }
    if (result?.success !== true) throw new Error(result?.errorMessage || '引用元APIの取得に失敗しました');
    return result;
  }
  function collectIds(tree) {
    const ids = new Set();
    function walk(value) {
      if (!value || typeof value !== 'object') return;
      if (typeof value['-ObjectId'] === 'string') ids.add(value['-ObjectId'].replace(/^#/, ''));
      Object.values(value).forEach(walk);
    }
    walk(tree);
    return [...ids];
  }
  function sourceProvisionUrl(value, lawId) {
    if (typeof value !== 'string' || !/^[0-9A-Z]{15}$/.test(lawId)) return null;
    try {
      const url = new URL(value, ORIGIN);
      if (url.origin !== ORIGIN || !(url.pathname === `/law/${lawId}` || url.pathname.startsWith(`/law/${lawId}/`))
          || !shared.getReferenceTargetKeyFromEgovUrl(url.href)) return null;
      return url;
    } catch (_) { return null; }
  }
  function filterCachedReferences(references) {
    const filtered = {};
    for (const [key, entry] of Object.entries(references)) {
      const sources = (Array.isArray(entry?.externalLawSources) ? entry.externalLawSources : [])
        .filter(source => sourceProvisionUrl(source?.sourceUrl, source?.sourceLawId));
      if (sources.length) filtered[key] = { externalLawSources: sources };
    }
    return filtered;
  }
  function convert(data, lawId) {
    if (!Array.isArray(data.inyo_data)) throw new Error('引用元APIの応答形式が変わっています');
    const references = {}, seen = new Map();
    for (const entry of data.inyo_data) {
      if (!Array.isArray(entry.inyo_list) || typeof entry.selText !== 'string') throw new Error('引用元の形式が不正です');
      const key = shared.getReferenceTargetKeyFromEgovUrl(`${ORIGIN}/law/${lawId}#${entry.selText}`);
      // Existing reverse-link UI attaches to provisions, not chapter headings.
      if (!key) continue;
      for (const row of entry.inyo_list) {
        // The API also returns law-wide links without a source provision.
        const url = sourceProvisionUrl(row.url, row.law_id);
        if (!url) continue;
        const identity = `${row.law_id}\n${url.href}`;
        if (!seen.has(key)) seen.set(key, new Set());
        if (seen.get(key).has(identity)) continue;
        seen.get(key).add(identity);
        (references[key] ||= { externalLawSources: [] }).externalLawSources.push({
          sourceLawId: row.law_id, sourceLawTitle: row.law_name || row.law_id, sourceUrl: url.href,
        });
      }
    }
    return references;
  }
  async function resolve(context) {
    let params;
    if (/^\d{1,12}_\d{1,6}$/.test(context.normalRevision || '')) {
      const [id, sub] = context.normalRevision.split('_');
      params = { law_data_id: Number(id), subRevision: sub };
    } else {
      const history = await post('SelectLawRevisionData', { law_id: context.lawId });
      const revisions = history.Amendment_History;
      if (!Array.isArray(revisions)) throw new Error('法令の改正履歴を取得できませんでした');
      // Lite's public revision ID encodes enforcement date and amendment law ID.
      const explicit = context.revisionId?.match(/^[0-9A-Z]{15}_(\d{8})_([0-9A-Z]{15})$/);
      const selected = explicit ? revisions.find(row => date(row.EnforcementDate || row.ScheduledEnforcementDate) === date(explicit[1])
        && row.AmendmentId === explicit[2]) : revisions.find(row => row.EnforcementDate && date(row.EnforcementDate) <= context.occasion
          && (!row.EnforcementEndDate || date(row.EnforcementEndDate) >= context.occasion));
      if (!selected) throw new Error('表示中の法令に対応する改正版を特定できませんでした');
      params = { law_data_id: selected.LawDataId, subRevision: String(selected.SubRevision) };
    }
    let ids = context.ids;
    if (!Array.isArray(ids) || !ids.length) {
      const toc = await post('SelectLawTocData', params);
      ids = collectIds(toc.Toc_Data?.TocBody);
    }
    if (!ids.length) throw new Error('引用元を取得する条文IDが見つかりませんでした');
    return convert(await post('SelectInyoLawData', { ...params, occasion: context.occasion, selTextList: ids }), context.lawId);
  }
  async function get(context) {
    return (await load(context)).references;
  }
  async function load(context) {
    if (!context || !/^[0-9A-Z]{15}$/.test(context.lawId) || !['normal', 'lite'].includes(context.mode)
        || !Number.isFinite(context.downloadedAt) || context.downloadedAt <= 0 || context.downloadedAt > Date.now()
        || typeof context.view !== 'string' || context.view.length > 2000
        || (context.ids !== undefined && (!Array.isArray(context.ids) || context.ids.length > 50000
          || context.ids.some(id => typeof id !== 'string' || id.length > 300)))) throw new Error('法令ファイルの読み込み完了後にもう一度試してください');
    context = { ...context, occasion: date(context.occasion) };
    if (!context.occasion) throw new Error('法令の表示時点が不明です');
    const slot = slotFor(context);
    await invalidations.get(slot);
    // A body's acquisition timestamp is its generation. Never extend its TTL
    // from the later time at which the user first opens reverse references.
    const generation = JSON.stringify([context.downloadedAt, context.normalRevision || context.revisionId || '']);
    const pendingKey = slot + generation;
    if (pending.has(pendingKey)) return pending.get(pendingKey);
    const token = {};
    latest.set(slot, token);
    const task = (async () => {
      const settings = await chrome.storage.local.get(shared.NORMAL_RESPONSE_CACHE_FREQUENCY_KEY);
      const frequency = shared.normalizeNormalResponseCacheFrequency(settings[shared.NORMAL_RESPONSE_CACHE_FREQUENCY_KEY]);
      const days = { daily: 1, weekly: 7, monthly: 30 }[frequency];
      const persistent = frequency !== 'always' && (!days || Date.now() - context.downloadedAt < days * 86400000);
      let cache;
      try { cache = await caches.open(CACHE); } catch (_) {}
      if (persistent && cache) {
        try {
          const response = await cache.match(slot);
          if (response?.headers.get('x-law-generation') === generation) {
            const record = await response.json();
            if (shared.isPlainObject(record.references)) return { references: filterCachedReferences(record.references), cacheStatus: 'hit' };
          }
        } catch (_) {}
      }
      const references = await resolve(context);
      let saved = false;
      if (persistent && cache) await mutate(async () => {
        if (latest.get(slot) !== token) return;
        await cache.put(slot, new Response(JSON.stringify({ references }), {
          headers: { 'content-type': 'application/json', 'x-law-generation': generation },
        }));
        saved = true;
      }).catch(() => {});
      return { references, cacheStatus: saved ? 'saved' : 'not-saved' };
    })().finally(() => {
      if (pending.get(pendingKey) === task) pending.delete(pendingKey);
      if (latest.get(slot) === token) latest.delete(slot);
    });
    pending.set(pendingKey, task);
    return task;
  }
  globalThis.EgovInyoApi = Object.freeze({ get, prepare, invalidate, collectIds, convert });
})();
