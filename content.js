/**
 * e-Gov法令検索 拡張機能 - コンテンツスクリプト
 *
 * キーボードショートカット（入力欄フォーカス外）:
 *   0-9    : 条文ジャンプ（3.2.1 で 第3条第2項第1号 指定）
 *   h / l  : 条文ジャンプ履歴を前後に移動
 *   n / p  : 次/前の条文を画面上端に表示
 *   d / u  : 下/上へ80%スクロール
 *   s      : ページ内検索
 *   r      : 現在の法令名で法令検索
 *   c      : 条文番号の漢数字/アラビア数字の切り替え
 *   Esc    : ダイアログを閉じる
 */
(function () {
  'use strict';

  // ==================
  // 状態管理
  // ==================
  let activeDialog = null;
  let searchState  = { highlights: [], currentIndex: -1 };

  // ページ滞在中のみ保持する履歴（ドロップダウン用）
  let articleHistory = [];
  let searchHistory  = [];
  const HISTORY_MAX  = 10;

  // 条文ジャンプ ナビゲーション履歴（h/l キー用）
  let articleJumpHistory = [];
  let articleJumpCursor  = -1;
  let indicatorTimer     = null;

  // 数字表示モード
  let numberMode = 'kanji'; // 'kanji' | 'arabic'

  // かな変換済みフラグ（一方通行）
  let kanaConverted = false;

  // ショートカット有効/無効
  let extensionEnabled = true;

  // スクロール速度（'instant' | 'smooth'、デフォ: instant）
  let scrollBehavior = 'instant';
  chrome.storage.local.get(['scrollBehavior'], (data) => {
    if (data.scrollBehavior === 'smooth') scrollBehavior = 'smooth';
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.scrollBehavior) scrollBehavior = changes.scrollBehavior.newValue;
  });

  // ==================
  // 履歴ユーティリティ
  // ==================
  function pushHistory(history, value) {
    if (!value) return;
    const idx = history.indexOf(value);
    if (idx !== -1) history.splice(idx, 1);
    history.unshift(value);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  }

  function pushJumpHistory(num) {
    if (!num) return;
    if (articleJumpCursor >= 0 && articleJumpCursor < articleJumpHistory.length - 1) {
      articleJumpHistory.splice(articleJumpCursor + 1);
    }
    articleJumpHistory.push(num);
    if (articleJumpHistory.length > 50) articleJumpHistory.shift();
    articleJumpCursor = articleJumpHistory.length - 1;
  }

  function navigateJumpHistory(dir) {
    if (articleJumpHistory.length === 0) return;
    const newCursor = articleJumpCursor + dir;
    if (newCursor < 0 || newCursor >= articleJumpHistory.length) return;
    articleJumpCursor = newCursor;
    const raw   = articleJumpHistory[articleJumpCursor];
    const parts = raw.split('.');
    jumpToArticleWithDetail(parts[0], parts[1] || null, parts[2] || null);
    showJumpHistoryIndicator();
  }

  // ==================
  // 履歴インジケーター（画面下部）
  // ==================
  function numToDisplay(raw) {
    if (!raw) return '';
    const parts = raw.split('.');
    let s = '第' + parts[0].replace(/[-－‐ー_]/g, 'の').replace(/のの+/g, 'の') + '条';
    if (parts[1]) s += '第' + parts[1] + '項';
    if (parts[2]) s += '第' + parts[2] + '号';
    return s;
  }

  function showJumpHistoryIndicator() {
    let ind = document.getElementById('egov-jump-indicator');
    if (!ind) {
      ind = document.createElement('div');
      ind.id = 'egov-jump-indicator';
      document.body.appendChild(ind);
    }

    const current = articleJumpHistory[articleJumpCursor];
    const pos     = `${articleJumpCursor + 1} / ${articleJumpHistory.length}`;
    const CONTEXT = 5;

    const prevNums = [];
    for (let i = Math.max(0, articleJumpCursor - CONTEXT); i < articleJumpCursor; i++) {
      prevNums.push(articleJumpHistory[i]);
    }
    const nextNums = [];
    for (let i = articleJumpCursor + 1; i <= Math.min(articleJumpHistory.length - 1, articleJumpCursor + CONTEXT); i++) {
      nextNums.push(articleJumpHistory[i]);
    }

    function itemOpacity(dist) { return [0, 0.68, 0.50, 0.36, 0.24, 0.14][Math.min(dist, 5)]; }

    const prevHtml = prevNums.map((num, idx) => {
      const dist = prevNums.length - idx;
      return `<span class="egov-jump-ind-near" style="opacity:${itemOpacity(dist)}">${escapeHtml(numToDisplay(num))}</span>`;
    }).join('');

    const nextHtml = nextNums.map((num, idx) => {
      const dist = idx + 1;
      return `<span class="egov-jump-ind-near" style="opacity:${itemOpacity(dist)}">${escapeHtml(numToDisplay(num))}</span>`;
    }).join('');

    ind.innerHTML =
      `<div class="egov-jump-ind-inner">` +
        `<div class="egov-jump-ind-context egov-jump-ind-prev">${prevHtml}</div>` +
        `<span class="egov-jump-ind-current">${escapeHtml(numToDisplay(current))}<span class="egov-jump-ind-pos">${escapeHtml(pos)}</span></span>` +
        `<div class="egov-jump-ind-context egov-jump-ind-next">${nextHtml}</div>` +
      `</div>`;

    ind.style.setProperty('opacity', '1', 'important');
    ind.style.setProperty('display', 'flex', 'important');
    clearTimeout(indicatorTimer);
    indicatorTimer = setTimeout(() => {
      ind.style.setProperty('opacity', '0', 'important');
      setTimeout(() => { ind.style.setProperty('display', 'none', 'important'); }, 400);
    }, 2500);
  }

  // ==================
  // ユーティリティ
  // ==================
  function isInputActive() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    return (
      tag === 'input' || tag === 'textarea' || tag === 'select' ||
      el.isContentEditable || el.getAttribute('contenteditable') === 'true'
    );
  }

  function closeDialog() {
    if (activeDialog) { activeDialog.remove(); activeDialog = null; }
    clearHighlights();
  }

  function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toFullWidth(s) {
    return String(s).replace(/[0-9]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
  }

  const KANJI_NUMS = ['〇','一','二','三','四','五','六','七','八','九',
                      '十','十一','十二','十三','十四','十五','十六','十七','十八','十九',
                      '二十','二十一','二十二','二十三','二十四','二十五','二十六','二十七','二十八','二十九','三十'];
  function toKanjiNum(n) { return KANJI_NUMS[n] || String(n); }

  // 漢数字パーサー（〜999）
  const _KV = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  function parseKanjiNum(s) {
    let v = 0, rem = s;
    const h = rem.match(/^([一二三四五六七八九])?百(.*)/);
    if (h) { v += (h[1] ? _KV[h[1]] : 1) * 100; rem = h[2]; }
    const j = rem.match(/^([一二三四五六七八九])?十(.*)/);
    if (j) { v += (j[1] ? _KV[j[1]] : 1) * 10; rem = j[2]; }
    if (rem && _KV[rem]) v += _KV[rem];
    return v;
  }

  // 整数（1-999）→ 漢数字文字列
  function numToKanjiStr(n) {
    if (n <= 0 || n >= 1000) return null;
    const ONES = ['','一','二','三','四','五','六','七','八','九'];
    const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), o = n % 10;
    let s = '';
    if (h) s += (h === 1 ? '' : ONES[h]) + '百';
    if (t) s += (t === 1 ? '' : ONES[t]) + '十';
    if (o) s += ONES[o];
    return s || null;
  }

  // テキスト内の漢数字 → 全角アラビア数字
  // ルール: 千以上の単位を含む場合は万/億/兆 の前の係数のみ変換、含まない場合は全変換
  function kanjiToArabicInText(text) {
    return text.replace(/[一二三四五六七八九十百千万億兆]+/g, (match) => {
      if (/千/.test(match)) {
        // 千を含む → 万/億/兆 の前の[一-百]セグメントのみ変換
        return match.replace(/([一二三四五六七八九十百]+)(?=[万億兆])/g, (seg) => {
          const n = parseKanjiNum(seg);
          return n > 0 ? toFullWidth(String(n)) : seg;
        });
      }
      // 千を含まない → [一-百]+ セグメントをすべて変換
      return match.replace(/[一二三四五六七八九十百]+/g, (seg) => {
        const n = parseKanjiNum(seg);
        return n > 0 ? toFullWidth(String(n)) : seg;
      });
    });
  }

  // テキスト内のアラビア数字（全角・半角どちらも対象、1-999）→ 漢数字
  function arabicToKanjiInText(text) {
    return text.replace(/[０-９0-9]+/g, (match) => {
      // 全角 → 半角に正規化してから parseInt
      const ascii = match.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
      const n = parseInt(ascii, 10);
      if (n >= 1 && n <= 999) return numToKanjiStr(n) || match;
      return match;
    });
  }

  // 丸数字 ①-⑳ → 漢数字
  const _CIRCLED = ['','①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩',
                       '⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];
  function circledToKanji(c) {
    const n = c.charCodeAt(0) - 0x245F; // ① = U+2460 → n = 1
    if (n < 1 || n > 20) return c;
    return numToKanjiStr(n) || c;
  }

  // APIレスポンスから法令フィールドを取り出す
  function getLawFields(law) {
    const info = law.law_info              || {};
    const rev  = law.current_revision_info || law.revision_info || {};
    return {
      lawId:   info.law_id    || '',
      lawName: rev.law_title  || rev.abbrev || '(名称不明)',
      lawNum:  info.law_num   || '',
      lawType: info.law_type  || rev.law_type || '',
    };
  }

  // ページ上部25%の位置に要素をスクロール表示する
  function scrollToElement25pct(el) {
    const container = getScrollContainer();
    const rect = el.getBoundingClientRect();
    if (container) {
      const cRect  = container.getBoundingClientRect();
      const absTop = rect.top - cRect.top + container.scrollTop;
      container.scrollTo({ top: Math.max(0, absTop - container.clientHeight * 0.25), behavior: scrollBehavior });
    } else {
      const absTop = rect.top + window.scrollY;
      window.scrollTo({ top: Math.max(0, absTop - window.innerHeight * 0.25), behavior: scrollBehavior });
    }
  }

  // ==================
  // キーボードイベント
  // ==================
  document.addEventListener('keydown', (e) => {
    // Alt+P: ショートカット有効/無効トグル（入力中・ダイアログ中でも動作）
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      extensionEnabled = !extensionEnabled;
      updateGuideButtonState();
      return;
    }

    if (isInputActive()) return;

    if (e.key === 'Escape') {
      if (activeDialog) { e.preventDefault(); closeDialog(); }
      return;
    }

    // ショートカット無効中はここで止める
    if (!extensionEnabled) return;

    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key.length > 1) return;

    // ダイアログ非表示時のみ有効なキー
    if (!activeDialog) {
      if (e.key === 'h') { e.preventDefault(); navigateJumpHistory(-1); return; }
      if (e.key === 'l') { e.preventDefault(); navigateJumpHistory(+1); return; }
      if (e.key === 'd') { e.preventDefault(); scrollPage(+0.8); return; }
      if (e.key === 'u') { e.preventDefault(); scrollPage(-0.8); return; }
      if (e.key === 'n') { e.preventDefault(); navigateArticle(+1); return; }
      if (e.key === 'p') { e.preventDefault(); navigateArticle(-1); return; }
      if (e.key === 'c') { e.preventDefault(); toggleNumberMode(); return; }
      if (e.key === 'k') { e.preventDefault(); convertKatakanaToHiragana(); return; }
    }

    e.preventDefault();
    closeDialog();

    if (/^[0-9]$/.test(e.key)) {
      showArticleDialog(e.key);
    } else if (e.key === 's') {
      showSearchDialog();
    } else if (e.key === 'r') {
      showLawSearchDialog();
    }
  }, true);

  // ==================
  // ダイアログ生成ファクトリ
  // ==================
  function createDialog(innerHtml, modeClass) {
    const overlay = document.createElement('div');
    overlay.className = 'egov-ext-overlay';
    if (modeClass) overlay.classList.add(modeClass);
    const dialog = document.createElement('div');
    dialog.className = 'egov-ext-dialog';
    dialog.innerHTML = innerHtml;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    activeDialog = overlay;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });
    dialog.querySelector('.egov-ext-close')?.addEventListener('click', closeDialog);
    return dialog;
  }

  // ==================
  // 履歴ドロップダウン
  // ==================
  function buildHistoryDropdown(input, history, onSelect) {
    const wrap = input.parentElement;
    wrap.style.position = 'relative';
    const dropdown = document.createElement('div');
    dropdown.className = 'egov-ext-history-dropdown';
    dropdown.style.display = 'none';
    wrap.appendChild(dropdown);

    let highlightedIndex = -1;
    let hoverEnabled = false;

    function render() {
      dropdown.innerHTML = '';
      highlightedIndex = -1;
      history.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'egov-ext-history-item';
        div.textContent = item;
        div.addEventListener('mousedown', (e) => { e.preventDefault(); select(i); });
        div.addEventListener('mouseenter', () => { if (hoverEnabled) setHighlight(i); });
        dropdown.appendChild(div);
      });
    }

    function setHighlight(index) {
      dropdown.querySelectorAll('.egov-ext-history-item').forEach((el, i) => {
        el.classList.toggle('egov-ext-history-item-focused', i === index);
      });
      highlightedIndex = index;
      if (index >= 0) input.value = history[index];
    }

    function moveHighlight(direction) {
      if (history.length === 0) return;
      const next = highlightedIndex < 0
        ? (direction > 0 ? 0 : history.length - 1)
        : (highlightedIndex + direction + history.length) % history.length;
      setHighlight(next);
    }

    function select(index) {
      const value = history[index];
      if (!value) return;
      pushHistory(history, value);
      input.value = value;
      hide();
      onSelect(value);
    }

    function show() {
      if (history.length === 0) return;
      hoverEnabled = false;
      setTimeout(() => { hoverEnabled = true; }, 250);
      render();
      dropdown.style.display = 'block';
    }

    function hide() { dropdown.style.display = 'none'; highlightedIndex = -1; }
    function isVisible() { return dropdown.style.display !== 'none'; }
    function getCurrentValue() { return highlightedIndex >= 0 ? history[highlightedIndex] : null; }

    return { show, hide, isVisible, moveHighlight, getCurrentValue, select: () => select(highlightedIndex) };
  }

  // ==================
  // 条文ジャンプ ダイアログ
  // ==================
  function showArticleDialog(pressedDigit) {
    const initial = pressedDigit || '';

    const dialog = createDialog(`
      <div class="egov-ext-dialog-header">
        <div class="egov-ext-dialog-title">
          <span class="egov-ext-title-icon">⚡</span> 条文ジャンプ
        </div>
        <button class="egov-ext-close" aria-label="閉じる">✕</button>
      </div>
      <div class="egov-ext-dialog-body">
        <div class="egov-ext-article-row">
          <span class="egov-ext-article-label">第</span>
          <div class="egov-ext-input-wrap">
            <input type="text" class="egov-ext-input" id="egov-article-num"
              placeholder="条番号を入力" value="${escapeHtml(initial)}" inputmode="numeric">
          </div>
          <span class="egov-ext-article-label">条</span>
        </div>
        <p class="egov-ext-hint">
          <kbd>-</kbd> で「の」（例: <code>3-2</code> → 第3条の2）<br>
          <kbd>.</kbd> で項・号（例: <code>3.2</code>=第3条第2項、<code>3.2.1</code>=第3条第2項第1号）<br>
          <kbd>Enter</kbd> ジャンプ ｜ <kbd>↑</kbd><kbd>↓</kbd> 履歴 ｜ <kbd>Tab</kbd> ページ内検索へ
        </p>
        <div class="egov-ext-result" id="egov-article-result"></div>
      </div>
    `, 'egov-ext-article-mode');

    const input = dialog.querySelector('#egov-article-num');
    input.setAttribute('inputmode', 'numeric');
    try { input.style.imeMode = 'disabled'; } catch (_) {}
    input.focus();
    input.setSelectionRange(initial.length, initial.length);

    const hist = buildHistoryDropdown(input, articleHistory, (val) => { doJump(val); });

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Tab') { e.preventDefault(); closeDialog(); showSearchDialog(); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (!hist.isVisible()) hist.show();
        hist.moveHighlight(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Escape') { hist.isVisible() ? hist.hide() : closeDialog(); return; }
      if (e.key === 'Enter') {
        if (hist.isVisible() && hist.getCurrentValue() !== null) { hist.select(); }
        else { hist.hide(); doJump(); }
        return;
      }
      hist.hide();
    });

    function doJump(overrideNum) {
      const raw = (overrideNum !== undefined ? overrideNum : input.value).trim();
      if (!raw) return;

      pushHistory(articleHistory, raw);
      pushJumpHistory(raw);

      const parts      = raw.split('.');
      const articleRaw = parts[0] || '';
      const paraRaw    = parts[1] || null;
      const itemRaw    = parts[2] || null;

      const found    = jumpToArticleWithDetail(articleRaw, paraRaw, itemRaw);
      const resultEl = dialog.querySelector('#egov-article-result');

      if (found) {
        closeDialog();
      } else {
        const dispArticle = articleRaw.replace(/[-－‐ー_]/g, 'の').replace(/のの+/g, 'の');
        let msg = `第${dispArticle}条`;
        if (paraRaw) msg += `第${paraRaw}項`;
        if (itemRaw) msg += `第${itemRaw}号`;
        resultEl.textContent = `「${msg}」が見つかりませんでした`;
        resultEl.className   = 'egov-ext-result egov-ext-result-error';
      }
    }
  }

  // ==================
  // 条文ジャンプ（条のみ）
  // ==================
  function jumpToArticle(num) {
    const norm = num.replace(/[のノ]/g, '_').replace(/[-－‐ー]/g, '_').replace(/\s+/g, '');
    console.log(`[e-Gov Jump] 検索: "${num}" → norm: "${norm}"`);

    const idPatterns = [
      `[id$="-At_${norm}"]`,
      `[id$="-At_${norm.replace(/_/g, '-')}"]`,
      `[id*="-At_${norm}-"]`,
    ];

    for (const sel of idPatterns) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          let target = els[0];
          if (sel.includes('*=')) {
            let el = target;
            while (el && el !== document.body) {
              if (/-At_/.test(el.id) && !/-At_.*-/.test(el.id.replace(/^.*-At_[^-]*/, ''))) { target = el; break; }
              el = el.parentElement;
            }
          }
          console.log(`[e-Gov Jump] ヒット: ${sel} → id="${target.id}"`);
          highlightAndScroll(target);
          return true;
        }
      } catch (_) {}
    }

    const root = document.querySelector('#provisionview') || document.body;
    const displayNum   = num.replace(/[_\-－‐ー]/g, 'の').replace(/のの/g, 'の');
    const exactPattern = new RegExp(`^第\\s*${escapeRegex(displayNum)}\\s*条(?:[^の0-9]|$)`);
    for (const el of root.querySelectorAll('span, div, p, h1, h2, h3, h4, h5')) {
      if (el.children.length > 3) continue;
      const text = el.textContent.trim();
      if (text.length > 60) continue;
      if (exactPattern.test(text)) { highlightAndScroll(el); return true; }
    }
    return false;
  }

  // ==================
  // 項・号まで含む詳細ジャンプ
  // ==================
  function jumpToArticleWithDetail(articleNum, paraNum, itemNum) {
    if (!paraNum) return jumpToArticle(articleNum);

    const na = articleNum.replace(/[のノ]/g, '_').replace(/[-－‐ー]/g, '_').replace(/\s+/g, '');
    const np = String(paraNum).trim();
    const ni = itemNum ? String(itemNum).trim() : null;

    let paraEl = null;
    for (const sel of [
      `[id$="-At_${na}-Co_${np}"]`,
      `[id$="-At_${na}-Pa_${np}"]`,
      `[id$="-At_${na}-Pr_${np}"]`,
      `[id*="-At_${na}-Co_${np}"]`,
      `[id*="-At_${na}-Pa_${np}"]`,
    ]) {
      try { const el = document.querySelector(sel); if (el) { paraEl = el; break; } } catch (_) {}
    }

    if (!paraEl) {
      const artEl = [...document.querySelectorAll(`[id*="-At_${na}"]`)]
        .find(el => /\-At_[\d_]+$/.test(el.id));
      if (artEl) {
        const fwN  = toFullWidth(np);
        const walker = document.createTreeWalker(artEl.parentElement || artEl, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          const t = node.textContent.trim();
          if (t === fwN || t === np || t === `第${fwN}項` || t === `第${np}項`) {
            paraEl = node.parentElement;
            break;
          }
        }
      }
    }

    if (!paraEl) return false;

    if (!ni) { highlightAndScroll(paraEl); return true; }

    let itemEl = null;
    for (const sel of [
      `[id*="-Co_${np}-It_${ni}"]`,
      `[id*="-Co_${np}-Sg_${ni}"]`,
      `[id*="-Pa_${np}-It_${ni}"]`,
      `[id*="-Pa_${np}-Sg_${ni}"]`,
      `[id*="-At_${na}"][id$="-It_${ni}"]`,
      `[id*="-At_${na}"][id$="-${ni}"]`,
    ]) {
      try { const el = document.querySelector(sel); if (el) { itemEl = el; break; } } catch (_) {}
    }

    if (!itemEl) {
      const kanjiN = toKanjiNum(parseInt(ni));
      const root   = paraEl.parentElement || document.querySelector('#provisionview') || document.body;
      let pastPara = false;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        if (!pastPara) {
          if (paraEl.contains(node.parentElement) || node.parentElement === paraEl) pastPara = true;
          continue;
        }
        const t = node.textContent.trim();
        if (t === kanjiN || t === `${kanjiN}　` || t === `${kanjiN} `) {
          itemEl = node.parentElement;
          break;
        }
      }
    }

    if (!itemEl) return false;
    highlightAndScroll(itemEl);
    return true;
  }

  function highlightAndScroll(el) {
    el.scrollIntoView({ behavior: scrollBehavior, block: 'center' });
    const origBg = el.style.backgroundColor;
    const origTr = el.style.transition;
    el.style.backgroundColor = '#FFF9C4';
    el.style.transition = 'background-color 1s';
    setTimeout(() => {
      el.style.backgroundColor = origBg;
      setTimeout(() => { el.style.transition = origTr; }, 1000);
    }, 1200);
  }

  // ==================
  // スクロールユーティリティ
  // ==================
  function getScrollContainer() {
    let el = document.querySelector('#provisionview');
    while (el && el !== document.documentElement) {
      const oy = window.getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return null;
  }

  function scrollPage(ratio) {
    const container = getScrollContainer();
    if (container) {
      container.scrollBy({ top: container.clientHeight * ratio, behavior: 'smooth' });
    } else {
      window.scrollBy({ top: window.innerHeight * ratio, behavior: 'smooth' });
    }
  }

  // ==================
  // 条文ナビゲーション（n/p キー）
  // ==================
  function getAllArticles() {
    return [...document.querySelectorAll('[id*="-At_"]')]
      .filter(el => /\-At_[\d_]+$/.test(el.id))
      .sort((a, b) => {
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return  1;
        return 0;
      });
  }

  function navigateArticle(direction) {
    const articles = getAllArticles();
    if (articles.length === 0) return;

    const container = getScrollContainer();

    function getAbsTop(el) {
      const rect = el.getBoundingClientRect();
      if (container) {
        return rect.top - container.getBoundingClientRect().top + container.scrollTop;
      }
      return rect.top + window.scrollY;
    }

    const viewTop = container ? container.scrollTop : window.scrollY;
    const MARGIN  = 60;

    let currentIdx = 0;
    for (let i = 0; i < articles.length; i++) {
      if (getAbsTop(articles[i]) <= viewTop + MARGIN) currentIdx = i;
    }

    const targetIdx = currentIdx + direction;
    if (targetIdx < 0 || targetIdx >= articles.length) return;

    const targetEl  = articles[targetIdx];
    const targetTop = getAbsTop(targetEl);

    if (container) {
      container.scrollTo({ top: Math.max(0, targetTop - 16), behavior: scrollBehavior });
    } else {
      window.scrollTo({ top: Math.max(0, targetTop - 16), behavior: scrollBehavior });
    }

    {
      const origBg = targetEl.style.backgroundColor;
      const origTr = targetEl.style.transition;
      targetEl.style.backgroundColor = '#FFF9C4';
      targetEl.style.transition       = 'background-color 1s';
      setTimeout(() => {
        targetEl.style.backgroundColor = origBg;
        setTimeout(() => { targetEl.style.transition = origTr; }, 1000);
      }, 1200);
    }
  }

  // ==================
  // ページ内検索 ダイアログ
  // ==================
  function showSearchDialog() {
    const dialog = createDialog(`
      <div class="egov-ext-dialog-header">
        <div class="egov-ext-dialog-title">
          <span class="egov-ext-title-icon">🔍</span> ページ内検索
        </div>
        <button class="egov-ext-close" aria-label="閉じる">✕</button>
      </div>
      <div class="egov-ext-dialog-body">
        <div class="egov-ext-search-row">
          <div class="egov-ext-input-wrap" style="flex:1">
            <input type="text" class="egov-ext-input" id="egov-search-text"
              placeholder="検索キーワードを入力..." lang="ja">
          </div>
          <button class="egov-ext-nav-btn" id="egov-search-prev" title="前へ (↑)">▲</button>
          <button class="egov-ext-nav-btn" id="egov-search-next" title="次へ (Enter)">▼</button>
        </div>
        <div class="egov-ext-result" id="egov-search-result"></div>
        <p class="egov-ext-hint">
          <kbd>Enter</kbd> 画面先頭から検索 ｜ <kbd>Shift</kbd>+<kbd>Enter</kbd> 上方向に検索 ｜ <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 現在位置から検索<br>
          <kbd>↑</kbd><kbd>↓</kbd> 履歴 ｜ <kbd>Tab</kbd> 条文ジャンプへ
        </p>
      </div>
    `, 'egov-ext-search-mode');

    const input    = dialog.querySelector('#egov-search-text');
    const resultEl = dialog.querySelector('#egov-search-result');

    try { input.style.imeMode = 'active'; } catch (_) {}
    input.focus();

    let lastExecutedQuery = '';

    function doSearchNext(query) {
      if (!query) return;
      if (query !== lastExecutedQuery) {
        lastExecutedQuery = query;
        pushHistory(searchHistory, query);
        performSearch(query, resultEl);
        navigateFromViewportStart(resultEl);
      } else {
        navigate(1, resultEl);
      }
    }

    function doSearchPrev(query) {
      if (!query) return;
      if (query !== lastExecutedQuery) {
        lastExecutedQuery = query;
        pushHistory(searchHistory, query);
        performSearch(query, resultEl);
        navigateFromViewportStart(resultEl);
      } else {
        navigate(-1, resultEl);
      }
    }

    function doSearchFromHere(query) {
      if (!query) return;
      if (query !== lastExecutedQuery) {
        lastExecutedQuery = query;
        pushHistory(searchHistory, query);
        performSearch(query, resultEl);
        navigateFromCurrentScrollPos(resultEl);
      } else {
        navigateFromCurrentScrollPos(resultEl);
      }
    }

    const hist = buildHistoryDropdown(input, searchHistory, (val) => {
      lastExecutedQuery = val;
      performSearch(val, resultEl);
      navigateFromViewportStart(resultEl);
    });

    input.addEventListener('input', () => {
      if (input.value.trim() !== lastExecutedQuery) {
        lastExecutedQuery = '';
        resultEl.textContent = '';
      }
      hist.hide();
    });

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Tab') { e.preventDefault(); closeDialog(); showArticleDialog(); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (!hist.isVisible()) hist.show();
        hist.moveHighlight(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Escape') { hist.isVisible() ? hist.hide() : closeDialog(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (hist.isVisible() && hist.getCurrentValue() !== null) { hist.select(); return; }
        hist.hide();
        const query = input.value.trim();
        if (e.ctrlKey)      doSearchFromHere(query);
        else if (e.shiftKey) doSearchPrev(query);
        else                 doSearchNext(query);
        return;
      }
      hist.hide();
    });

    dialog.querySelector('#egov-search-prev').addEventListener('click', () => navigate(-1, resultEl));
    dialog.querySelector('#egov-search-next').addEventListener('click', () => doSearchNext(input.value.trim()));
  }

  function performSearch(query, resultEl) {
    clearHighlights();
    if (!query) { if (resultEl) resultEl.textContent = ''; return; }
    searchState.highlights   = markText(query);
    searchState.currentIndex = -1;
    if (resultEl) {
      if (searchState.highlights.length === 0) {
        resultEl.textContent = '見つかりませんでした';
        resultEl.className   = 'egov-ext-result egov-ext-result-error';
      } else {
        resultEl.textContent = `${searchState.highlights.length} 件見つかりました`;
        resultEl.className   = 'egov-ext-result egov-ext-result-success';
      }
    }
  }

  function navigateFromViewportStart(resultEl) {
    const { highlights } = searchState;
    if (highlights.length === 0) return;

    const threshold = window.innerHeight * 0.25;
    let targetIdx = -1;
    for (let i = 0; i < highlights.length; i++) {
      const rect = highlights[i].getBoundingClientRect();
      if (rect.top >= threshold - 10) { targetIdx = i; break; }
    }
    if (targetIdx === -1) targetIdx = 0;

    clearCurrentHighlight();
    searchState.currentIndex = targetIdx;
    const current = highlights[targetIdx];
    setCurrentHighlight(current);
    scrollRangeToView(current);
    if (resultEl) {
      resultEl.textContent = `${targetIdx + 1} / ${highlights.length} 件`;
      resultEl.className   = 'egov-ext-result egov-ext-result-success';
    }
  }

  function navigateFromCurrentScrollPos(resultEl) {
    navigateFromViewportStart(resultEl);
  }

  function navigate(direction, resultEl) {
    const { highlights } = searchState;
    if (highlights.length === 0) return;
    clearCurrentHighlight();
    searchState.currentIndex =
      (searchState.currentIndex + direction + highlights.length) % highlights.length;
    const current = highlights[searchState.currentIndex];
    if (current) {
      setCurrentHighlight(current);
      scrollRangeToView(current);
      if (resultEl) {
        resultEl.textContent = `${searchState.currentIndex + 1} / ${highlights.length} 件`;
        resultEl.className   = 'egov-ext-result egov-ext-result-success';
      }
    }
  }

  // ==================
  // CSS Custom Highlight API ヘルパー
  //   DOM を一切変更せず Range オブジェクトだけでハイライト表示する
  //   - markText   : TreeWalker で Range[] を収集し CSS.highlights に登録（replaceChild/normalize なし）
  //   - clearHighlights : CSS.highlights を削除するだけ（瞬時）
  // ==================
  function injectHighlightStyles() {
    if (document.getElementById('egov-ext-hl-style')) return;
    const s = document.createElement('style');
    s.id = 'egov-ext-hl-style';
    s.textContent =
      '::highlight(egov-search){background-color:#FFF9C4;color:inherit}' +
      '::highlight(egov-search-current){background-color:#FF6B35;color:white}';
    document.head.appendChild(s);
  }

  function setCurrentHighlight(range) {
    if (!range) return;
    if (CSS.highlights) {
      CSS.highlights.set('egov-search-current', new Highlight(range));
    } else {
      // フォールバック: Selection でカレントを示す
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range.cloneRange()); }
    }
  }

  function clearCurrentHighlight() {
    if (CSS.highlights) CSS.highlights.set('egov-search-current', new Highlight());
  }

  // Range の viewport 上位置を取得して scrollBehavior でスクロール
  function scrollRangeToView(range) {
    const rect = range.getBoundingClientRect();
    const container = getScrollContainer();
    if (container) {
      const cRect  = container.getBoundingClientRect();
      const absTop = rect.top - cRect.top + container.scrollTop;
      container.scrollTo({ top: Math.max(0, absTop - container.clientHeight * 0.25), behavior: scrollBehavior });
    } else {
      const absTop = rect.top + window.scrollY;
      window.scrollTo({ top: Math.max(0, absTop - window.innerHeight * 0.25), behavior: scrollBehavior });
    }
  }

  function markText(query) {
    const ranges = [];
    const queryLower = query.toLowerCase();
    const regex = new RegExp(escapeRegex(query), 'gi');
    const searchRoot = document.querySelector('#provisionview') || document.body;
    const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_SKIP;
        // オーバーレイと #TOC は丸ごとスキップ（長い法令で大幅高速化）
        if (el.closest('.egov-ext-overlay, #TOC')) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return NodeFilter.FILTER_REJECT;
        // includes() は regex.test() より高速（リテラル検索のため）
        return node.textContent.toLowerCase().includes(queryLower)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        ranges.push(range);
      }
    }
    // DOM 変更ゼロで全マッチをハイライト
    if (CSS.highlights) {
      CSS.highlights.set('egov-search', new Highlight(...ranges));
      CSS.highlights.set('egov-search-current', new Highlight());
    }
    return ranges;
  }

  function clearHighlights() {
    if (CSS.highlights) {
      CSS.highlights.delete('egov-search');
      CSS.highlights.delete('egov-search-current');
    }
    window.getSelection()?.removeAllRanges();
    searchState.highlights   = [];
    searchState.currentIndex = -1;
  }

  // ==================
  // 法令名検索 ダイアログ（r キー）
  // ==================
  function getCurrentLawName() {
    for (const sel of ['.law-title', '#lawTitle', '.lawTitle', '.provisionViewHead h1',
                        '.provision-view-title', 'h1.title', '.title', 'h1']) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    const m = document.title.match(/^(.+?)(?:\s*[|｜\-–—]\s*e-Gov|$)/);
    return m ? m[1].trim() : document.title;
  }

  function cleanLawNameForSearch(name) {
    // 全角・半角括弧の括弧書きを除去
    let s = name.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
    // 末尾の「施行規則」「施行令」のみ削除（法・法律は残す）
    s = s.replace(/(?:施行規則|施行令)$/, '').trim();
    return s;
  }

  async function showLawSearchDialog() {
    let favorites = [];
    try {
      const data = await chrome.storage.local.get(['favorites']);
      favorites = Array.isArray(data.favorites) ? data.favorites : [];
    } catch (_) {}

    const initQuery = cleanLawNameForSearch(getCurrentLawName());

    const dialog = createDialog(`
      <div class="egov-ext-dialog-header">
        <div class="egov-ext-dialog-title">
          <span class="egov-ext-title-icon">📚</span> 関連法令検索
        </div>
        <button class="egov-ext-close" aria-label="閉じる">✕</button>
      </div>
      <div class="egov-ext-dialog-body">
        <div class="egov-ext-search-row">
          <div class="egov-ext-input-wrap" style="flex:1">
            <input type="text" class="egov-ext-input" id="egov-law-search-input"
              value="${escapeHtml(initQuery)}" placeholder="法令名を入力…" lang="ja">
          </div>
        </div>
        <div class="egov-ext-result" id="egov-law-search-status"></div>
        <ul class="egov-ext-law-result-list" id="egov-law-result-list"></ul>
        <p class="egov-ext-hint">
          <kbd>Enter</kbd> 検索 / 別タブで開く ｜ <kbd>↑</kbd><kbd>↓</kbd> 移動 ｜ <kbd>★</kbd> お気に入り
        </p>
      </div>
    `, 'egov-ext-law-mode');

    const input    = dialog.querySelector('#egov-law-search-input');
    const statusEl = dialog.querySelector('#egov-law-search-status');
    const listEl   = dialog.querySelector('#egov-law-result-list');
    input.focus();
    input.select();

    let results      = [];
    let focusedIdx   = -1;
    let hoverEnabled = false;

    function isFav(lawId) { return favorites.some(f => f.lawId === lawId); }

    function toggleFav(law) {
      const idx = favorites.findIndex(f => f.lawId === law.lawId);
      if (idx !== -1) {
        favorites.splice(idx, 1);
      } else {
        favorites.unshift({ lawId: law.lawId, lawName: law.lawName, lawNum: law.lawNum, lawType: law.lawType, folderId: null });
        if (favorites.length > 50) favorites.length = 50;
      }
      chrome.storage.local.set({ favorites: [...favorites] }).catch(() => {});
    }

    function setFocus(idx) {
      focusedIdx = idx;
      const items = listEl.querySelectorAll('.egov-ext-law-result-item');
      items.forEach((li, i) => li.classList.toggle('focused', i === idx));
      if (idx >= 0 && items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
    }

    function openLaw(law) {
      window.open(`https://laws.e-gov.go.jp/law/${law.lawId}`, '_blank');
      closeDialog();
    }

    function renderResults() {
      listEl.innerHTML = '';
      if (results.length === 0) { listEl.style.setProperty('display', 'none', 'important'); return; }
      listEl.style.setProperty('display', 'block', 'important');
      results.forEach((law, i) => {
        const li  = document.createElement('li');
        li.className = 'egov-ext-law-result-item';
        const fav = isFav(law.lawId);
        li.innerHTML =
          `<div class="egov-ext-law-result-main">` +
            `<span class="egov-ext-law-result-name">${escapeHtml(law.lawName)}</span>` +
            (law.lawNum ? `<span class="egov-ext-law-result-num">${escapeHtml(law.lawNum)}</span>` : '') +
          `</div>` +
          `<button class="egov-ext-law-result-fav${fav ? ' active' : ''}" title="${fav ? 'お気に入りから削除' : 'お気に入りに追加'}">${fav ? '★' : '☆'}</button>`;

        li.querySelector('.egov-ext-law-result-fav').addEventListener('click', (e) => {
          e.stopPropagation();
          toggleFav(law);
          const btn    = e.currentTarget;
          const nowFav = isFav(law.lawId);
          btn.textContent = nowFav ? '★' : '☆';
          btn.classList.toggle('active', nowFav);
          btn.title = nowFav ? 'お気に入りから削除' : 'お気に入りに追加';
        });

        li.addEventListener('mouseenter', () => { if (hoverEnabled) setFocus(i); });
        li.addEventListener('click', () => openLaw(law));
        listEl.appendChild(li);
      });
      focusedIdx = -1;
    }

    async function doSearch() {
      const query = input.value.trim();
      if (!query) return;
      statusEl.textContent = '検索中…';
      statusEl.className   = 'egov-ext-result';
      listEl.style.setProperty('display', 'none', 'important');
      results      = [];
      focusedIdx   = -1;
      hoverEnabled = false;
      setTimeout(() => { hoverEnabled = true; }, 300);
      try {
        const url  = `https://laws.e-gov.go.jp/api/2/laws?law_title=${encodeURIComponent(query)}&limit=31&response_format=json`;
        const res  = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const laws = Array.isArray(data.laws) ? data.laws : [];
        if (laws.length === 0) {
          statusEl.textContent = '見つかりませんでした';
          statusEl.className   = 'egov-ext-result egov-ext-result-error';
          return;
        }
        results = laws.slice(0, 30).map(getLawFields);
        statusEl.textContent = `${results.length}件${laws.length > 30 ? '（上限）' : ''}`;
        statusEl.className   = 'egov-ext-result egov-ext-result-success';
        renderResults();
      } catch (err) {
        statusEl.textContent = `エラー: ${err.message}`;
        statusEl.className   = 'egov-ext-result egov-ext-result-error';
      }
    }

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { closeDialog(); return; }
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        if (focusedIdx >= 0 && results[focusedIdx]) {
          toggleFav(results[focusedIdx]);
          const items = listEl.querySelectorAll('.egov-ext-law-result-item');
          if (items[focusedIdx]) {
            const btn    = items[focusedIdx].querySelector('.egov-ext-law-result-fav');
            const nowFav = isFav(results[focusedIdx].lawId);
            if (btn) {
              btn.textContent = nowFav ? '★' : '☆';
              btn.classList.toggle('active', nowFav);
              btn.title = nowFav ? 'お気に入りから削除' : 'お気に入りに追加';
            }
          }
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (focusedIdx >= 0 && results[focusedIdx]) openLaw(results[focusedIdx]);
        else doSearch();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (results.length > 0) setFocus((focusedIdx + 1 + results.length) % results.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (results.length > 0) setFocus((focusedIdx - 1 + results.length) % results.length);
        return;
      }
    });

    // 開いた直後に自動検索
    doSearch();
  }

  // ==================
  // 条文番号の漢数字/アラビア数字切り替え（c キー）
  //
  // 変換対象: 「第N条」「第N条のN」「第N項」「第N号」の N 部分のみ
  //   + 号リストアイテム（-It_/-Sg_ 要素内）の先頭単独漢数字
  // 変換先: 条・項 → 全角アラビア数字、号 → 丸数字（①② … / (N)）
  // ==================
  function toggleNumberMode() {
    const root = document.querySelector('#provisionview') || document.body;

    // テキストノードが号タイトル要素内にあるか判定（.itemtitle クラスのみ対象）
    function isInItemEl(node) {
      return !!node.parentElement?.closest('.itemtitle');
    }

    const KC = '[一二三四五六七八九十百千]+'; // 漢数字クラス
    const DC = '[０-９0-9]+';                // 全角・半角数字クラス
    const KANJI_RE  = /^[一二三四五六七八九十百千]+$/;
    const CIRCLE_RE = /^[①-⑳]$/;

    // 全角数字 → 半角ASCII
    function fw2hw(s) {
      return s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement?.closest('.egov-ext-overlay')) return NodeFilter.FILTER_REJECT;
        const tag = node.parentElement?.tagName?.toLowerCase();
        if (['script', 'style', 'noscript'].includes(tag)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    let nd;
    while ((nd = walker.nextNode())) nodes.push(nd);

    if (numberMode === 'kanji') {
      // 漢数字 → アラビア数字（号は丸数字）
      nodes.forEach(n => {
        if (isInItemEl(n)) {
          // 号リストアイテム先頭: 単独漢数字 → 丸数字
          const t = n.textContent.trim();
          if (KANJI_RE.test(t) && t.length <= 4) {
            const num = parseKanjiNum(t);
            if (num >= 1) {
              const c = num <= 20 ? _CIRCLED[num] : `(${toFullWidth(String(num))})`;
              n.textContent = n.textContent.replace(t, c);
            }
          }
        } else {
          // 条文参照: 第N条/項/号 の N 部分のみ変換
          const orig = n.textContent;
          let conv = orig
            // 第N条（のN…） — のN チェーンも含む
            .replace(new RegExp(`第(${KC})条((?:の${KC})*)`, 'g'), (m, art, chain) => {
              const artN = parseKanjiNum(art);
              if (artN < 1) return m;
              let res = `第${toFullWidth(String(artN))}条`;
              if (chain) {
                res += chain.replace(new RegExp(`の(${KC})`, 'g'), (cm, k) => {
                  const sn = parseKanjiNum(k);
                  return sn > 0 ? `の${toFullWidth(String(sn))}` : cm;
                });
              }
              return res;
            })
            // 第N項
            .replace(new RegExp(`第(${KC})項`, 'g'), (m, k) => {
              const nn = parseKanjiNum(k);
              return nn > 0 ? `第${toFullWidth(String(nn))}項` : m;
            })
            // 第N号（テキスト中の参照）→ アラビア数字（丸数字にしない）
            .replace(new RegExp(`第(${KC})号`, 'g'), (m, k) => {
              const nn = parseKanjiNum(k);
              return nn > 0 ? `第${toFullWidth(String(nn))}号` : m;
            });
          if (conv !== orig) n.textContent = conv;
        }
      });
      numberMode = 'arabic';

    } else {
      // アラビア数字・丸数字 → 漢数字
      nodes.forEach(n => {
        if (isInItemEl(n)) {
          // 号リストアイテム先頭: 丸数字/(N) → 漢数字
          const t = n.textContent.trim();
          if (CIRCLE_RE.test(t)) {
            n.textContent = n.textContent.replace(t, circledToKanji(t));
          } else if (/^\([０-９0-9]+\)$/.test(t)) {
            const nn = parseInt(fw2hw(t.slice(1, -1)), 10);
            const kanji = nn >= 1 ? (numToKanjiStr(nn) || String(nn)) : t.slice(1, -1);
            n.textContent = n.textContent.replace(t, kanji);
          }
        } else {
          // 条文参照: 全角/半角数字 → 漢数字（第N条/項/号 のNのみ）
          const orig = n.textContent;
          let conv = orig
            // 第N条（のN…）
            .replace(new RegExp(`第(${DC})条((?:の${DC})*)`, 'g'), (m, art, chain) => {
              const artN = parseInt(fw2hw(art), 10);
              if (!(artN >= 1)) return m;
              let res = `第${numToKanjiStr(artN) || art}条`;
              if (chain) {
                res += chain.replace(new RegExp(`の(${DC})`, 'g'), (cm, d) => {
                  const sn = parseInt(fw2hw(d), 10);
                  return sn >= 1 ? `の${numToKanjiStr(sn) || d}` : cm;
                });
              }
              return res;
            })
            // 第N項
            .replace(new RegExp(`第(${DC})項`, 'g'), (m, d) => {
              const nn = parseInt(fw2hw(d), 10);
              return nn >= 1 ? `第${numToKanjiStr(nn) || d}項` : m;
            })
            // 第N号（アラビア数字）→ 漢数字
            .replace(new RegExp(`第(${DC})号`, 'g'), (m, d) => {
              const nn = parseInt(fw2hw(d), 10);
              return nn >= 1 ? `第${numToKanjiStr(nn) || d}号` : m;
            });
          if (conv !== orig) n.textContent = conv;
        }
      });
      numberMode = 'kanji';
    }
  }

  // ==================
  // カタカナをひらがなに変換（k キー / 一方通行）
  // ==================
  function convertKatakanaToHiragana() {
    if (kanaConverted) return; // 既に変換済み
    const root = document.querySelector('#provisionview') || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement?.closest('.egov-ext-overlay')) return NodeFilter.FILTER_REJECT;
        const tag = node.parentElement?.tagName?.toLowerCase();
        if (['script', 'style', 'noscript'].includes(tag)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let nd;
    while ((nd = walker.nextNode())) nodes.push(nd);

    // カタカナ（ァ-ヶ: U+30A1-U+30F6）→ ひらがな（ぁ-ゖ: U+3041-U+3096）
    nodes.forEach(n => {
      const orig = n.textContent;
      const conv = orig.replace(/[\u30A1-\u30F6]/g, c =>
        String.fromCharCode(c.charCodeAt(0) - 0x60)
      );
      if (conv !== orig) n.textContent = conv;
    });
    kanaConverted = true;
  }

  // ==================
  // ガイドボタン状態更新（有効=青 / 無効=灰）
  // ==================
  function updateGuideButtonState() {
    const guide = document.getElementById('egov-ext-guide');
    if (!guide) return;
    if (extensionEnabled) {
      guide.classList.remove('egov-ext-disabled');
    } else {
      guide.classList.add('egov-ext-disabled');
    }
  }

  // ==================
  // ショートカットガイドボタン（右下に常駐）
  // ==================
  function addShortcutGuide() {
    injectHighlightStyles();
    if (!document.querySelector('#provisionview')) return;
    if (document.getElementById('egov-ext-guide')) return;

    const guide = document.createElement('div');
    guide.id = 'egov-ext-guide';
    guide.innerHTML = `
      <button class="egov-ext-guide-btn" title="クリックでショートカット有効/無効を切り替え" aria-label="キーボードショートカット一覧">⌨️</button>
      <div class="egov-ext-guide-tooltip" role="tooltip">
        <div class="egov-ext-guide-title">キーボードショートカット</div>
        <table class="egov-ext-guide-table">
          <tr><td><kbd>0</kbd>〜<kbd>9</kbd></td>
              <td>条文ジャンプ<br>
                <span class="egov-ext-guide-sub"><kbd>.</kbd>で項・号（3.2.1=第3条第2項第1号）</span></td></tr>
          <tr><td><kbd>h</kbd> / <kbd>l</kbd></td>
              <td>ジャンプ履歴を前後に移動</td></tr>
          <tr><td><kbd>n</kbd> / <kbd>p</kbd></td>
              <td>次/前の条文を画面上端に表示</td></tr>
          <tr><td><kbd>d</kbd> / <kbd>u</kbd></td>
              <td>下/上へ80%スクロール</td></tr>
          <tr><td><kbd>s</kbd></td>
              <td>ページ内検索<br>
                <span class="egov-ext-guide-sub">Ctrl+Enter=現在位置から検索</span></td></tr>
          <tr><td><kbd>r</kbd></td>
              <td>現在の法令名で法令検索（別タブで開く）</td></tr>
          <tr><td><kbd>c</kbd></td>
              <td>条文番号の漢数字/アラビア数字の切り替え<br>
                <span class="egov-ext-guide-sub">号タイトルは丸数字（①②③）</span></td></tr>
          <tr><td><kbd>k</kbd></td>
              <td>カタカナをひらがなに変換</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>P</kbd></td>
              <td>ショートカット有効/無効の切り替え<br>
                <span class="egov-ext-guide-sub">青=有効 / 灰=無効。このボタンクリックでも切り替え可</span></td></tr>
          <tr><td><kbd>Esc</kbd></td>
              <td>ダイアログを閉じる</td></tr>
        </table>
      </div>
    `;
    document.body.appendChild(guide);

    // ガイドボタンクリックで有効/無効トグル
    guide.querySelector('.egov-ext-guide-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      extensionEnabled = !extensionEnabled;
      updateGuideButtonState();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addShortcutGuide);
  } else {
    setTimeout(addShortcutGuide, 800);
  }
})();
