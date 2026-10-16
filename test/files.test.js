// Files view: the /fs/* API (access rules, listing, search semantics) and the browser UI. Real server, headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';
import * as fsapi from '../fsapi.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);

// fixture: names chosen so sort orders differ from each other
const fx = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brick-fx-')));   // real path: the shell reports that one
const put = (rel, text, when) => { const f = path.join(fx, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); if (when) fs.utimesSync(f, when, when); };
const day = (n) => new Date(Date.UTC(2024, 0, n, 12));
put('alpha.txt', 'one foo\ntwo\n', day(3));                       // 12 bytes
put('beta.md', 'x'.repeat(5000), day(1));                         // biggest
put('gamma.js', 'const foo = 1;\n// FOO\n', day(2));
put('Zed.txt', 'tiny', day(4));
put('src/main.js', 'let foo;\nlet bar;\nfoo(foo);\n', day(5));
put('src/deep/inner.md', 'deep foo here\r\nsecond line\r\n', day(6));
put('src/deep/notes.txt', 'nothing to see\n', day(6));
put('empty/.keep', '', day(7));
put('.hidden/secret.txt', 'secret foo\n', day(8));
put('node_modules/lib/index.js', 'foo in a dependency\n', day(8));
fs.writeFileSync(path.join(fx, 'blob.bin'), Buffer.concat([Buffer.from('foo'), Buffer.alloc(100)]));
fs.symlinkSync(path.join(fx, 'src'), path.join(fx, 'link-to-src'));
fs.symlinkSync(path.join(fx, 'nope'), path.join(fx, 'broken-link'));
test.after(() => fs.rmSync(fx, { recursive: true, force: true }));

let srv, browser;
test.before(async () => {
  srv = await startServer({ port: 0, cwd: fx });
  if (hasChrome) browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
test.after(async () => { await browser?.close(); srv?.close(); });

// ---------- API ----------
const base = () => `http://127.0.0.1:${srv.port}`;
const post = (name, body, { token = srv.token, origin = base(), method = 'POST' } = {}) =>
  fetch(`${base()}/fs/${name}${token ? `?t=${token}` : ''}`, { method, headers: origin ? { origin } : {}, body: method === 'POST' ? JSON.stringify(body) : undefined });
const raw = (pathname, headers) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: srv.port, path: pathname, method: 'POST', headers }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject); req.end('{}');
});
const search = async (o) => {
  const res = await post('search', { root: fx, ...o });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
};
const names = (ev) => ev.filter((e) => e.t === 'hit').map((e) => path.relative(fx, e.path)).sort();
const matches = (ev) => ev.filter((e) => e.t === 'match').map((e) => `${path.relative(fx, e.path)}:${e.line}`).sort();
const done = (ev) => ev.find((e) => e.t === 'done');

