// Requires Playwright and an installed Chrome (or LITE_BROWSER_EXECUTABLE).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.LITE_BROWSER_EXECUTABLE
    ? { executablePath: process.env.LITE_BROWSER_EXECUTABLE } : { channel: 'chrome' }) });
});
after(async () => { await browser?.close(); });

const hooks = `
  globalThis.liteTest = {
    loadLaw, renderLawXml, clearLiteDefinitionTooltips, applyLiteDefinitionTooltips,
    forceDownload: () => forceLiteDownload,
    renderLiteArticleBookmarkGutters, getLiteBookmarkProvisionItems, toggleLiteArticleBookmark,
    extract() {
      let result = extractDefinitions();
      if (typeof result.next === 'function') {
        let step;
        do { step = result.next(); } while (!step.done);
        result = step.value;
      }
      return Array.from(result.values()).map(({ term, definition, key, sourceType }) => ({ term, definition, key, sourceType }));
    },
    state: () => ({ terms: [...liteDefinitionMap.keys()], generation: liteDefinitionGeneration }),
    setEnabled(value) { liteDefTooltipEnabled = value; if (!value) clearLiteDefinitionTooltips(); },
    references() {
      const articles = [...contentEl.querySelectorAll('.law-article[data-article-num]')];
      const index = typeof createLiteRelativeReferenceIndex === 'function'
        ? createLiteRelativeReferenceIndex(articles) : articles;
      return [...contentEl.querySelectorAll('.law-text')].flatMap(el => {
        const node = el.firstChild;
        return ['条', '項', '号'].flatMap(unit => [-3,-2,-1,1,2].map(offset =>
          getLiteRelativeReferenceHref(node, unit, offset, index, '2', '1')));
      });
    },
    candidateBuilds: 0,
  };
  const originalBuildCandidates = buildDefinitionSourceCandidates;
  buildDefinitionSourceCandidates = (...args) => {
    liteTest.candidateBuilds++;
    return originalBuildCandidates(...args);
  };
`;

async function openViewer(t, baseline = false, query = 'lawId=123456789012') {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => {
    const listeners = [];
    const stored = {};
    window.failStorageWrite = false;
    window.chrome = {
      runtime: { getURL: file => `https://lite.test/${file}`, sendMessage: async () => ({}), openOptionsPage: async () => {} },
      storage: { onChanged: { addListener: listener => listeners.push(listener) }, local: {
        get: async () => ({ ...stored }),
        set: async updates => {
          if (window.failStorageWrite) throw new Error('storage unavailable');
          const changes = {};
          for (const [key, value] of Object.entries(updates)) {
            changes[key] = { oldValue: stored[key], newValue: value };
            stored[key] = value;
          }
          listeners.forEach(listener => listener(changes, 'local'));
        }, remove: async () => {},
      } },
    };
    window.idleQueue = [];
    window.requestIdleCallback = callback => { idleQueue.push(callback); return idleQueue.length; };
    window.flushIdle = (limit = 1000) => {
      let count = 0;
      while (idleQueue.length && count < limit) {
        idleQueue.shift()({ timeRemaining: () => 0, didTimeout: true });
        count++;
      }
      return count;
    };
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://lite.test') return route.abort();
    const file = url.pathname.slice(1);
    if (!file || file.includes('..')) return route.abort();
    let body = fs.readFileSync(path.join(root, file));
    if (file === 'viewer.js') {
      if (baseline) body = fs.readFileSync(process.env.LITE_BASELINE_SOURCE);
      body = body.toString().replace('  loadLaw();', hooks);
    }
    const contentType = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    await route.fulfill({ body, contentType });
  });
  await page.goto(`https://lite.test/viewer.html?${query}`);
  await page.waitForFunction(() => !!window.liteTest);
  return page;
}

