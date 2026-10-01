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
    renderLawXml, clearLiteDefinitionTooltips, applyLiteDefinitionTooltips,
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

async function openViewer(t, baseline = false) {
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
  await page.goto('https://lite.test/viewer.html?lawId=123456789012');
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