test('fs API: refused without the token, with a wrong token, from another origin or Host; GET not allowed', async () => {
  for (const name of ['list', 'read', 'search']) {
    assert.equal((await post(name, { path: fx, root: fx, query: 'a' }, { token: '' })).status, 403);
    assert.equal((await post(name, { path: fx }, { token: 'wrong' })).status, 403);
    assert.equal((await post(name, { path: fx }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(name, { path: fx }, { origin: '' })).status, 403, 'no Origin (curl)');
    assert.equal(await raw(`/fs/${name}?t=${srv.token}`, { origin: base(), host: 'evil.example' }), 403, 'DNS rebinding');
  }
  assert.equal((await post('list', {}, { method: 'GET' })).status, 405);
});

test('fs API: list returns names, types, sizes, dates and the parent; links count as what they point to', async () => {
  const d = await (await post('list', { path: fx })).json();
  assert.equal(d.path, fx);
  assert.equal(d.parent, path.dirname(fx));
  const by = Object.fromEntries(d.entries.map((e) => [e.name, e]));
  assert.equal(by['src'].type, 'dir');
  assert.equal(by['alpha.txt'].type, 'file'); assert.equal(by['alpha.txt'].size, 12);
  assert.equal(by['alpha.txt'].mtime, day(3).getTime());
  assert.equal(by['link-to-src'].type, 'dir'); assert.equal(by['link-to-src'].link, true);
  assert.equal(by['broken-link'].broken, true);
  assert.ok(by['.hidden'], 'dotfiles are listed (the page decides whether to show them)');
  assert.equal((await post('list', { path: '/' })).status, 200);
  assert.equal((await (await post('list', { path: '/' })).json()).parent, null);
});

test('fs API: errors are explicit: relative path, missing, not a folder, ~ is expanded', async () => {
  assert.equal((await post('list', { path: 'relative/dir' })).status, 400);
  const missing = await post('list', { path: path.join(fx, 'nope') });
  assert.equal(missing.status, 404); assert.match(await missing.text(), /No such/);
  assert.equal((await post('list', { path: path.join(fx, 'alpha.txt') })).status, 400);
  assert.equal((await (await post('list', { path: '~' })).json()).path, os.homedir());
  assert.equal((await post('list', { path: `${fx}/\0x` })).status, 400);
  assert.equal((await post('search', { root: fx, query: '' })).status, 400);
  assert.equal((await post('search', { root: fx, query: '(', regex: true, mode: 'text' })).status, 400);
});

test('fs API: read returns text, flags binary files, truncates big ones, refuses folders', async () => {
  const t = await (await post('read', { path: path.join(fx, 'alpha.txt') })).json();
  assert.equal(t.text, 'one foo\ntwo\n'); assert.equal(t.binary, false); assert.equal(t.truncated, false);
  assert.equal((await (await post('read', { path: path.join(fx, 'blob.bin') })).json()).binary, true);
  put('big.txt', 'y'.repeat(600 * 1024));
  const big = await (await post('read', { path: path.join(fx, 'big.txt') })).json();
  assert.equal(big.truncated, true); assert.equal(big.text.length, 512 * 1024);
  fs.rmSync(path.join(fx, 'big.txt'));
  assert.equal((await post('read', { path: fx })).status, 400);
});

test('search names: this folder only, or all subfolders; case, glob and regex options', async () => {
  assert.deepEqual(names(await search({ mode: 'name', query: 'a' })), ['alpha.txt', 'beta.md', 'gamma.js']);
  assert.deepEqual(names(await search({ mode: 'name', query: 'main' })), [], 'not recursive: src/main.js is not found');
  assert.deepEqual(names(await search({ mode: 'name', query: 'main', recursive: true })), ['src/main.js']);
  assert.deepEqual(names(await search({ mode: 'name', query: 'ZED' })), ['Zed.txt'], 'case-insensitive by default');
  assert.deepEqual(names(await search({ mode: 'name', query: 'ZED', caseSensitive: true })), []);
  assert.deepEqual(names(await search({ mode: 'name', query: '*.md', recursive: true })), ['beta.md', 'src/deep/inner.md'], 'glob');
  assert.deepEqual(names(await search({ mode: 'name', query: '^g.*js$', regex: true })), ['gamma.js'], 'regex');
  assert.deepEqual(names(await search({ mode: 'name', query: 'deep', recursive: true })), ['src/deep'], 'folders match too');
  const hit = (await search({ mode: 'name', query: 'alpha' })).find((e) => e.t === 'hit');
  assert.equal(hit.size, 12); assert.equal(hit.type, 'file'); assert.equal(hit.mtime, day(3).getTime());
});

test('search names: hidden items and node_modules only when asked; links to folders are not followed', async () => {
  assert.deepEqual(names(await search({ mode: 'name', query: 'secret', recursive: true })), []);
  assert.deepEqual(names(await search({ mode: 'name', query: 'secret', recursive: true, hidden: true })), ['.hidden/secret.txt']);
  assert.deepEqual(names(await search({ mode: 'name', query: 'index.js', recursive: true })), []);
  assert.deepEqual(names(await search({ mode: 'name', query: 'index.js', recursive: true, hidden: true })), ['node_modules/lib/index.js']);
  assert.deepEqual(names(await search({ mode: 'name', query: 'inner', recursive: true })), ['src/deep/inner.md'], 'found once, not again through link-to-src');
});

test('search text: lines, columns, case, regex, file filter, binary files skipped, CRLF handled', async () => {
  let ev = await search({ mode: 'text', query: 'foo' });
  assert.deepEqual(matches(ev), ['alpha.txt:1', 'gamma.js:1', 'gamma.js:2'], 'this folder only, case-insensitive');
  const m = ev.find((e) => e.t === 'match' && e.path.endsWith('alpha.txt'));
  assert.equal(m.text, 'one foo'); assert.equal(m.col, 4); assert.equal(m.len, 3);
  assert.equal(done(ev).skipped, 1, 'blob.bin skipped as binary');
  ev = await search({ mode: 'text', query: 'foo', recursive: true });
  assert.deepEqual(matches(ev), ['alpha.txt:1', 'gamma.js:1', 'gamma.js:2', 'src/deep/inner.md:1', 'src/main.js:1', 'src/main.js:3']);
  assert.equal(done(ev).filesWithMatches, 4); assert.equal(done(ev).matches, 6);
  assert.deepEqual(matches(await search({ mode: 'text', query: 'foo', caseSensitive: true })), ['alpha.txt:1', 'gamma.js:1']);
  assert.deepEqual(matches(await search({ mode: 'text', query: 'f(o)+', regex: true, recursive: true, include: '*.js' })), ['gamma.js:1', 'gamma.js:2', 'src/main.js:1', 'src/main.js:3']);
  assert.deepEqual(matches(await search({ mode: 'text', query: 'foo', recursive: true, include: '*.md, *.txt' })), ['alpha.txt:1', 'src/deep/inner.md:1']);
  assert.equal(ev.find((e) => e.t === 'match' && e.path.endsWith('inner.md')).text, 'deep foo here', 'no stray \\r');
  assert.deepEqual(matches(await search({ mode: 'text', query: 'foo', recursive: true, hidden: true })).filter((x) => /hidden|node_modules/.test(x)), ['.hidden/secret.txt:1', 'node_modules/lib/index.js:1']);
});

test('search: a cancelled request stops the work on the server', async () => {
  const many = path.join(fx, 'many'); fs.mkdirSync(many);
  for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), 'x\n'.repeat(2000));
  const ac = new AbortController();
  const res = await fetch(`${base()}/fs/search?t=${srv.token}`, { method: 'POST', headers: { origin: base() }, signal: ac.signal, body: JSON.stringify({ root: many, query: 'x', mode: 'text' }) });
  const reader = res.body.getReader(); await reader.read(); ac.abort();
  await new Promise((r) => setTimeout(r, 300));
  const ctl = new AbortController(); const seen = [];
  await fsapi.search({ root: many, query: 'nomatch', mode: 'text' }, (e) => seen.push(e), ctl.signal);   // the API itself is still healthy
  assert.equal(seen.at(-1).t, 'done');
  const early = new AbortController(); early.abort(); const e2 = [];
  await fsapi.search({ root: many, query: 'x', mode: 'text' }, (e) => e2.push(e), early.signal);
  assert.equal(e2.at(-1).aborted, true); assert.equal(e2.filter((e) => e.t === 'match').length, 0);
  fs.rmSync(many, { recursive: true });
});

