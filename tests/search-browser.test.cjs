const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('popup keeps latest results and clearing input invalidates an in-flight search', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} };
    window.chrome = { storage: { local: storage, session: storage, onChanged: { addListener() {} } },
      runtime: { getURL: file => `https://extension.test/${file}`, sendMessage: async () => ({}), openOptionsPage: async () => {} },
      tabs: { create: async () => {} } };
    window.requests = [];
    window.fetch = (url, options) => new Promise(resolve => requests.push({ query: new URL(url).searchParams.get('law_title'), options, resolve }));
    window.finishSearch = query => {
      const entry = requests.find(request => request.query === query);
      entry.resolve(new Response(JSON.stringify({ laws: [{ law_info: { law_id: query, law_num: '', law_type: 'Act' }, revision_info: { law_title: query + ' result' } }] })));
    };
  });
  await page.route('**/*', route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    const contentType = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    return route.fulfill({ body: fs.readFileSync(path.join(__dirname, '..', file)), contentType });
  });
  await page.goto('https://extension.test/popup.html');
  await page.locator('#searchInput').fill('old');
  await page.waitForFunction(() => requests.length === 1);
  await page.locator('#searchInput').fill('new');
  await page.waitForFunction(() => requests.length === 2);
  await page.evaluate(() => finishSearch('new'));
  await page.waitForFunction(() => document.querySelector('#searchResults').textContent.includes('new result'));
  await page.evaluate(() => finishSearch('old'));
  assert.match(await page.locator('#searchResults').innerText(), /new result/);
  assert.doesNotMatch(await page.locator('#searchResults').innerText(), /old result/);
  await page.locator('#searchInput').fill('later');
  await page.waitForFunction(() => requests.length === 3);
  await page.locator('#searchInput').fill('');
  await page.evaluate(() => finishSearch('later'));
  assert.doesNotMatch(await page.locator('#searchResults').innerText(), /later result/);
  // Chrome can emit a final input immediately after compositionend.
  await page.locator('#searchInput').evaluate(input => {
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value = '法';
    input.dispatchEvent(new CompositionEvent('compositionend', { data: '法' }));
    input.dispatchEvent(new InputEvent('input', { data: '法' }));
  });
  await page.waitForFunction(() => requests.length === 4);
  await page.evaluate(() => finishSearch('法'));
  await page.waitForFunction(() => document.querySelector('#searchResults').textContent.includes('法 result'));
  assert.equal(await page.evaluate(() => requests.filter(request => request.query === '法').length), 1);
  await page.locator('#searchInput').fill('manual');
  await page.locator('#searchInput').press('Enter');
  await page.waitForFunction(() => requests.length === 5);
  await page.evaluate(() => finishSearch('manual'));
  await page.waitForFunction(() => document.querySelector('#searchResults').textContent.includes('manual result'));
  // Check after the canceled debounce would have fired.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
  assert.equal(await page.evaluate(() => requests.length), 5);
  assert.deepEqual(errors, []);
});
