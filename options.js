document.addEventListener('DOMContentLoaded', async () => {
  // スムーズスクロール設定
  const smoothToggle = document.getElementById('smoothScrollToggle');
  const { scrollBehavior } = await chrome.storage.local.get(['scrollBehavior']);
  smoothToggle.checked = (scrollBehavior === 'smooth');
  smoothToggle.addEventListener('change', () => {
    chrome.storage.local.set({ scrollBehavior: smoothToggle.checked ? 'smooth' : 'instant' });
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

  // URLコピーボタン
  document.getElementById('copyUrl').addEventListener('click', async () => {
    const url = document.getElementById('shortcutUrl').textContent;
    try {
      await navigator.clipboard.writeText(url);
      const btn = document.getElementById('copyUrl');
      btn.textContent = 'コピーしました！';
      btn.style.background = '#2e7d32';
      setTimeout(() => {
        btn.textContent = 'コピー';
        btn.style.background = '';
      }, 2000);
    } catch (e) {
      // フォールバック
      const el = document.getElementById('shortcutUrl');
      const range = document.createRange();
      range.selectNode(el);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  });
});