// ---------- UI ----------
const t = (name, fn) => test(name, { skip: !hasChrome && 'Chrome not installed' }, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  try { await page.goto(srv.url); await ready(page); await fn(page); } finally { await page.close(); }
});
const ready = (page) => page.waitForFunction(() => window.__brick.app.tabs.every((tb) => window.__brick.leaves(tb.root).every((s) => s.cwd && s.active === null)));
const open = async (page) => { await page.click('.pane-files'); await page.waitForSelector('.fb-row'); };
const rows = (page) => page.locator('.fb-row .fb-label').allInnerTexts();
const row = (page, name) => page.locator(`.fb-row[data-path="${fx}/${name}"]`);
const find = async (page, q, { mode = 'name', rec = false, cs = false, re = false, inc = '' } = {}) => {
  await page.locator('.fb-live').setChecked(false);                // these tests press Enter themselves
  await page.click(`.fb-mode [data-m="${mode}"]`);
  await page.locator('.fb-rec').setChecked(rec); await page.locator('.fb-case').setChecked(cs); await page.locator('.fb-re').setChecked(re);
  if (mode === 'text') await page.fill('.fb-inc', inc);
  await page.fill('.fb-q', q); await page.locator('.fb-q').press('Enter');
  await page.waitForFunction(() => !document.querySelector('.fb-stop') || document.querySelector('.fb-stop').hidden);
};

t('the button and Alt+Shift+F switch a pane to the Files view and back; the shell keeps running', async (page) => {
  assert.equal(await page.locator('.files').isVisible(), false);
  await open(page);
  assert.equal(await page.locator('.pane > main.blocks').isVisible(), false, 'blocks hidden');
  assert.equal(await page.locator('.pane > footer').isVisible(), false, 'input hidden');
  assert.equal(await page.locator('.fb-path').inputValue(), fx, 'starts in the terminal folder');
  await page.keyboard.press('Alt+Shift+KeyF');
  assert.equal(await page.locator('.files').isVisible(), false);
  await page.locator('.input').first().click();
  await page.keyboard.type('echo back-in-terminal'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /back-in-terminal/.test([...document.querySelectorAll('.block')].pop()?.innerText || ''));
  await page.keyboard.press('Alt+Shift+KeyF');
  assert.equal(await page.locator('.files').isVisible(), true, 'the shortcut works from the terminal too');
  await page.click('.fb-term');
  assert.equal(await page.locator('.files').isVisible(), false);
});

