const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const lawId = '129AC0000000089';
const favorite = { lawId, lawName: '民法', lawNum: '', lawType: 'Act', folderId: null, shortcut: 'MIN12' };
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function open(t, mode = '', extra = {}, target = 'popup') {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(({ mode, favorite, extra }) => {
    window.data = { favorites: [favorite], openedLawHistory: [favorite], ...extra };
    window.opened = [];
    window.requests = [];
    window.close = () => {};
    const listeners = [];
    window.chrome = {
      storage: {
        local: {
          get: async () => data,
          set: async items => {
            if (window.failWrites) throw new Error('保存に失敗');
            const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { newValue: value }]));
            data = { ...data, ...items };
            for (const listener of listeners) listener(changes, 'local');
          },
        },
        session: { get: async () => ({ requestedPopupMode: mode }), remove: async () => {} },
        onChanged: { addListener: listener => listeners.push(listener) },
      },
      runtime: { getURL: file => `https://extension.test/${file}`, sendMessage: async () => ({}), openOptionsPage: async () => {} },
      tabs: { create: async item => opened.push(item) },
    };
    window.fetch = async url => {
      requests.push(url);
      return new Response(JSON.stringify({ laws: [] }));
    };
  }, { mode, favorite, extra });
  await page.route('https://extension.test/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/law/')) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!DOCTYPE html><meta charset="UTF-8"><h1 class="appid">民法</h1><footer><div id="egov-normal-cache-actions"></div></footer><script src="/shared/egov-shared.js"></script><script src="/shared/egov-app.js"></script><script src="/content-controller.js"></script><script src="/content.js"></script>' });
    }
    const file = path.resolve(root, '.' + new URL(route.request().url()).pathname);
    if (!file.startsWith(root + path.sep)) return route.abort();
    const contentType = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)];
    let body = fs.readFileSync(file);
    if (pathname === '/viewer.js') body = body.toString().replace('  loadLaw();', '  refreshFavoriteButton();');
    if (pathname === '/content.js') body = body.toString().replace('  startWhenDomReady(initializeLawPageFeatures);', '  refreshFavoriteHeaderBadge();');
    return route.fulfill({ body, contentType });
  });
  const url = target === 'normal' ? `law/${lawId}` : target === 'lite' ? `viewer.html?lawId=${lawId}` : 'popup.html';
  await page.goto(`https://extension.test/${url}`);
  if (mode) await page.waitForFunction(() => document.getElementById('historyPanel').style.display === 'flex');
  return page;
}

for (const mode of ['', 'law', 'favorites']) {
  test(`launch code works with mixed case in ${mode || 'search'} mode without searching`, async t => {
    const page = await open(t, mode);
    await page.locator('#searchInput').fill('mIn12');
    assert.match(await page.locator('#modeCurrentLabel').innerText(), /お気に入り/);
    await page.waitForTimeout(450);
    assert.equal(await page.evaluate(() => requests.length), 0);
    assert.equal(await page.evaluate(() => opened.length), 0);
    assert.match(await page.locator('#shortcutStatus').innerText(), /Enter.*民法/);
    if (mode) assert.equal(await page.locator('#historyPanel').isVisible(), true);
    await page.locator('#searchInput').press('Enter');
    await page.waitForFunction(() => opened.length === 1);
    assert.match(await page.evaluate(() => opened[0].url), new RegExp(lawId));
    assert.equal(await page.evaluate(() => data.openedLawHistory[0].lawId), lawId);
    assert.equal(await page.evaluate(() => requests.length), 0);
  });
}

test('unregistered and long ASCII codes do not search or open the selected history item', async t => {
  const page = await open(t, 'law');
  for (const value of ['z', '123', 'abcdef', '123456']) {
    await page.locator('#searchInput').fill(value);
    await page.locator('#searchInput').press('Enter');
    await page.locator('.search-btn').click();
  }
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => requests.length + opened.length), 0);
  await page.locator('#searchInput').fill('民法');
  await page.waitForFunction(() => requests.length === 1);
});

