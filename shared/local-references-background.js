// API data is cached independently; local citations always use the installed data.
(() => {
  let indexPromise, referencesPromise;
  async function json(file) {
    const response = await fetch(chrome.runtime.getURL(file));
    if (!response.ok) throw new Error(`同梱逆リンクの読み込みに失敗しました: ${response.status}`);
    return response.json();
  }
  async function get(lawId) {
    indexPromise ||= json('data/local-references/index.json').catch(error => { indexPromise = null; throw error; });
    const index = await indexPromise;
    if (!Object.hasOwn(index.targets, lawId)) return {};
    referencesPromise ||= json('data/local-references/references.json').catch(error => { referencesPromise = null; throw error; });
    return (await referencesPromise)[lawId] || {};
  }
  async function merge(lawId, apiReferences) {
    const local = await get(lawId);
    if (!Object.keys(local).length) return apiReferences;
    const result = globalThis.EgovShared.mergeLawReferences(apiReferences, local);
    for (const value of Object.values(result)) value.externalLawSources = value.externalLawSources.map(source => ({ ...source,
      sourceUrl: source.sourceUrl?.startsWith('viewer.html?localRule=') ? chrome.runtime.getURL(source.sourceUrl) : source.sourceUrl,
    }));
    return result;
  }
  globalThis.EgovLocalReferences = Object.freeze({ get, merge });
})();