t('tree: folders first, then names A-Z; sizes, dates and kinds shown; hidden items off until asked', async (page) => {
  await open(page);
  assert.deepEqual(await rows(page), ['empty', 'link-to-src', 'node_modules', 'src', 'alpha.txt', 'beta.md', 'blob.bin', 'broken-link', 'gamma.js', 'Zed.txt']);
  assert.match(await row(page, 'alpha.txt').locator('.fb-size').innerText(), /^12 B$/);
  assert.match(await row(page, 'beta.md').locator('.fb-size').innerText(), /KB/);
  assert.equal(await row(page, 'beta.md').locator('.fb-kind').innerText(), 'MD file');
  assert.equal(await row(page, 'src').locator('.fb-kind').innerText(), 'Folder');
  assert.match(await row(page, 'link-to-src').locator('.fb-kind').innerText(), /alias/);
  assert.match(await row(page, 'alpha.txt').locator('.fb-date').innerText(), /2024/);
  await page.check('.fb-hidden');
  assert.ok((await rows(page)).includes('.hidden'));
  await page.uncheck('.fb-hidden');
  assert.ok(!(await rows(page)).includes('.hidden'));
});

t('tree: folders expand in place (triangle or arrow keys) and collapse again; deeper levels are indented', async (page) => {
  await open(page);
  await row(page, 'src').locator('.fb-tw').click();
  await page.waitForSelector(`.fb-row[data-path="${fx}/src/deep"]`);
  assert.deepEqual((await rows(page)).slice(0, 7), ['empty', 'link-to-src', 'node_modules', 'src', 'deep', 'main.js', 'alpha.txt']);
  await row(page, 'src/deep').locator('.fb-tw').click();
  await page.waitForSelector(`.fb-row[data-path="${fx}/src/deep/inner.md"]`);
  const pad = (n) => row(page, n).locator('.fb-name').evaluate((e) => parseInt(e.style.paddingLeft));
  assert.ok((await pad('src/deep/inner.md')) > (await pad('src/deep')) && (await pad('src/deep')) > (await pad('src')));
  await row(page, 'src').locator('.fb-tw').click();
  assert.equal(await row(page, 'src/deep').count(), 0, 'children hidden');
  await row(page, 'src').locator('.fb-tw').click();
  assert.equal(await row(page, 'src/deep/inner.md').count(), 1, 'expansion is remembered');
  // keyboard: select empty, right expands, left collapses
  await row(page, 'empty').click();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((p) => document.querySelector(`.fb-row[data-path="${p}"] .fb-tw`).textContent === '▾', `${fx}/empty`);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('.fb-row.sel').getAttribute('data-path'), `${fx}/link-to-src`);
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('.fb-row.sel').getAttribute('data-path'), `${fx}/empty`);
});

t('navigation: double-click a folder to enter it, Up and Backspace to leave, the path box, the terminal-folder button, errors', async (page) => {
  await open(page);
  await row(page, 'src').dblclick();
  await page.waitForFunction((p) => document.querySelector('.fb-path').value === p, `${fx}/src`);
  assert.deepEqual(await rows(page), ['deep', 'main.js']);
  await page.click('.fb-up');
  await page.waitForFunction((p) => document.querySelector('.fb-path').value === p, fx);
  await row(page, 'src').click(); await page.keyboard.press('Enter');
  await page.waitForFunction((p) => document.querySelector('.fb-path').value === p, `${fx}/src`);
  await page.locator('.fb-list').focus(); await page.keyboard.press('Backspace');
  await page.waitForFunction((p) => document.querySelector('.fb-path').value === p, fx);
  await page.fill('.fb-path', `${fx}/src/deep`); await page.locator('.fb-path').press('Enter');
  await page.waitForFunction((p) => document.querySelector('.fb-path').value === p, `${fx}/src/deep`);
  await page.click('.fb-home');
  await page.waitForFunction((p) => document.querySelector('.fb-path').value === p, fx);
  await page.fill('.fb-path', `${fx}/does-not-exist`); await page.locator('.fb-path').press('Enter');
  await page.waitForFunction(() => /No such/.test(document.querySelector('.fb-status').textContent));
  assert.equal(await page.locator('.fb-status.bad').count(), 1);
  assert.ok((await rows(page)).length > 0, 'the old listing stays');
});