function fixture(count = 60, term = '検査対象') {
  const paragraph = (n, text, items = '') => `<Paragraph Num="${n}"><ParagraphNum>${n}</ParagraphNum><ParagraphSentence><Sentence>${text}</Sentence></ParagraphSentence>${items}</Paragraph>`;
  const item = n => `<Item Num="${n}"><ItemTitle>${n}</ItemTitle><ItemSentence><Sentence>前二号及び${term}</Sentence></ItemSentence><Subitem1 Num="1"><Subitem1Title>イ</Subitem1Title><Subitem1Sentence><Sentence>例示本文</Sentence></Subitem1Sentence></Subitem1></Item>`;
  const article = (n, text) => `<Article Num="${n}"><ArticleTitle>第${n}条</ArticleTitle>${paragraph(1, text, [1,2,3].map(item).join(''))}${paragraph(2, '前条第二項第一号及び次条')}${paragraph(3, '前二項による')}</Article>`;
  return `<Law><LawNum>試験規則</LawNum><LawBody><LawTitle>試験用法令</LawTitle><MainProvision>${Array.from({ length: count }, (_, n) => article(n + 1,
    n === 0 ? `この規則において「${term}」とは、検査を受ける物をいう。` : `${term}は前条及び前二条による。`)).join('')}</MainProvision><SupplProvision>${article(1, '附則本文')}${article(2, '前条による')}</SupplProvision><SupplProvision>${article(1, '別の附則')}${article(2, '前条による')}</SupplProvision></LawBody></Law>`;
}

test('Lite update warning compares displayed XML revision after rendering and clears on a new load', async t => {
  const law = '405AC0000000088';
  const oldRevision = `${law}_20250401_507AC0000000001`;
  const currentRevision = `${law}_20260401_508AC0000000001`;
  const page = await openViewer(t, false, `lawId=${law}`);
  await page.evaluate(({ oldRevision, currentRevision, xml }) => {
    window.shownRevision = oldRevision;
    window.checks = [];
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'egov-load-lite-law') return { ok: true, xmlText: xml, currentRevisionId: shownRevision,
        revisions: [], downloadedAt: Date.now(), cacheTarget: message.lawId };
      if (message.type === 'egov-check-law-update') {
        checks.push({ revision: message.displayedRevision, rendered: !!document.querySelector('.law-article') });
        return { ok: true, updated: message.displayedRevision !== currentRevision, latestRevision: currentRevision };
      }
      return {};
    };
  }, { oldRevision, currentRevision, xml: fixture(3) });
  await page.evaluate(() => liteTest.loadLaw());
  const button = page.locator('#lite-redownload-button');
  await page.waitForFunction(() => document.getElementById('lite-redownload-button').classList.contains('has-law-update'));
  assert.equal(await button.getAttribute('title'), '法令に更新があります');
  assert.deepEqual(await page.evaluate(() => checks), [{ revision: oldRevision, rendered: true }]);
  await page.screenshot({ path: path.join(root, 'tmp/lite-law-update-warning.png') });
  await page.evaluate(revision => { shownRevision = revision; return liteTest.loadLaw(); }, currentRevision);
  await page.waitForFunction(() => checks.length === 2);
  assert.equal(await button.getAttribute('title'), '法令ファイルの再取得');
  assert.equal(await button.evaluate(node => node.classList.contains('has-law-update')), false);
  assert.match(await page.locator('#lite-cache-date').innerText(), /^法令ファイル取得日時：/);
});

test('Lite explicitly selected historical version never requests an update check', async t => {
  const law = '405AC0000000088';
  const revision = `${law}_20250401_507AC0000000001`;
  const page = await openViewer(t, false, `lawId=${law}&revisionId=${revision}`);
  await page.evaluate(({ xml, revision }) => {
    window.updateChecks = 0;
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'egov-check-law-update') updateChecks++;
      return { ok: true, xmlText: xml, currentRevisionId: revision, revisions: [], downloadedAt: Date.now() };
    };
  }, { xml: fixture(2), revision });
  await page.evaluate(async () => {
    await liteTest.loadLaw();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await page.evaluate(() => updateChecks), 0);
  assert.equal(await page.locator('#lite-redownload-button').getAttribute('title'), '法令ファイルの再取得');
});

