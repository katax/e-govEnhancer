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
  lawRefClickToggle.checked = (typeof lawRefClickEnabled === 'boolean') ? lawRefClickEnabled : true;
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
    const favoritesCommand = commands.find((c) => c.name === 'open_favorites_popup');
    const historyCommand = commands.find((c) => c.name === 'open_history_popup');
    const shortcutEl = document.getElementById('currentShortcut');
    if (actionCommand && actionCommand.shortcut) {
      shortcutEl.textContent = actionCommand.shortcut;
    } else {
      shortcutEl.textContent = '未設定（Chromeの設定から登録してください）';
      shortcutEl.style.background = '#fff3e0';
      shortcutEl.style.color = '#e65100';
    }

    const shortcutCardBody = shortcutEl.closest('.card-body');
    if (shortcutCardBody) {
      const extraShortcutBox = document.createElement('div');
      extraShortcutBox.className = 'info-box';
      extraShortcutBox.innerHTML =
        `<p><strong>追加ショートカット</strong></p>` +
        `<p>お気に入り画面を最初から表示: <kbd>${favoritesCommand?.shortcut || 'Ctrl+Shift+F'}</kbd></p>` +
        `<p>開いた法令履歴画面を最初から表示: <kbd>${historyCommand?.shortcut || 'Ctrl+Shift+H'}</kbd></p>` +
        `<p>ショートカットの変更は Chrome の <code>chrome://extensions/shortcuts</code> から行えます。</p>`;
      shortcutCardBody.appendChild(extraShortcutBox);

      const chromeGuide = document.createElement('div');
      chromeGuide.className = 'shortcut-steps';
      chromeGuide.innerHTML =
        `<p class="steps-title">Chromeでショートカットを変更する方法</p>` +
        `<ol>` +
          `<li><code>chrome://extensions/shortcuts</code> を開く</li>` +
          `<li>「e-Gov法令検索 Enhancer」を探す</li>` +
          `<li>各コマンドの入力欄をクリックする</li>` +
          `<li>希望のキーを押して保存する</li>` +
        `</ol>`;
      shortcutCardBody.appendChild(chromeGuide);
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