t('sorting: click a column header; click again to reverse; folders stay on top in the tree', async (page) => {
  await open(page);
  const files = async () => (await rows(page)).filter((n) => !['empty', 'link-to-src', 'node_modules', 'src'].includes(n));
  await page.click('.fb-h-name');                                    // already name ascending: now descending
  assert.deepEqual(await files(), ['Zed.txt', 'gamma.js', 'broken-link', 'blob.bin', 'beta.md', 'alpha.txt']);
  assert.deepEqual((await rows(page)).slice(0, 4), ['src', 'node_modules', 'link-to-src', 'empty'], 'folders first, reversed among themselves');
  await page.click('.fb-h-mtime');                                  // oldest first
  assert.deepEqual((await files()).filter((n) => /^(beta|gamma|alpha|Zed)/.test(n)), ['beta.md', 'gamma.js', 'alpha.txt', 'Zed.txt']);
  await page.click('.fb-h-mtime');
  assert.deepEqual((await files()).filter((n) => /^(beta|gamma|alpha|Zed)/.test(n)), ['Zed.txt', 'alpha.txt', 'gamma.js', 'beta.md']);
  await page.click('.fb-h-size');
  assert.equal((await files()).indexOf('beta.md'), (await files()).length - 1, 'biggest last');
  await page.click('.fb-h-size');
  assert.equal((await files())[0], 'beta.md', 'biggest first');
  await page.click('.fb-h-kind');
  const kinds = await page.locator('.fb-row .fb-kind').allInnerTexts();
  assert.deepEqual(kinds, [...kinds].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).sort((a, b) => (a.startsWith('Folder') ? 0 : 1) - (b.startsWith('Folder') ? 0 : 1)));
  assert.equal(await page.locator('.fb-h-kind .fb-arrow').innerText(), ' ▲');
  assert.equal(await page.locator('.fb-h-size .fb-arrow').count(), 0, 'one arrow, on the sort column');
});

t('columns: drag a header edge to resize (header and rows together); remembered; double-click resets', async (page) => {
  await open(page);
  const w = (sel) => page.evaluate((q) => document.querySelector(q).getBoundingClientRect().width, sel);
  const drag = async (sel, dx) => {
    const b = await page.locator(sel).boundingBox();
    const x = b.x + b.width - 1, y = b.y + b.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y, { steps: 5 }); await page.mouse.up();
  };
  const d0 = await w('.fb-h-mtime'), n0 = await w('.fb-h-name');
  await drag('.fb-h-mtime .fb-grip', -60);                           // Date's own edge: narrower
  assert.ok(Math.abs((await w('.fb-h-mtime')) - (d0 - 60)) <= 2);
  assert.ok((await w('.fb-h-name')) > n0 + 50, 'Name takes the freed space');
  assert.ok(Math.abs((await w('.fb-row .fb-date')) - (await w('.fb-h-mtime'))) <= 1, 'rows follow the header');
  await drag('.fb-h-name .fb-grip', -40);                            // Name's edge: Date grows
  assert.ok(Math.abs((await w('.fb-h-mtime')) - (d0 - 60 + 40)) <= 2);
  await drag('.fb-h-size .fb-grip', -500);                           // never below the minimum
  assert.ok((await w('.fb-h-size')) >= 39);
  const sorted = await page.locator('.fb-h-name .fb-arrow').count();
  assert.equal(sorted, 1, 'dragging a grip does not change the sort');
  assert.ok(JSON.parse(await page.evaluate(() => localStorage.getItem('brick.cols'))).mtime);
  await page.reload(); await page.waitForSelector('.fb-row');       // the Files view itself comes back too
  assert.ok(Math.abs((await w('.fb-h-mtime')) - (d0 - 20)) <= 2, 'remembered after reload');
  await page.locator('.fb-h-mtime .fb-grip').dblclick();
  assert.ok(Math.abs((await w('.fb-h-mtime')) - d0) <= 2, 'double-click resets');
});

t('reload reopens the last view: Files view on the folder it showed; back to the terminal if that was last', async (page) => {
  await open(page);
  await page.fill('.fb-path', `${fx}/src`); await page.locator('.fb-path').press('Enter');
  await page.waitForFunction((p) => JSON.parse(localStorage.getItem('brick.last') || '{}').path === p, `${fx}/src`);
  await page.reload();
  await page.waitForSelector('.fb-row');
  assert.equal(await page.inputValue('.fb-path'), `${fx}/src`);
  assert.equal(await page.locator('.pane.files-mode').count(), 1);
  await page.click('.pane-files');                                   // back to the terminal, then reload
  await page.reload();
  await page.waitForSelector('.pane');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.pane.files-mode').count(), 0);
});

t('name search: Enter finds files here; Subfolders widens it; results sort; Clear returns to the tree', async (page) => {
  await open(page);
  await find(page, 'main');
  assert.equal(await page.locator('.fb-row').count(), 0);
  assert.match(await page.locator('.fb-status').innerText(), /0 results/);
  await find(page, 'main', { rec: true });
  assert.deepEqual(await rows(page), ['src/main.js'], 'shown with the path under the searched folder');
  await find(page, '*.md', { rec: true });
  assert.deepEqual(await rows(page), ['beta.md', 'src/deep/inner.md']);
  await page.click('.fb-h-size');
  assert.deepEqual(await rows(page), ['src/deep/inner.md', 'beta.md'], 'results sort by the column headers too');
  await find(page, 'ZED', { cs: true });
  assert.equal(await page.locator('.fb-row').count(), 0);
  await find(page, 'ZED', { cs: false });
  assert.deepEqual(await rows(page), ['Zed.txt']);
  await row(page, 'Zed.txt').dblclick();
  await page.waitForSelector('.pv-l');
  assert.match(await page.locator('.fb-pv-body').innerText(), /tiny/, 'double-click a file to preview it');
  await page.click('.fb-clear');
  assert.equal(await page.locator('.fb-q').inputValue(), '');
  assert.ok((await rows(page)).includes('src'), 'back to the tree');
  assert.equal(await page.locator('.fb-preview').isVisible(), false);
});

