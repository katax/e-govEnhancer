// Connection failures use only the normal-mode cache, never the Lite cache/API.
(() => {
  const ORIGIN = 'https://laws.e-gov.go.jp';
  const CACHE = 'egov-normal-responses-v1';
  const tracking = new Map();
  const fallingBack = new Set();
  function view(url) {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== ORIGIN || !/^\/law\/[0-9A-Z]{15}(?:\/|$)/.test(parsed.pathname)) return '';
      parsed.searchParams.delete('tab');
      parsed.searchParams.sort();
      return parsed.pathname.replace(/\/$/, '') + parsed.search;
    } catch (_) { return ''; }
  }
  function binding(pageUrl, request) {
    const target = view(pageUrl);
    if (!target) return {};
    const url = new URL(request.url);
    const body = request.method === 'POST' ? JSON.parse(request.body) : {};
    const wholeText = !Array.isArray(body.selTextList) || body.selTextList.some(id=>String(id).replace(/^#/,'')==='TOC');
    const kind = url.pathname.endsWith('_law.html') ? 'html' : url.pathname.endsWith('/SelectLawTextData.json') && wholeText ? 'json'
      : url.pathname.endsWith('/SelectLawData.json') ? 'metadata' : '';
    return kind ? { 'x-normal-view': encodeURIComponent(target), 'x-normal-law': target.match(/^\/law\/([0-9A-Z]{15})/)[1],
      'x-normal-kind': kind, 'x-normal-revision': body.law_data_id ? `${body.law_data_id}_${body.subRevision}`
        : url.pathname.match(/\/([0-9]+_[0-9]+)\//)?.[1] || '' } : {};
  }
  async function read(url) {
    const target = view(url);
    if (!target) return null;
    return globalThis.EgovShared.withLawCache(async () => {
      const cache = await caches.open(CACHE);
      const bodies = [], metadata = [];
      for (const key of await cache.keys()) {
        const response = await cache.match(key);
        if (!response || response.headers.get('x-normal-view') !== encodeURIComponent(target)) continue;
        const kind = response.headers.get('x-normal-kind');
        if (!['html', 'json', 'metadata'].includes(kind)) continue;
        const saved = Number(response.headers.get('x-saved'));
        if (!Number.isFinite(saved) || saved <= 0 || saved > Date.now()) continue;
        const record = { response, kind, downloadedAt: saved, revision: response.headers.get('x-normal-revision') };
        (kind === 'metadata' ? metadata : bodies).push(record);
      }
      bodies.sort((a,b) => b.downloadedAt-a.downloadedAt);
      async function firstValid(records) {
        for (const record of records) {
          const text = await record.response.text();
          const hash = await globalThis.EgovShared.lawCacheDigest(text);
          if (hash === record.response.headers.get('x-sha256')) {
            const {response, ...fields} = record;
            return {...fields,text};
          }
        }
        return null;
      }
      const body = await firstValid(bodies);
      if (!body) return null;
      metadata.sort((a,b) => b.downloadedAt-a.downloadedAt);
      const meta = await firstValid(metadata.filter(x => !body.revision || x.revision === body.revision));
      let lawData = {};
      try { lawData = JSON.parse(meta?.text || '{}').result?.law_data || {}; } catch (_) {}
      return { ...body, lawData, sourceUrl: url, lawId: target.match(/^\/law\/([0-9A-Z]{15})/)[1] };
    });
  }
  globalThis.EgovNormalCacheFallback = Object.freeze({ view, binding, read });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'egov-normal-connection-failed') {
      if(sender.id!==chrome.runtime.id || !sender.tab || sender.frameId!==0 || !view(sender.url))return;
      remember({frameId:0,tabId:sender.tab.id,url:sender.url})
        .then(()=>fallback({frameId:0,tabId:sender.tab.id,url:sender.url}))
        .then(()=>sendResponse({ok:true}),()=>sendResponse({ok:false}));
      return true;
    }
    if (message?.type !== 'egov-read-normal-offline') return;
    const viewer = chrome.runtime.getURL('viewer.html');
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(viewer + '?')) { sendResponse({ok:false}); return; }
    read(message.url).then(record => sendResponse({ok:!!record,record}), () => sendResponse({ok:false}));
    return true;
  });

  const key = tabId => `normalOfflineTarget:${tabId}`;
  async function remember(details) {
    if (details.frameId !== 0 || !view(details.url)) return;
    await chrome.storage.session.set({[key(details.tabId)]:{url:details.url,at:Date.now()}});
  }
  async function fallback(details) {
    if(fallingBack.has(details.tabId))return;
    fallingBack.add(details.tabId);
    try { await fallbackTab(details); } finally { fallingBack.delete(details.tabId); }
  }
  async function fallbackTab(details) {
    if (details.frameId !== 0 || details.error === 'net::ERR_ABORTED') return;
    await tracking.get(details.tabId);
    const stored = (await chrome.storage.session.get(key(details.tabId)))[key(details.tabId)];
    const url = view(details.url) ? details.url : stored?.url;
    if (!url || !stored || Date.now()-stored.at > 10*60000) return;
    if (!await read(url)) return;
    // Avoid replacing a tab that has navigated elsewhere during cache inspection.
    const tab = await chrome.tabs.get(details.tabId);
    const current = tab.pendingUrl || tab.url || '';
    if (current !== details.url && current !== url && current !== 'chrome-error://chromewebdata/') return;
    const target = new URL(chrome.runtime.getURL('viewer.html'));
    target.searchParams.set('lawId',new URL(url).pathname.split('/')[2]);
    target.searchParams.set('normalCache',url);
    target.hash = new URL(url).hash;
    await chrome.tabs.update(details.tabId,{url:target.href});
    await chrome.storage.session.remove(key(details.tabId));
  }
  chrome.webNavigation?.onBeforeNavigate.addListener(details => {
    if(details.frameId!==0 || !view(details.url))return;
    const task=remember(details);tracking.set(details.tabId,task);
    task.finally(()=>{if(tracking.get(details.tabId)===task)tracking.delete(details.tabId);}).catch(()=>{});
  });
  chrome.webNavigation?.onCommitted.addListener(details => {
    try { if(new URL(details.url).origin===ORIGIN && new URL(details.url).pathname==='/concentration')fallback(details).catch(()=>{}); } catch (_) {}
  });
  chrome.webNavigation?.onErrorOccurred.addListener(details => { if(view(details.url))fallback(details).catch(()=>{}); });
  chrome.tabs.onRemoved?.addListener(tabId => { chrome.storage.session.remove(key(tabId)).catch(()=>{}); });
})();
