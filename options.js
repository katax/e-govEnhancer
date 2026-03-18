document.addEventListener('DOMContentLoaded', async () => {
  // スムーズスクロール設定
  const smoothToggle = document.getElementById('smoothScrollToggle');
  const pinToastToggle = document.getElementById('pinToastToggle');
  const { scrollBehavior, pinToastDefaultVisible } = await chrome.storage.local.get(['scrollBehavior', 'pinToastDefaultVisible']);
  smoothToggle.checked = (scrollBehavior === 'smooth');
  pinToastToggle.checked = (typeof pinToastDefaultVisible === 'boolean') ? pinToastDefaultVisible : true;
  smoothToggle.addEventListener('change', () => {
    chrome.storage.local.set({ scrollBehavior: smoothToggle.checked ? 'smooth' : 'instant' });
  });
  pinToastToggle.addEventListener('change', () => {
    chrome.storage.local.set({ pinToastDefaultVisible: pinToastToggle.checked });
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
