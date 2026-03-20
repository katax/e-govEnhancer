document.addEventListener('DOMContentLoaded', async () => {
  // スムーズスクロール設定
  const smoothToggle = document.getElementById('smoothScrollToggle');
  const pinToastToggle = document.getElementById('pinToastToggle');
  const lawRefClickToggle = document.getElementById('lawRefClickToggle');
  const lawRefHoverPopupToggle = document.getElementById('lawRefHoverPopupToggle');
  const lawRefHoverPopupRow = document.getElementById('lawRefHoverPopupRow');

  const { scrollBehavior, pinToastDefaultVisible, lawRefClickEnabled, lawRefHoverPopup } = await chrome.storage.local.get(['scrollBehavior', 'pinToastDefaultVisible', 'lawRefClickEnabled', 'lawRefHoverPopup']);
  smoothToggle.checked = (scrollBehavior === 'smooth');
  pinToastToggle.checked = (typeof pinToastDefaultVisible === 'boolean') ? pinToastDefaultVisible : true;
  lawRefClickToggle.checked = (typeof lawRefClickEnabled === 'boolean') ? lawRefClickEnabled : false;
  lawRefHoverPopupToggle.checked = (typeof lawRefHoverPopup === 'boolean') ? lawRefHoverPopup : true;

  function updateLawRefHoverPopupRow() {
    lawRefHoverPopupRow.classList.toggle('is-disabled', !lawRefClickToggle.checked);
  }
  updateLawRefHoverPopupRow();

  async function reloadLawTabsIfConfirmed() {
    const ok = window.confirm('リロード後に反映されます。すべての法令ページをリロードしますか？');
    if (!ok) return;
    const tabs = await chrome.tabs.query({ url: 'https://laws.e-gov.go.jp/law/*' });
    for (const tab of tabs) chrome.tabs.reload(tab.id);
  }

  smoothToggle.addEventListener('change', () => {
    chrome.storage.local.set({ scrollBehavior: smoothToggle.checked ? 'smooth' : 'instant' });
  });
  pinToastToggle.addEventListener('change', () => {
    chrome.storage.local.set({ pinToastDefaultVisible: pinToastToggle.checked });
  });
  lawRefClickToggle.addEventListener('change', () => {
    chrome.storage.local.set({ lawRefClickEnabled: lawRefClickToggle.checked });
    updateLawRefHoverPopupRow();
    reloadLawTabsIfConfirmed();
  });
  lawRefHoverPopupToggle.addEventListener('change', () => {
    chrome.storage.local.set({ lawRefHoverPopup: lawRefHoverPopupToggle.checked });
    reloadLawTabsIfConfirmed();
  });

  // 現在のショートカットキーを取得して表示
  try {
    const commands = await chrome.commands.getAll();
    const actionCommand = commands.find((c) => c.name === '_execute_action');
    const shortcutEl = document.getElementById('currentShortcut');
    if (actionCommand && actionCommand.shortcut) {
      shortcutEl.textContent = actionCommand.shortcut;
    } else {
      shortcutEl.textContent = '未設定（Chromeの設定から登録してください）';
      shortcutEl.style.background = '#fff3e0';
      shortcutEl.style.color = '#e65100';
    }
  } catch (e) {
    document.getElementById('currentShortcut').textContent = 'Ctrl+Shift+E（デフォルト）';
  }

  // chrome://extensions/shortcuts リンク
  document.getElementById('openShortcutsPageLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
});