test('supplementary scopes are indexed once per XML document without serializing the body', async t => {
  const page = await openViewer(t);
  const result = await page.evaluate(() => {
    let scans = 0;
    const original = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function(selector) {
      if (selector === 'SupplProvision') scans++;
      return original.call(this, selector);
    };
    const serialize = XMLSerializer.prototype.serializeToString;
    XMLSerializer.prototype.serializeToString = () => { throw new Error('unnecessary XML serialization'); };
    try {
      const provisions = Array.from({ length: 100 }, (_, index) =>
        `<SupplProvision><SupplProvisionLabel>附則${index}</SupplProvisionLabel>` +
        '<Article Num="1"><ArticleTitle>第一条</ArticleTitle><Paragraph Num="1"><ParagraphSentence><Sentence>本文</Sentence></ParagraphSentence></Paragraph></Article></SupplProvision>').join('');
      liteTest.renderLawXml(`<Law><LawBody><LawTitle>試験</LawTitle>${provisions}</LawBody></Law>`);
      const articles = [...document.querySelectorAll('.law-article')];
      return { scans, count: articles.length, first: articles[0].dataset.referenceScope, last: articles.at(-1).dataset.referenceScope };
    } finally {
      Document.prototype.querySelectorAll = original;
      XMLSerializer.prototype.serializeToString = serialize;
    }
  });
  assert.deepEqual(result, { scans: 1, count: 100, first: 'Sp', last: 'Sp_100' });
});

function definitionFixture() {
  const texts = [
    'この規則において「検査対象」とは、検査を受ける物をいう。',
    '申請書類（以下「書類」という。）を提出する。',
    '担当職員（事務を担当する職員をいう。以下同じ。）が確認する。',
    '用語の意義は、当該各号に定めるところによる。',
    '検査対象、書類、担当職員及び申請者について定める。',
  ];
  return `<Law><LawBody><LawTitle>定義の試験</LawTitle><MainProvision>${texts.map((text, n) =>
    `<Article Num="${n + 1}"><ArticleTitle>第${n + 1}条</ArticleTitle><Paragraph Num="1"><ParagraphSentence><Sentence>${text}</Sentence></ParagraphSentence>${n === 3
      ? '<Item Num="1"><ItemTitle>一</ItemTitle><ItemSentence><Sentence>申請者　申請をする者</Sentence></ItemSentence></Item>' : ''}</Paragraph></Article>`).join('')}</MainProvision></LawBody></Law>`;
}

test('definition candidates are collected only for matching articles', async t => {
  const page = await openViewer(t);
  await page.evaluate(xml => liteTest.renderLawXml(xml), fixture());
  const result = await page.evaluate(() => ({ definitions: liteTest.extract(), candidates: liteTest.candidateBuilds }));
  assert.equal(result.candidates, 1);
  assert.deepEqual(result.definitions.map(({ term, key, sourceType }) => ({ term, key, sourceType })),
    [{ term: '検査対象', key: '1.1', sourceType: 'patternA' }]);
});

test('all four definition patterns survive deferred candidate creation', async t => {
  const page = await openViewer(t);
  await page.evaluate(xml => liteTest.renderLawXml(xml), definitionFixture());
  const definitions = await page.evaluate(() => liteTest.extract());
  assert.deepEqual(definitions.map(d => d.sourceType).sort(), ['patternA', 'patternB', 'patternC', 'patternD']);
  assert.ok(definitions.every(d => d.definition && d.key));
});

