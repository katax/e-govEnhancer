(function () {
  'use strict';
  const files = globalThis.EgovExternalFiles;
  const alarmName = 'egov-external-files-poll';
  let queue = Promise.resolve();
  function enqueue(work) {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  async function status(category, config, error = '') {
    await chrome.storage.local.set({ ['externalFileStatus:' + category]: {
      enabled: Boolean(config?.enabled), name: config?.handle?.name || '', error,
      checkedAt: Date.now(),
    } });
  }
  async function sync(category, direction) {
    const config = await files.entry(category);
    if (!config?.enabled) return;
    try {
      if (await config.handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        throw new Error('ファイルへのアクセス許可が必要です。「アクセスを再許可」を押してください。');
      }
      const local = await files.snapshot(category);
      const remote = await files.read(category, config.handle);
      if (!files.equal(local, remote)) {
        const hasData = data => category === 'favorites'
          ? data.favorites.length + data.favFolders.length > 0 : Object.keys(data.laws).length > 0;
        if (!direction && hasData(local) && !hasData(remote) && !files.equal(remote, config.base)) {
          throw new Error('外部ファイルのデータが空になっています。端末内のデータを保護するため自動取り込みを停止しました。意図した削除なら「外部ファイルの内容を採用」を選んでください。');
        }
        const localChanged = !files.equal(local, config.base);
        const remoteChanged = !files.equal(remote, config.base);
        if (!direction && localChanged && remoteChanged) throw new Error('この端末と外部ファイルの両方が変更されています。下のボタンで採用する内容を選んでください。');
        if (direction === 'read' || (!direction && !localChanged)) {
          await files.backup(category, local);
          if (!files.equal(local, await files.snapshot(category))) throw new Error('編集中のため再読み込みを延期しました。');
          await files.apply(category, remote);
          config.base = remote;
        } else {
          await files.backup(category, remote);
          // A cloud client may replace a file between the initial read and write.
          if (!files.equal(remote, await files.read(category, config.handle))) throw new Error('外部ファイルが更新されたため保存を延期しました。');
          await files.write(config.handle, local);
          config.base = local;
        }
      } else config.base = local;
      await files.entry(category, config);
      await status(category, config);
    } catch (error) {
      const detail = error.name === 'NotFoundError'
        ? 'ファイルが見つかりません。端末内のデータは保持しています。ファイルを戻すか、新しい保存先を指定してください。'
        : error.message || String(error);
      await status(category, config, detail);
      throw error;
    }
  }
  async function poll() {
    for (const category of files.categories) await sync(category).catch(() => {});
  }
  async function updateAlarm() {
    const configs = await Promise.all(files.categories.map(category => files.entry(category)));
    if (configs.some(config => config?.enabled)) {
      if (!await chrome.alarms.get(alarmName)) await chrome.alarms.create(alarmName, { periodInMinutes: 0.5 });
    } else await chrome.alarms.clear(alarmName);
  }
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === alarmName) enqueue(poll); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const category of files.categories) {
      if (Object.keys(changes).some(key => files.matches(category, key))) enqueue(() => sync(category)).catch(() => {});
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'egov-external-file') return;
    // File selection and destructive conflict resolution belong to the options page.
    if (sender.url !== chrome.runtime.getURL('options.html')) return;
    enqueue(async () => {
      const { category, action } = message;
      if (!files.categories.includes(category)) throw new Error('対象が不正です。');
      if (action === 'connect') {
        const pending = await files.entry('pending:' + category);
        if (!pending?.handle) throw new Error('ファイルを指定してください。');
        const other = await files.entry(category === 'favorites' ? 'memos' : 'favorites');
        if (other?.handle && await pending.handle.isSameEntry(other.handle)) throw new Error('お気に入りとメモには別々のファイルを指定してください。');
        const local = await files.snapshot(category);
        if (pending.create) {
          // New files must be empty; selecting an existing file never silently overwrites it.
          if ((await pending.handle.getFile()).size) throw new Error('既存ファイルです。「既存ファイルを指定」から読み込んでください。');
          await files.write(pending.handle, local);
        }
        const base = await files.read(category, pending.handle);
        await files.backup(category, local);
        if (!files.equal(local, await files.snapshot(category))) throw new Error('編集中のため設定を中止しました。もう一度指定してください。');
        await files.apply(category, base);
        const config = { handle: pending.handle, enabled: true, base };
        await files.entry(category, config);
        await files.entry('pending:' + category, {});
        await status(category, config);
      } else if (action === 'disable') {
        const config = await files.entry(category) || {};
        config.enabled = false;
        await files.entry(category, config);
        await status(category, config);
      } else if (['sync', 'read', 'write'].includes(action)) {
        await sync(category, action === 'sync' ? undefined : action);
      } else throw new Error('操作が不正です。');
      await updateAlarm();
    }).then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message || String(error) }));
    return true;
  });
  enqueue(async () => { await updateAlarm(); await poll(); }).catch(() => {});
})();