t('text search lists hits like Notepad++: a header per file, "Line n:" rows, the match highlighted, a summary line', async (page) => {
  await open(page);
  await find(page, 'foo', { mode: 'text', rec: true });
  const title = await page.locator('.gr-title').innerText();
  assert.match(title, /Search "foo" \(6 hits in 4 files of \d+ searched/);
  assert.match(title, /1 skipped/, 'the binary file is counted as skipped, not searched');
  assert.deepEqual(await page.locator('.gr-file .gr-path').allInnerTexts(), ['alpha.txt', 'gamma.js', 'src/deep/inner.md', 'src/main.js']);
  assert.deepEqual(await page.locator('.gr-file .gr-count').allInnerTexts(), [' (1 hit)', ' (2 hits)', ' (1 hit)', ' (2 hits)']);
  assert.deepEqual(await page.locator('.gr-no').allInnerTexts(), ['Line 1:', 'Line 1:', 'Line 2:', 'Line 1:', 'Line 1:', 'Line 3:']);
  assert.deepEqual(await page.locator('.gr-line mark').allInnerTexts(), ['foo', 'foo', 'FOO', 'foo', 'foo', 'foo', 'foo'], 'every occurrence is highlighted (foo(foo) has two)');
  assert.equal(await page.locator('.fb-status').innerText(), title, 'the status line shows the summary when done');
  await page.click('.gr-btn:has-text("Collapse all")');
  assert.equal(await page.locator('.gr-line').count(), 0);
  assert.equal(await page.locator('.gr-file').count(), 4);
  await page.click('.gr-btn:has-text("Expand all")');
  assert.equal(await page.locator('.gr-line').count(), 6);
  await page.locator('.gr-file').first().click();                    // one file folds
  assert.equal(await page.locator('.gr-line').count(), 5);
});

t('text search options: this folder only, case, regex, file filter, hidden; bad regex and no hits are explained', async (page) => {
  await open(page);
  await find(page, 'foo', { mode: 'text' });
  assert.deepEqual(await page.locator('.gr-file .gr-path').allInnerTexts(), ['alpha.txt', 'gamma.js']);
  await find(page, 'foo', { mode: 'text', cs: true });
  assert.equal(await page.locator('.gr-line').count(), 2);
  await find(page, 'f(o)+\\(', { mode: 'text', rec: true, re: true, inc: '*.js' });
  assert.deepEqual(await page.locator('.gr-line').allInnerTexts().then((a) => a.map((s) => s.replace(/\s+/g, ' '))), ['Line 3: foo(foo);']);
  assert.deepEqual(await page.locator('.gr-line mark').allInnerTexts(), ['foo('], 'the highlight is the regex match');
  await find(page, 'foo', { mode: 'text', rec: true, inc: '*.md,*.txt' });
  assert.deepEqual(await page.locator('.gr-file .gr-path').allInnerTexts(), ['alpha.txt', 'src/deep/inner.md']);
  await page.check('.fb-hidden');
  await find(page, 'secret', { mode: 'text', rec: true });
  assert.deepEqual(await page.locator('.gr-file .gr-path').allInnerTexts(), ['.hidden/secret.txt'], 'Hidden includes dot folders');
  await page.uncheck('.fb-hidden');
  await find(page, 'secret', { mode: 'text', rec: true });
  assert.equal(await page.locator('.gr-none').innerText(), 'No matches.');
  await find(page, '(', { mode: 'text', re: true });
  await page.waitForFunction(() => /bad pattern/.test(document.querySelector('.fb-status').textContent));
  assert.equal(await page.locator('.fb-status.bad').count(), 1);
  assert.equal(await page.locator('.fb-stop').isVisible(), false, 'the controls recover after an error');
  assert.equal(await page.locator('.fb-go').isVisible(), true);
});

t('clicking a hit opens the file beside the list at that line, with the line marked; Esc closes it; Esc again clears the search', async (page) => {
  await open(page);
  await find(page, 'foo', { mode: 'text', rec: true });
  await page.locator('.gr-line').filter({ hasText: 'foo(foo)' }).click();
  await page.waitForSelector('.pv-l.hit');
  assert.match(await page.locator('.fb-pv-title').innerText(), /src\/main\.js$/);
  assert.equal(await page.locator('.pv-l.hit .pv-n').innerText(), '3');
  assert.match(await page.locator('.pv-l.hit').innerText(), /foo\(foo\)/);
  assert.equal(await page.locator('.pv-l.hit mark').count(), 2);
  assert.equal(await page.locator('.pv-l').count() >= 3, true);
  assert.equal(await page.locator('.gr-line.sel').count(), 1);
  await page.locator('.fb-list').focus(); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.fb-preview').isVisible(), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.gr-file').count(), 0, 'back to the tree');
  assert.ok((await rows(page)).includes('src'));
  await row(page, 'blob.bin').dblclick();
  await page.waitForFunction(() => /Binary file/.test(document.querySelector('.fb-pv-body').innerText));
});

