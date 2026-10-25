// Isolated world: expose only the narrow public-law cache protocol to the page.
(() => {
  const channel = 'egov-normal-response-cache-v1';
  const page = crypto.randomUUID();
  const updates = globalThis.EgovLawUpdates;
  const forceKey = 'egov-normal-cache-force';
  const lawId = () => location.pathname.match(/^\/law\/([0-9A-Z]{15})(?:\/|$)/)?.[1] || '';
  let forceLaw = '';
  try {
    const flag = JSON.parse(sessionStorage.getItem(forceKey) || 'null');
    sessionStorage.removeItem(forceKey);
    if (flag?.lawId === lawId() && Date.now() - flag.at >= 0 && Date.now() - flag.at < 60000) forceLaw = flag.lawId;
  } catch (_) {}
  let bar, label, button, shownLaw = '', footerHost = null;
  let footerDirty = true;
  let uiFrame = 0;
  let checkTimer = 0, checkGeneration = 0, checkedKey = '';
  let revisionLaw = '', revisionHistory = [], displayedRevision = '', badgeFrame = 0;
  function updateRevisionBadge() {
    badgeFrame = 0;
    const group = document.querySelector('#titlebar .titlegroup');
    let badge = document.getElementById('egov-normal-revision-status');
    const selected = document.querySelector('.revisionitem[aria-selected="true"][data-revisionid]');
    const entry = revisionLaw === lawId() && revisionHistory.find(item => selected
      ? String(item.LawDataId) === selected.dataset.revisionid
      : `${item.LawDataId}_${item.SubRevision}` === displayedRevision);
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const current = updates.latestEnforcedRevision(revisionHistory, 'normal', lawId(), today);
    let text = '';
    if (entry && current) {
      text = `${entry.LawDataId}_${entry.SubRevision}` === current ? '現行版'
        : !entry.EnforcementDate || entry.EnforcementDate > today ? '未施行版' : '過去版';
    }
    if (!group || !text) { badge?.remove(); return; }
    let tags = group.querySelector('.statustags');
    if (!tags) {
      tags = document.createElement('div');
      tags.className = 'statustags';
      for (const name of group.getAttributeNames().filter(name => name.startsWith('data-v-'))) tags.setAttribute(name, '');
      group.append(tags);
    }
    if (!badge) {
      const native = tags.querySelector('.statustag');
      badge = native ? native.cloneNode(false) : document.createElement('span');
      badge.id = 'egov-normal-revision-status';
      badge.className = 'statustag';
      for (const name of tags.getAttributeNames().filter(name => name.startsWith('data-v-'))) badge.setAttribute(name, '');
      badge.setAttribute('role', 'status');
    }
    if (badge.textContent !== text) badge.textContent = text;
    const unenforced = [...tags.children].find(node => node !== badge && node.textContent === '未施行あり');
    if (unenforced && unenforced.nextElementSibling !== badge) unenforced.after(badge);
    else if (badge.parentElement !== tags) tags.append(badge);
  }
  function scheduleRevisionBadge() {
    if (!badgeFrame) badgeFrame = requestAnimationFrame(updateRevisionBadge);
  }
  function readRevisionHistory(request, value) {
    try {
      if (new URL(request.url).pathname !== '/internal-api/SelectLawRevisionData.json'
          || JSON.parse(request.body).law_id !== lawId()) return;
      const result = JSON.parse(value.text).result;
      if (!result?.success || !Array.isArray(result.Amendment_History)) return;
      revisionLaw = lawId();
      revisionHistory = result.Amendment_History;
      scheduleRevisionBadge();
    } catch (_) {}
  }
  function resetUpdateCheck() {
    clearTimeout(checkTimer);
    checkGeneration++;
    checkedKey = '';
    updates.setButtonState(button, false);
    if (button) button.dataset.lawUpdateState = 'not-checked';
  }
  function scheduleUpdateCheck(request) {
    const view = location.pathname + location.search;
    const id = lawId();
    const revision = updates.normalBodyRevision(request, id);
    if (!updates.isCurrentView(location.href, 'normal', id) || !revision) {
      resetUpdateCheck();
      return;
    }
    const key = `${view}:${revision}`;
    if (checkedKey === key) return;
    resetUpdateCheck();
    checkedKey = key;
    button.dataset.lawUpdateState = 'waiting';
    const generation = checkGeneration;
    let attempts = 0;
    const run = async () => {
      if (generation !== checkGeneration || location.pathname + location.search !== view) return;
      // Body responses precede Vue's DOM update. Wait until the law is displayed.
      if (document.readyState !== 'complete' || !document.querySelector('#provisionview')?.textContent.trim()) {
        if (++attempts < 40) checkTimer = setTimeout(run, 250);
        return;
      }
      button.dataset.lawUpdateState = 'checking';
      try {
        const result = await chrome.runtime.sendMessage({ type: 'egov-check-law-update', mode: 'normal',
          lawId: id, displayedRevision: revision });
        if (generation !== checkGeneration || location.pathname + location.search !== view) return;
        if (result?.ok) updates.setButtonState(button, result.updated);
        button.dataset.lawUpdateState = result?.ok ? (result.updated ? 'updated' : 'current') : 'unknown';
      } catch (_) {
        if (generation === checkGeneration) button.dataset.lawUpdateState = 'unknown';
      }
    };
    checkTimer = setTimeout(run, 300);
  }
  function ensureUI() {
    if (!document.body) return;
    if (!bar) {
      bar = document.createElement('aside');
      bar.id = 'egov-normal-cache-status';
      bar.className = 'egov-normal-cache-status';
      bar.setAttribute('aria-label', '法令の表示とローカル保存');
      label = document.createElement('span');
      label.className = 'egov-normal-cache-date';
      label.setAttribute('role', 'status');
      const actions = document.createElement('div');
      actions.id = 'egov-normal-cache-actions';
      actions.className = 'egov-normal-cache-actions';
      button = document.createElement('button');
      button.id = 'egov-normal-redownload-button';
      button.type = 'button';
      button.textContent = updates.BUTTON_LABEL;
      updates.setButtonState(button, false);
      button.addEventListener('click', () => {
        button.disabled = true;
        try {
          sessionStorage.setItem(forceKey, JSON.stringify({ lawId: lawId(), at: Date.now() }));
          label.textContent = '法令ファイルを再取得しています…';
          location.reload();
        } catch (_) {
          label.textContent = '法令ファイルの再取得を開始できませんでした。';
          button.disabled = false;
        }
      });
      actions.append(button);
      bar.append(label, actions);
    }
    let host = footerHost;
    if (footerDirty || !host?.isConnected || !lawId()) {
      const footers = lawId() ? [...document.querySelectorAll('footer.toolbar-main')] : [];
      host = footers.find(footer => !footer.closest('[hidden], [aria-hidden="true"]')
        && footer.getClientRects().length > 0) || footers[0];
      footerDirty = false;
    }
    if (footerHost !== host) {
      footerHost?.classList.remove('egov-ext-footer-host');
      footerHost = host;
    }
    if (host) {
      if (!host.classList.contains('egov-ext-footer-host')) host.classList.add('egov-ext-footer-host');
      if (bar.parentElement !== host) host.prepend(bar);
    } else if (bar.isConnected) bar.remove();
    bar.hidden = !lawId();
    const tab = document.querySelector('input[name="segments-provisionviews"]:checked')?.value
      || document.querySelector('select[name="dropdown-provisionviews"]')?.value
      || new URLSearchParams(location.search).get('tab');
    const hideAcquisition = ['compare', 'cite', 'cited'].includes(tab);
    bar.classList.toggle('is-acquisition-hidden', hideAcquisition);
    label.hidden = hideAcquisition;
    button.hidden = hideAcquisition;
    const view = location.pathname + location.search;
    if (shownLaw !== view) {
      shownLaw = view;
      label.textContent = '法令ファイル取得日時：確認中';
      resetUpdateCheck();
    }
  }
  function isBody(request) {
    if (!request || !lawId()) return false;
    try {
      const url = new URL(request.url);
      if (url.origin !== location.origin) return false;
      return url.pathname.startsWith(`/data/`) && url.pathname.includes(`/${lawId()}/`) && url.pathname.endsWith('_law.html')
        || url.pathname === '/internal-api/SelectLawTextData.json' && JSON.parse(request.body).law_id === lawId();
    } catch (_) { return false; }
  }
  function showDate(request, at) {
    if (!isBody(request) || !Number.isFinite(at) || at <= 0) return;
    ensureUI();
    if (!label) return;
    // A new body response replaces the previous displayed body. Retaining the
    // minimum over past requests makes a fresh download appear stale.
    label.textContent = `法令ファイル取得日時：${new Date(at).toLocaleString('ja-JP')}`;
    displayedRevision = updates.normalBodyRevision(request, lawId());
    scheduleRevisionBadge();
    scheduleUpdateCheck(request);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureUI, { once: true });
  else ensureUI();
  function scheduleUI() {
    footerDirty = true;
    if (uiFrame) return;
    uiFrame = requestAnimationFrame(() => { uiFrame = 0; ensureUI(); });
  }
  const containsFooter = node => node instanceof Element &&
    (node.matches('footer.toolbar-main') || !!node.querySelector('footer.toolbar-main'));
  new MutationObserver(mutations => {
    const relevant = node => node instanceof Element &&
      (node.matches('#titlebar, .revisionitem') || !!node.querySelector('#titlebar, .revisionitem'));
    if (mutations.some(mutation => mutation.target instanceof Element &&
      (mutation.target.closest('#titlebar, .revisionitem') ||
        [...mutation.addedNodes, ...mutation.removedNodes].some(relevant)))) scheduleRevisionBadge();
    if (!footerHost?.isConnected || bar?.parentElement !== footerHost) return scheduleUI();
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        // Visibility may be controlled by any footer or one of its ancestors.
        if (containsFooter(mutation.target)) return scheduleUI();
      } else if ([...mutation.addedNodes, ...mutation.removedNodes].some(containsFooter)) {
        return scheduleUI();
      }
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-selected', 'data-revisionid'] });
  window.addEventListener('resize', scheduleUI, { passive: true });
  window.addEventListener('popstate', scheduleUI);
  document.addEventListener('change', event => {
    if (event.target.matches('input[name="segments-provisionviews"], select[name="dropdown-provisionviews"]')) scheduleUI();
  });
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== channel) return;
    if (data.direction === 'notice') {
      if (data.failed && isBody(data.request)) {
        ensureUI();
        if (label) label.textContent = '法令ファイルの取得に失敗しました。再試行してください。';
      } else showDate(data.request, data.downloadedAt);
      return;
    }
    if (data.direction !== 'request' || typeof data.id !== 'string' || data.id.length > 100
        || !['get', 'put'].includes(data.action)) return;
    if (data.action === 'put') readRevisionHistory(data.request, data.value);
    chrome.runtime.sendMessage({ type: 'egov-normal-response-cache', page,
      action: data.action, request: data.request, build: data.build, value: data.value, force: forceLaw === lawId(),
    }).then(value => {
      if (data.action === 'get') {
        if (value) readRevisionHistory(data.request, value);
        window.postMessage({ channel, direction: 'response', id: data.id, value }, location.origin);
      }
    }).catch(() => {
      if (data.action === 'get') window.postMessage({ channel, direction: 'response', id: data.id, value: null }, location.origin);
    });
  });
})();
