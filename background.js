chrome.runtime.onStartup?.addListener(() => {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
});

chrome.runtime.onInstalled?.addListener(() => {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
});

chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});

function getLawUrl(lawId) {
  return `https://laws.e-gov.go.jp/law/${encodeURIComponent(lawId)}`;
}

function getLawIdFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/^\/law\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch (_) {
    return '';
  }
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

function sendJumpWhenReady(tabId, pin) {
  let done = false;

  const trySend = async () => {
    if (done) return;
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'egov-perform-color-pin-jump', pin });
      if (response && response.ok) {
        done = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
      }
    } catch (_) {}
  };

  const onUpdated = (updatedTabId, changeInfo) => {
    if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
    trySend();
  };

  chrome.tabs.onUpdated.addListener(onUpdated);
  trySend();
  setTimeout(() => {
    if (!done) chrome.tabs.onUpdated.removeListener(onUpdated);
  }, 15000);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'egov-open-options-page') {
    chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'egov-open-law-reference-tab' && message.url) {
    chrome.tabs.create({ url: message.url, active: true })
      .then((tab) => sendResponse({ ok: true, tabId: tab?.id }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type !== 'egov-jump-color-pin' || !message.pin?.lawId) return undefined;

  (async () => {
    const targetLawId = message.pin.lawId;
    const tabs = await chrome.tabs.query({ url: 'https://laws.e-gov.go.jp/law/*' });
    let targetTab = tabs.find((tab) => getLawIdFromUrl(tab.url || '') === targetLawId);

    if (targetTab) {
      if (targetTab.windowId) {
        await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
      }
      await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
      sendJumpWhenReady(targetTab.id, message.pin);
      sendResponse({ ok: true, targetTabId: targetTab.id });
      return;
    }

    targetTab = await chrome.tabs.create({ url: getLawUrl(targetLawId), active: true });
    sendJumpWhenReady(targetTab.id, message.pin);
    sendResponse({ ok: true, targetTabId: targetTab.id });
  })().catch(() => sendResponse({ ok: false }));

  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open_favorites_popup') {
    openActionPopup('favorites').catch(() => {});
    return;
  }
  if (command === 'open_history_popup') {
    openActionPopup('law').catch(() => {});
  }
});