test('prefix search includes collapsed folders, narrows immediately and launches the arrow-selected law', async t => {
  const other = { ...favorite, lawId: '408AC0000000109', lawName: '民事訴訟法', shortcut: 'MIN99', folderId: 'folder' };
  const page = await open(t, 'law', {
    favorites: [favorite, other, { ...favorite, lawId: 'NO_CODE', shortcut: undefined }],
    favFolders: [{ id: 'folder', name: '手続法' }], folderCollapsed: { folder: true },
  });
  const input = page.locator('#searchInput');
  await input.fill('m');
  assert.equal(await page.locator('.fav-item').count(), 2);
  await input.press('i');
  assert.equal(await page.locator('.fav-item').count(), 2);
  assert.equal(await page.locator('.fav-folder-header').count(), 0);
  await input.press('ArrowDown');
  assert.match(await page.locator('.history-item-focused').innerText(), /民事訴訟法/);
  assert.equal(await input.evaluate(el => document.activeElement === el), true);
  if (process.env.SHORTCUT_SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 360, height: 580 });
    await page.screenshot({ path: path.join(process.env.SHORTCUT_SCREENSHOT_DIR, 'shortcut-candidates.png') });
  }
  await input.press('Shift+Enter');
  await page.locator('#egov-law-shortcut-dialog').waitFor();
  assert.match(await page.locator('.shortcut-editor-law').innerText(), /民事訴訟法/);
  assert.equal(await page.evaluate(() => opened.length), 0);
  await page.locator('#egov-law-shortcut-dialog input').press('Escape');
  await input.press('Enter');
  await page.waitForFunction(() => opened.length === 1);
  assert.match(await page.evaluate(() => opened[0].url), /408AC0000000109/);
  assert.equal(await page.evaluate(() => requests.length), 0);
  assert.equal(await page.evaluate(() => data.folderCollapsed.folder), true);
});

test('editing a code after arrow navigation narrows candidates and clearing restores the list', async t => {
  const page = await open(t, '', { favorites: [favorite, { ...favorite, lawId: 'OTHER', lawName: '他の法令', shortcut: 'MIN99' }] });
  const input = page.locator('#searchInput');
  await input.fill('mi');
  await input.press('ArrowDown');
  await page.keyboard.type('n1');
  assert.equal(await input.inputValue(), 'min1');
  assert.equal(await page.locator('.fav-item').count(), 1);
  assert.match(await page.locator('.fav-item').innerText(), /民法/);
  await input.fill('');
  assert.equal(await page.locator('.fav-item').count(), 2);
  assert.equal(await page.locator('#favFolderBtn').isVisible(), true);
  await input.fill('民法');
  await page.waitForFunction(() => requests.length === 1);
  assert.equal(await page.locator('#historyPanel').isVisible(), false);
});

test('exact code comes first even when a longer prefix match was saved earlier', async t => {
  const page = await open(t, '', { favorites: [favorite, { ...favorite, lawId: 'EXACT', lawName: '完全一致', shortcut: 'MI' }] });
  await page.locator('#searchInput').fill('mi');
  assert.match(await page.locator('.fav-item').first().innerText(), /完全一致/);
  await page.locator('#searchInput').press('Enter');
  await page.waitForFunction(() => opened.length === 1);
  assert.match(await page.evaluate(() => opened[0].url), /EXACT/);
});

test('modern editor fits the popup and displays a live character count', async t => {
  const page = await open(t, 'favorites');
  await page.setViewportSize({ width: 360, height: 580 });
  await page.locator('.fav-shortcut-btn').click();
  const dialog = page.locator('#egov-law-shortcut-dialog');
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 580);
  await dialog.locator('input').fill('ab');
  assert.equal(await dialog.locator('.shortcut-editor-count').innerText(), '2 / 5');
  assert.equal(await dialog.locator('input').evaluate(el => document.activeElement === el), true);
  if (process.env.SHORTCUT_SCREENSHOT_DIR) {
    await page.screenshot({ path: path.join(process.env.SHORTCUT_SCREENSHOT_DIR, 'shortcut-editor.png') });
  }
});

test('typing from a focused list starts a code and respects Lite mode', async t => {
  const page = await open(t, 'favorites', { liteModeDefault: true });
  await page.locator('#searchInput').press('ArrowDown');
  await page.keyboard.type('min12');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => opened.length === 1);
  assert.match(await page.evaluate(() => opened[0].url), /viewer.html\?lawId=/);
  assert.equal(await page.evaluate(() => requests.length), 0);
});

for (const liteModeDefault of [false, true]) {
  test(`Ctrl+Enter opens the alternate mode from code input and filtered selection (Lite default: ${liteModeDefault})`, async t => {
    const page = await open(t, '', { liteModeDefault });
    const input = page.locator('#searchInput');
    await input.fill('min12');
    await input.press('Control+Enter');
    await page.waitForFunction(() => opened.length === 1);
    assert.equal(await page.evaluate(() => opened[0].url.includes('viewer.html')), !liteModeDefault);
    await input.fill('mi');
    await input.press('ArrowDown');
    await input.press('Control+Enter');
    await page.waitForFunction(() => opened.length === 2);
    assert.equal(await page.evaluate(() => opened[1].url.includes('viewer.html')), !liteModeDefault);
    assert.equal(await page.evaluate(() => requests.length), 0);
  });
}