test('definition extraction yields, cancels on disable, and discards old law work', async t => {
  const page = await openViewer(t);
  await page.evaluate(xml => liteTest.renderLawXml(xml), fixture());
  const intermediate = await page.evaluate(() => {
    flushIdle(2);
    return { terms: liteTest.state().terms, pending: idleQueue.length };
  });
  assert.deepEqual(intermediate.terms, []);
  assert.ok(intermediate.pending > 0);
  await page.evaluate(() => { liteTest.setEnabled(false); flushIdle(); });
  assert.deepEqual(await page.evaluate(() => liteTest.state().terms), []);
  await page.evaluate(() => { liteTest.setEnabled(true); liteTest.applyLiteDefinitionTooltips(); flushIdle(1); });
  await page.evaluate(xml => { liteTest.renderLawXml(xml); flushIdle(); }, fixture(4, '更新対象'));
  assert.deepEqual(await page.evaluate(() => liteTest.state().terms), ['更新対象']);
  const definitionButton = page.locator('#definition-links-button');
  await page.keyboard.press('Alt+d');
  assert.equal(await definitionButton.getAttribute('aria-pressed'), 'false');
  assert.equal(await definitionButton.getAttribute('title'), '定義参照を有効化（ALT+D）');
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get()).liteDefTooltipEnabled), false);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', altKey: true, repeat: true, bubbles: true, cancelable: true })));
  assert.equal(await definitionButton.getAttribute('aria-pressed'), 'false');
  await page.keyboard.press('Alt+d');
  assert.equal(await definitionButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await definitionButton.getAttribute('title'), '定義参照を無効化（ALT+D）');
});

test('external bookmark changes preserve buttons and focus; failed save rolls back', async t => {
  const page = await openViewer(t);
  await page.evaluate(xml => liteTest.renderLawXml(xml), fixture(4));
  const result = await page.evaluate(async () => {
    await liteTest.renderLiteArticleBookmarkGutters();
    const buttons = [...document.querySelectorAll('.lite-bookmark-gutter')];
    const target = buttons[0];
    const item = liteTest.getLiteBookmarkProvisionItems().find(item => item.targetKey === target.dataset.bookmarkTargetKey);
    target.focus();
    let observedMutations = 0;
    const observer = new MutationObserver(records => { observedMutations += records.length; });
    observer.observe(document.querySelector('#law-content'), { childList: true, subtree: true });
    await chrome.storage.local.set({ articleBookmarks: [{ lawId: '123456789012', targetKey: item.targetKey }] });
    await Promise.resolve();
    const preserved = buttons.every((button, i) => button === document.querySelectorAll('.lite-bookmark-gutter')[i]);
    const focused = document.activeElement === target;
    const marked = target.classList.contains('is-bookmarked');
    const replacedNodes = observedMutations + observer.takeRecords().length;
    observer.disconnect();
    window.failStorageWrite = true;
    const saved = await liteTest.toggleLiteArticleBookmark(item);
    return { preserved, focused, marked, replacedNodes, saved, rolledBack: target.classList.contains('is-bookmarked') };
  });
  assert.deepEqual(result, { preserved: true, focused: true, marked: true, replacedNodes: 0, saved: false, rolledBack: true });
});

test('relative references stay within main/supplementary provisions', async t => {
  const page = await openViewer(t);
  await page.evaluate(xml => liteTest.renderLawXml(xml), fixture(4));
  const links = await page.evaluate(() => [...document.querySelectorAll('.law-article[data-article-num="2"]')]
    .map(article => ({ scope: article.dataset.referenceScope || '',
      href: article.querySelector('a')?.getAttribute('href') })));
  assert.equal(links.length, 3);
  assert.ok(links[0].href.endsWith('#Mp-At_1'));
  assert.ok(links[1].href.endsWith('#123456789012-Sp-At_1'));
  assert.ok(links[2].href.endsWith('#123456789012-Sp_2-At_1'));
});

