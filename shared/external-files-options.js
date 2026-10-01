document.addEventListener('DOMContentLoaded', async () => {
  'use strict';
  const files = globalThis.EgovExternalFiles;
  for (const category of files.categories) {
    const container = document.getElementById(category + 'ExternalFileSettings');
    const label = category === 'favorites' ? 'お気に入り・フォルダー' : 'メモ・ハイライト';
    const group = document.createElement('fieldset');
    group.className = 'external-file-group';
    group.innerHTML = `<legend>外部ファイルで自動保存・同期（任意）</legend>
      <p>${label}の保存先に JSON ファイルを指定できます。未設定時はブラウザー内に保存します。</p>
      <p>Google Drive・OneDrive などの同期フォルダー内の同じファイルを各端末で指定してください。変更時に自動保存し、ブラウザー起動中は約30秒ごとに外部の更新を確認します。</p>
      <details><summary>同期のしくみとデータの保護</summary>
        <p>ファイル自体の端末間同期は各サービスのアプリで行います。スリープなどで更新確認が遅れる場合があります。お気に入りとメモには別々のファイルを指定してください。</p>
        ${category === 'memos' ? '<p>メモは位置情報を維持するためハイライトと一緒に保存します。</p>' : ''}
        <p>ファイルの削除・移動・読み込み失敗時も端末内のデータは保持します。両方に変更がある場合は自動上書きを止めます。取り込みや上書き前のバックアップを直近3件、端末内に保持します。</p>
      </details>
      <p class="external-file-status" role="status" aria-live="polite"></p>
      <div class="external-file-actions">
        <button type="button" data-action="open">既存ファイルを指定</button>
        <button type="button" data-action="create">現在の内容で新規ファイルを作成</button>
        <button type="button" data-action="sync">今すぐ更新を確認</button>
        <button type="button" data-action="grant">アクセスを再許可</button>
        <button type="button" data-action="disable">外部ファイルの利用を解除</button>
      </div>
      <details><summary>競合の解決・データの保全</summary>
        <p>競合時は上の「保存」や下の保存ボタンで内容を保全してから、採用する側を選んでください。</p>
        <div class="external-file-actions">
          <button type="button" data-action="read">外部ファイルの内容を採用</button>
          <button type="button" data-action="write">この端末の内容で外部ファイルを上書き</button>
          <button type="button" data-action="export">現在の端末データを保存</button>
          <label>バックアップ <select aria-label="保存するバックアップ"></select></label>
          <button type="button" data-action="backup">選んだバックアップを保存</button>
        </div>
      </details>`;
    container.append(group);
    const status = group.querySelector('[role="status"]');
    let config;
    let busy = false;
    async function render() {
      config = await files.entry(category);
      const key = 'externalFileStatus:' + category;
      const stored = (await chrome.storage.local.get(key))[key];
      const active = Boolean(config?.enabled);
      status.textContent = active
        ? `利用中: ${config.handle.name} — ${stored?.error || '自動保存・更新確認が有効です。'}${stored?.checkedAt ? '（最終確認 ' + new Date(stored.checkedAt).toLocaleString() + '）' : ''}`
        : '未設定（ブラウザー内に保存）';
      status.classList.toggle('external-file-error', active && Boolean(stored?.error));
      const select = group.querySelector('select');
      const selection = select.value;
      const backups = await files.entry('backups:' + category) || [];
      select.replaceChildren(...backups.map(backup => {
        const option = document.createElement('option');
        option.value = backup.savedAt;
        option.textContent = new Date(backup.savedAt).toLocaleString();
        return option;
      }));
      if (backups.some(backup => backup.savedAt === selection)) select.value = selection;
      for (const button of group.querySelectorAll('button')) {
        button.disabled = busy || (['sync', 'grant', 'disable', 'read', 'write'].includes(button.dataset.action) && !active);
      }
    }
    async function send(action) {
      const result = await chrome.runtime.sendMessage({ type: 'egov-external-file', category, action });
      if (!result?.ok) throw new Error(result?.error || '処理に失敗しました。');
    }
    function download(data, suffix) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `egov-${category}-${suffix}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    group.addEventListener('click', async event => {
      const button = event.target.closest('button[data-action]');
      if (!button || busy) return;
      busy = true;
      for (const item of group.querySelectorAll('button')) item.disabled = true;
      let errorMessage = '';
      try {
        const action = button.dataset.action;
        if (action === 'open' || action === 'create') {
          if (!window.showOpenFilePicker || !window.showSaveFilePicker) throw new Error('このブラウザーでは外部ファイルの指定に対応していません。');
          const options = { types: [{ description: 'JSON ファイル', accept: { 'application/json': ['.json'] } }], excludeAcceptAllOption: true };
          const handle = action === 'open'
            ? (await window.showOpenFilePicker({ ...options, multiple: false }))[0]
            : await window.showSaveFilePicker({ ...options, suggestedName: `egov-${category}.json` });
          if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('読み書きの許可が必要です。');
          if (action === 'open') {
            await files.read(category, handle);
            if (!window.confirm(`${label}を指定ファイルの内容に置き換え、以後このファイルを自動で読み書きします。続けますか？\n取り込み前のデータは端末内にバックアップします。`)) return;
          }
          await files.entry('pending:' + category, { handle, create: action === 'create' });
          await send('connect');
        } else if (action === 'grant') {
          if (await config.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('許可されませんでした。');
          await send('sync');
        } else if (action === 'read' || action === 'write') {
          if (!window.confirm(action === 'read' ? '端末内の内容を外部ファイルの内容に置き換えますか？' : '外部ファイルをこの端末の内容で上書きしますか？他の端末の変更が失われる場合があります。')) return;
          await send(action);
        } else if (action === 'export') download(await files.snapshot(category), 'local');
        else if (action === 'backup') {
          const backups = await files.entry('backups:' + category) || [];
          if (!backups.length) throw new Error('取り込み前のバックアップはまだありません。');
          const backup = backups.find(item => item.savedAt === group.querySelector('select').value);
          if (!backup) throw new Error('バックアップを選び直してください。');
          download(backup.data, 'backup-' + backup.savedAt.replace(/[:.]/g, '-'));
        } else await send(action);
      } catch (error) {
        if (error.name !== 'AbortError') errorMessage = error.message || String(error);
      } finally {
        busy = false;
        await render();
        if (errorMessage) { status.textContent = errorMessage + ' 端末内のデータは保持しています。'; status.classList.add('external-file-error'); }
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes['externalFileStatus:' + category] && !busy) render().catch(() => {});
    });
    await render();
  }
});
