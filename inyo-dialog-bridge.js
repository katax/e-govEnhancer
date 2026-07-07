(() => {
  if (window.__egovExtInyoDialogBridgeInstalled) return;
  window.__egovExtInyoDialogBridgeInstalled = true;

  // 想定外の巨大 vnode ツリーでの暴走を防ぐための探索深さ上限
  const FIND_COMP_MAX_DEPTH = 200;
  // Vue 内部状態・URL へ流し込む前の ID バリデーション（引用符・空白・山括弧等を排除）
  const SAFE_ID_PATTERN = /^[^\s"'<>`]+$/;

  function findComp(vnode, depth = 0) {
    if (!vnode || depth > FIND_COMP_MAX_DEPTH) return null;
    const component = vnode.component;
    if (
      component?.setupState &&
      Object.prototype.hasOwnProperty.call(component.setupState, 'showInyoLawTextDialog')
    ) {
      return component;
    }

    const nested = findComp(component?.subTree, depth + 1);
    if (nested) return nested;

    if (Array.isArray(vnode.children)) {
      for (const child of vnode.children) {
        const found = findComp(child, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data || {};
    if (data.type !== 'egov-ext-open-inyo-dialog') return;

    let ok = false;
    let error = '';
    try {
      const app = document.getElementById('app');
      const comp = findComp(app?._vnode);
      const state = comp?.setupState;
      if (!state) throw new Error('inyo dialog component not found');
      if (typeof data.lawId !== 'string' || typeof data.objectId !== 'string') {
        throw new Error('missing target');
      }
      if (!SAFE_ID_PATTERN.test(data.lawId) || !SAFE_ID_PATTERN.test(data.objectId)) {
        throw new Error('invalid target');
      }

      const objectIds = [data.objectId];
      const left = Number(data.clientX);
      const top = Number(data.clientY);

      state.showInyoLawTextDialog = false;
      state.inyoLawId = data.lawId;
      state.inyoObjectID = objectIds;
      state.inyoPath = `https://laws.e-gov.go.jp/law/${data.lawId}#${data.objectId}`;
      state.inyoLeft = Number.isFinite(left) ? left : 0;
      state.inyoTop = Number.isFinite(top) ? top : 0;
      setTimeout(() => {
        try {
          state.showInyoLawTextDialog = true;
        } catch (_) {}
      }, 10);
      ok = true;
    } catch (err) {
      error = err?.message || String(err || 'unknown error');
    }

    window.postMessage({
      type: 'egov-ext-open-inyo-dialog-result',
      requestId: data.requestId,
      ok,
      error,
    }, window.location.origin);
  });
})();
