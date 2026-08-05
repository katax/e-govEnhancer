(function (global) {
  'use strict';

  const { runWhenIdle } = global.EgovApp;

  function runAfterPageLoadWhenIdle(callback, timeout = 2500) {
    const schedule = () => runWhenIdle(callback, timeout);
    if (global.document.readyState === 'complete') {
      schedule();
      return;
    }
    global.addEventListener('load', schedule, { once: true });
  }

  function hasArticleElementInSubtree(node) {
    if (!(node instanceof Element)) return false;
    if (node.id && /\-At_[\d_]+$/.test(node.id)) return true;
    return !!node.querySelector?.('[id*="-At_"]');
  }

  function shouldInvalidateArticleCache(mutations) {
    for (const mutation of mutations) {
      if (mutation.target instanceof Element && mutation.target.id === 'provisionview') return true;
      for (const node of mutation.addedNodes) {
        if (hasArticleElementInSubtree(node)) return true;
      }
      for (const node of mutation.removedNodes) {
        if (hasArticleElementInSubtree(node)) return true;
      }
    }
    return false;
  }

  function observeArticleChanges({ root, shouldInvalidate, onInvalidate }) {
    let scheduled = false;
    const observer = new MutationObserver((mutations) => {
      if (scheduled || !shouldInvalidate(mutations)) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        onInvalidate();
      });
    });
    observer.observe(root, { childList: true, subtree: true });
    return observer;
  }

  function startWhenDomReady(initialize, { delayedStartMs = 800 } = {}) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', initialize, { once: true });
      return;
    }
    global.setTimeout(initialize, delayedStartMs);
  }

  global.EgovContentController = Object.freeze({
    observeArticleChanges,
    runAfterPageLoadWhenIdle,
    shouldInvalidateArticleCache,
    startWhenDomReady,
  });
})(globalThis);
