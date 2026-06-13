(() => {
  if (window.__egovExtInyoDialogBridgeInstalled) return;
  window.__egovExtInyoDialogBridgeInstalled = true;

  function findComp(vnode) {
    if (!vnode) return null;
    const component = vnode.component;
    if (
      component?.setupState &&
      Object.prototype.hasOwnProperty.call(component.setupState, 'showInyoLawTextDialog')
    ) {
      return component;
    }

    const nested = findComp(component?.subTree);
    if (nested) return nested;

    if (Array.isArray(vnode.children)) {
      for (const child of vnode.children) {
        const found = findComp(child);
        if (found) return found;
      }
    }
    return null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.type !== 'egov-ext-open-inyo-dialog') return;

    let ok = false;
    let error = '';
    try {
      const app = document.getElementById('app');
      const comp = findComp(app?._vnode);
      const state = comp?.setupState;
      if (!state) throw new Error('inyo dialog component not found');
      if (!data.lawId || !data.objectId) throw new Error('missing target');

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
        state.showInyoLawTextDialog = true;
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
    }, '*');
  });
})();