test('favorite editor saves uppercase, rejects duplicates and failed writes, and clears codes', async t => {
  const page = await open(t, 'favorites', { favorites: [favorite, { ...favorite, lawId: 'OTHER', lawName: '他の法令', shortcut: 'XX' }] });
  const edit = () => page.locator('.fav-shortcut-btn').first().click();
  const input = page.locator('#egov-law-shortcut-dialog input');
  const save = page.getByRole('button', { name: '保存', exact: true });
  assert.equal(await page.evaluate(() => document.body.getBoundingClientRect().width), 360);
  await page.keyboard.press('Shift+Enter');
  await input.fill('xx');
  await save.click();
  await page.getByRole('alert').filter({ hasText: '使用されています' }).waitFor();
  assert.match(await page.getByRole('alert').innerText(), /他の法令/);
  assert.equal(await page.getByRole('button', { name: '上書きして保存', exact: true }).isVisible(), true);
  for (const invalid of ['ABCDEF', '全角', 'a-b']) {
    await input.fill(invalid);
    assert.equal(await page.getByRole('button', { name: '上書きして保存', exact: true }).isVisible(), false);
    await save.click();
    await page.getByRole('alert').filter({ hasText: '1〜5文字' }).waitFor();
  }
  await input.fill('a12z5');
  await page.evaluate(() => { window.failWrites = true; });
  await save.click();
  await page.getByRole('alert').filter({ hasText: '保存に失敗' }).waitFor();
  assert.equal(await page.evaluate(() => data.favorites[0].shortcut), 'MIN12');
  await page.evaluate(() => { window.failWrites = false; });
  await save.click();
  await page.waitForFunction(() => !document.getElementById('egov-law-shortcut-dialog'));
  assert.equal(await page.evaluate(() => data.favorites[0].shortcut), 'A12Z5');
  await edit();
  await input.fill('');
  await input.press('Enter');
  await page.waitForFunction(() => !document.getElementById('egov-law-shortcut-dialog'));
  assert.equal(await page.evaluate(() => 'shortcut' in data.favorites[0]), false);
  assert.equal(await page.locator('.fav-shortcut-btn').first().innerText(), '未設定');
  assert.equal(await page.locator('.fav-item').first().evaluate(el =>
    el.querySelector('.fav-shortcut-btn').nextElementSibling.matches('.hist-del-btn') && getComputedStyle(el.querySelector('.fav-shortcut-btn')).textAlign === 'center'), true);
  await edit();
  await input.fill('ABC');
  await input.press('Escape');
  assert.equal(await page.evaluate(() => 'shortcut' in data.favorites[0]), false);
  await edit();
  await input.fill('xx');
  await save.click();
  const overwrite = page.getByRole('button', { name: '上書きして保存', exact: true });
  await overwrite.waitFor();
  assert.equal(await page.evaluate(() => data.favorites[1].shortcut), 'XX');
  await page.evaluate(() => { window.failWrites = true; });
  await overwrite.click();
  await page.getByRole('alert').filter({ hasText: '保存に失敗' }).waitFor();
  assert.equal(await page.evaluate(() => data.favorites[1].shortcut), 'XX');
  assert.equal(await page.evaluate(() => 'shortcut' in data.favorites[0]), false);
  await page.evaluate(() => { window.failWrites = false; });
  await overwrite.click();
  await page.waitForFunction(() => !document.getElementById('egov-law-shortcut-dialog'));
  assert.equal(await page.evaluate(() => data.favorites[0].shortcut), 'XX');
  assert.equal(await page.evaluate(() => 'shortcut' in data.favorites[1]), false);
  assert.equal(await page.evaluate(() => data.favorites[1].lawName), '他の法令');

});

test('IME confirmation does not launch; a subsequent Enter does', async t => {
  const page = await open(t);
  await page.locator('#searchInput').evaluate(input => {
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value = 'min12';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionend'));
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  assert.equal(await page.evaluate(() => opened.length), 0);
  await page.locator('#searchInput').press('Enter');
  await page.waitForFunction(() => opened.length === 1);
});

for (const target of ['normal', 'lite']) {
  test(`${target} law page retains favorites without launch-code settings`, async t => {
    const page = await open(t, '', {}, target);
    const favoriteButton = page.locator(target === 'normal' ? '#egov-ext-favorite-header-badge' : '#favorite-button');
    await favoriteButton.waitFor();
    assert.equal(await page.locator('#egov-ext-law-shortcut-button, #law-shortcut-button').count(), 0);
    assert.equal(await page.evaluate(() => data.favorites[0].shortcut), 'MIN12');
    await page.evaluate(() => chrome.storage.local.set({ favorites: [] }));
    await page.waitForFunction(target => target === 'normal'
      ? document.getElementById('egov-ext-favorite-header-badge').classList.contains('is-not-favorite')
      : document.getElementById('favorite-button').textContent === '☆', target);
  });
}