t('Cmd/Ctrl+F focuses the search box; typing in the Files view never reaches the shell', async (page) => {
  await open(page);
  await page.locator('.fb-list').focus();
  await page.keyboard.press('Control+f');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'fb-q');
  await page.keyboard.type('zed'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.fb-go') && !document.querySelector('.fb-go').hidden);
  assert.deepEqual(await rows(page), ['Zed.txt']);
  assert.equal(await page.locator('.block').count(), 0, 'nothing was typed into the terminal');
});

t('cd here sends cd to the shell and returns to the terminal; every pane has its own Files view', async (page) => {
  await open(page);
  await row(page, 'src').dblclick();
  await page.waitForFunction((p) => document.querySelector('.fb-path').value === p, `${fx}/src`);
  await page.click('.fb-cd');
  assert.equal(await page.locator('.files').isVisible(), false);
  await page.waitForFunction((p) => window.__brick.session.cwd === p, `${fx}/src`);
  // a second pane stays a terminal while the first is a browser
  await page.click('#split-right'); await page.waitForFunction(() => window.__brick.app.panes().length === 2); await ready(page);
  await page.locator('.pane').first().locator('.pane-files').click();
  assert.equal(await page.locator('.files:visible').count(), 1);
  assert.equal(await page.locator('.pane').nth(1).locator('.input').isVisible(), true);
});

t('the Files view works with the other features: looks, dragging the pane, peek of a tab, closing', async (page) => {
  await open(page);
  await row(page, 'src').locator('.fb-tw').click();
  await page.click('#new-tab'); await page.waitForFunction(() => window.__brick.app.tabs.length === 2); await ready(page);
  await page.evaluate(() => { window.__brick.peekDelay = 300; });
  const b = await page.locator('#tabs .tab').first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForFunction(() => !document.querySelector('#peek').hidden, null, { timeout: 3000 });
  assert.match(await page.locator('#peek').innerText(), /alpha\.txt/, 'the peek shows the file list');
  await page.mouse.move(600, 500);
  await page.locator('#tabs .tab').first().click();
  await page.click('#appearance'); await page.click('#bg-kind [data-bg="blend"]'); await page.click('#ap-close');
  assert.equal(await page.locator('.fb-row').first().isVisible(), true, 'still readable over a picture');
  await page.locator('.tab-content:not(.hidden) .pane-close').click();
  assert.equal(await page.evaluate(() => window.__brick.app.tabs.length), 1);
});