test('repeated paragraph/item references scan each parent only once', async t => {
  const page = await openViewer(t);
  await page.evaluate(xml => liteTest.renderLawXml(xml), fixture(4));
  const counts = await page.evaluate(() => {
    const original = Element.prototype.querySelectorAll;
    const reads = new Map();
    Element.prototype.querySelectorAll = function(selector) {
      if (selector === '.law-paragraph[data-paragraph-num]' ||
          selector === '.law-item[data-item-num], .law-subitem[data-item-num]') {
        reads.set(this, (reads.get(this) || 0) + 1);
      }
      return original.call(this, selector);
    };
    try { liteTest.references(); } finally { Element.prototype.querySelectorAll = original; }
    return [...reads.values()];
  });
  assert.ok(counts.length > 0);
  assert.ok(counts.every(count => count === 1));
});

test('lazy definition marking still produces a usable tooltip', async t => {
  const page = await openViewer(t);
  await page.evaluate(xml => { liteTest.renderLawXml(xml); flushIdle(); }, fixture(4));
  await page.waitForFunction(() => {
    flushIdle();
    return document.querySelector('.lite-defined-term[data-term="検査対象"]');
  });
  await page.locator('.lite-defined-term[data-term="検査対象"]').first().click();
  await page.waitForFunction(() => document.querySelector('.lite-definition-tooltip')?.textContent.includes('検査を受ける物'));
});

test('before/after comparison of all relative targets and definitions', {
  skip: !process.env.LITE_BASELINE_SOURCE && 'Set LITE_BASELINE_SOURCE to compare a saved pre-change viewer.js',
}, async t => {
  const current = await openViewer(t);
  const previous = await openViewer(t, true);
  const snapshot = page => page.evaluate(() => ({
    definitions: liteTest.extract(), references: liteTest.references(),
    links: [...document.querySelectorAll('#law-content a')].map(a => a.getAttribute('href')),
  }));
  const fixtures = [fixture(12), definitionFixture(), ...[
    'criminal-procedure.xml', 'civil-procedure.xml', 'court-rule-40af73bc8802.xml',
  ].map(file => fs.readFileSync(path.join(root, 'data', 'court-rules', file), 'utf8'))];
  for (const xml of fixtures) {
    for (const page of [current, previous]) await page.evaluate(xml => liteTest.renderLawXml(xml), xml);
    assert.deepEqual(await snapshot(current), await snapshot(previous));
  }
});


test('Lite download date and refresh button work in the real viewer, including compare layout', async t => {
  const page = await openViewer(t);
  const downloadedAt = Date.now() - 2 * 86400000;
  await page.evaluate(async ({ xmlText, downloadedAt }) => {
    chrome.runtime.sendMessage = async () => ({ ok: true, xmlText, downloadedAt, revisions: [] });
    await liteTest.loadLaw();
  }, { xmlText: fixture(3), downloadedAt });
  assert.match(await page.locator('#lite-cache-date').innerText(), /法令ファイル取得日時：/);
  assert.match(await page.locator('#law-title').innerText(), /^試験用法令/);
  await page.evaluate(() => { document.body.dataset.compareMode = 'on'; });
  const sizes = await page.evaluate(() => {
    const footer = document.querySelector('#lite-cache-status').getBoundingClientRect();
    const main = document.querySelector('.viewer-shell').getBoundingClientRect();
    return { footerTop: footer.top, mainBottom: main.bottom, footerBottom: footer.bottom, height: innerHeight };
  });
  assert.ok(sizes.footerTop >= sizes.mainBottom - 1);
  assert.ok(sizes.footerBottom <= sizes.height + 1);
  await page.setViewportSize({ width: 390, height: 760 });
  assert.ok(await page.locator('#lite-redownload-button').isVisible());
  await page.screenshot({ path: path.join(root, 'tmp/lite-cache-mobile.png'), fullPage: true });
  await Promise.all([page.waitForEvent('domcontentloaded'), page.locator('#lite-redownload-button').click()]);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('egov-lite-cache-force')), null);
  assert.equal(await page.evaluate(() => liteTest.forceDownload()), true);
  await page.reload();
  assert.equal(await page.evaluate(() => liteTest.forceDownload()), false);
});
