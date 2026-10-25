// Metadata only: this never rewrites a cached law or the displayed document.
(() => {
  const { isCurrentView, isValidRevision, latestEnforcedRevision } = globalThis.EgovLawUpdates;
  const inFlight = new Map();
  const ORIGIN = 'https://laws.e-gov.go.jp';

  async function getLatest(lawId, mode) {
    const key = `${mode}:${lawId}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const options = { signal: controller.signal, cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } };
        const url = mode === 'normal' ? `${ORIGIN}/internal-api/SelectLawRevisionData.json`
          : `${ORIGIN}/api/2/law_revisions/${lawId}?response_format=json`;
        if (mode === 'normal') {
          options.method = 'POST';
          options.headers['Content-Type'] = 'application/json';
          options.body = JSON.stringify({ law_id: lawId });
        }
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`Revision check failed: HTTP ${response.status}`);
        const data = await response.json();
        if (mode === 'normal' && data?.result?.success !== true) throw new Error('Revision check failed');
        const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
        return latestEnforcedRevision(mode === 'normal' ? data.result.Amendment_History : data.revisions, mode, lawId, today);
      } finally { clearTimeout(timer); }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  async function check(message, sender) {
    const { lawId, mode, displayedRevision } = message;
    if (sender.id !== chrome.runtime.id || !isCurrentView(sender.url, mode, lawId)
        || !isValidRevision(displayedRevision, mode, lawId)) return { ok: false };
    if (mode === 'normal' && (!sender.tab || sender.frameId !== 0)) return { ok: false };
    if (mode === 'lite' && !sender.url.startsWith(chrome.runtime.getURL('viewer.html'))) return { ok: false };
    const latest = await getLatest(lawId, mode);
    return latest ? { ok: true, updated: latest !== displayedRevision, latestRevision: latest } : { ok: false };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'egov-check-law-update') return undefined;
    check(message, sender).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  });
})();