const searchRequests = (page) => { const n = { count: 0 }; page.on('request', (r) => { if (r.url().includes('/fs/search')) n.count++; }); return n; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

t('an empty search box (Enter or just emptied) goes back to the full listing', async (page) => {
  await open(page);
  await find(page, 'main', { rec: true });
  assert.deepEqual(await rows(page), ['src/main.js']);
  await page.fill('.fb-q', ''); await page.locator('.fb-q').press('Enter');
  assert.ok((await rows(page)).includes('src') && (await rows(page)).includes('alpha.txt'), 'all files again');
  assert.equal(await page.locator('.fb-clear').isVisible(), false);
  assert.match(await page.locator('.fb-status').innerText(), /items/);
});

t('live search: on by default, fires once after a pause in typing, and emptying the box restores the listing', async (page) => {
  await open(page);
  await page.evaluate(() => { window.__brick.liveDelay = 250; });
  assert.equal(await page.locator('.fb-live').isChecked(), true);
  await page.locator('.fb-rec').check();
  const n = searchRequests(page);
  await page.locator('.fb-q').click();
  await page.keyboard.type('main');                                 // fast typing: one search, not four
  assert.equal(n.count, 0, 'nothing while typing');
  await page.waitForFunction(() => document.querySelectorAll('.fb-row').length === 1, null, { timeout: 3000 });
  assert.deepEqual(await rows(page), ['src/main.js']);
  assert.equal(n.count, 1);
  await page.locator('.fb-q').fill('');                              // what deleting all the text does
  await page.waitForFunction(() => document.querySelectorAll('.fb-row').length > 5, null, { timeout: 3000 });
  assert.ok((await rows(page)).includes('alpha.txt'), 'back to the listing without pressing Enter');
  assert.equal(n.count, 1, 'clearing needs no search');
  assert.equal(await page.locator('.fb-q').evaluate((e) => e === document.activeElement), true, 'focus stays in the box');
});

t('live search can be switched off (remembered): then only Enter or the button searches', async (page) => {
  await open(page);
  await page.evaluate(() => { window.__brick.liveDelay = 150; });
  await page.locator('.fb-live').uncheck();
  const n = searchRequests(page);
  await page.locator('.fb-q').click(); await page.keyboard.type('alpha');
  await sleep(600);
  assert.equal(n.count, 0);
  assert.ok((await rows(page)).length > 5, 'still the full listing');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.fb-row').length === 1);
  assert.equal(n.count, 1);
  await page.reload(); await ready(page); await page.waitForSelector('.fb-row');
  assert.equal(await page.locator('.fb-live').isChecked(), false, 'remembered');
  await page.locator('.fb-live').check();
  await page.reload(); await ready(page); await page.waitForSelector('.fb-row');
  assert.equal(await page.locator('.fb-live').isChecked(), true);
});

t('live search: text needs two characters; changing an option or the mode re-runs the search', async (page) => {
  await open(page);
  await page.evaluate(() => { window.__brick.liveDelay = 150; });
  await page.click('.fb-mode [data-m="text"]');
  const n = searchRequests(page);
  await page.locator('.fb-q').click(); await page.keyboard.type('f');
  await sleep(500);
  assert.equal(n.count, 0, 'one letter is too broad for text');
  await page.keyboard.type('oo');
  await page.waitForFunction(() => /\d+ hits? in/.test(document.querySelector('.gr-title')?.textContent || ''));
  assert.deepEqual(await page.locator('.gr-file .gr-path').allInnerTexts(), ['alpha.txt', 'gamma.js']);
  await page.locator('.fb-rec').check();                            // wider search without pressing anything
  await page.waitForFunction(() => document.querySelectorAll('.gr-file').length === 4);
  await page.waitForFunction(() => /6 hits in 4 files/.test(document.querySelector('.gr-title').textContent));
  await page.locator('.fb-case').check();
  await page.waitForFunction(() => /5 hits in 4 files/.test(document.querySelector('.gr-title').textContent), null, { timeout: 3000 });
  await page.fill('.fb-inc', '*.md');
  await page.waitForFunction(() => document.querySelectorAll('.gr-file').length === 1 || /No matches/.test(document.body.innerText), null, { timeout: 3000 });
  await page.fill('.fb-inc', '');
  await page.click('.fb-mode [data-m="name"]');
  await page.waitForFunction(() => document.querySelectorAll('.gr-file').length === 0 && /Names matching/.test(document.querySelector('.fb-status').textContent), null, { timeout: 3000 });
});

t('legible over a picture: text sits on a dark blurred scrim (rows, headers, labels, status, preview, hits)', async (page) => {
  await open(page);
  await page.click('#appearance'); await page.click('#bg-kind [data-bg="blend"]'); await page.click('#ap-close');
  const scrim = (sel) => page.locator(sel).first().evaluate((el) => { const c = getComputedStyle(el); const m = c.backgroundColor.match(/rgba?\(([^)]+)\)|color\(srgb ([^)]+)\)/); const a = m ? Number(((m[1] || m[2]).split(/[, /]+/))[3] ?? 1) : 0; return { blur: (c.backdropFilter || c.webkitBackdropFilter).includes('blur'), alpha: a }; });
  for (const sel of ['.fb-row', '.fb-head', '.fb-status', '.fb-bar label', '.fb-search label', '.fb-mode']) {
    const r = await scrim(sel);
    assert.ok(r.blur && r.alpha >= 0.4, `${sel} ${JSON.stringify(r)}`);
  }
  await find(page, 'foo', { mode: 'text', rec: true });
  await page.locator('.gr-line').first().click(); await page.waitForSelector('.pv-l');
  for (const sel of ['.gr-file', '.gr-line', '.fb-pv-body', '.fb-pv-head', '.pane-head']) {
    const r = await scrim(sel);
    assert.ok(r.blur && r.alpha >= 0.4, `${sel} ${JSON.stringify(r)}`);
  }
  assert.ok((await scrim('.fb-q')).alpha >= 0.4, 'the search box is dark too');
  assert.ok(await page.locator('.files').evaluate((el) => getComputedStyle(el).getPropertyValue('--dim').trim() !== '#7d8594'), 'dim text is brighter here');
});
