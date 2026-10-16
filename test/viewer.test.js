// Document viewer: syntax highlighting, markdown, plain/line numbers, find in file, floating windows and the tray, and the
// protections around untrusted file contents. Real server, headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);

const fx = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brick-view-')));
const put = (rel, text) => { const f = path.join(fx, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const APP_JS = '// header comment\nconst foo = require("x");\nfunction bar(a) {\n  return foo(a) + "str";\n}\n/* multi\n   line comment foo */\n';
const MD = [
  '# Title foo', '', 'Some *emphasis* and a [link](https://example.com/page) and `code foo`.', '', '- item one', '- item two', '',
  '| a | b |', '|---|---|', '| 1 | foo |', '', '```js', 'const x = 1;', '```', '',
  '<script>window.__xss = 1</script>', '<img src="x" onerror="window.__xss = 2">', '[bad](javascript:window.__xss=3)', '<b onclick="window.__xss=4">bold</b>', '',
].join('\n');
put('app.js', APP_JS);
put('tool.py', 'def f(x):\n    return x  # foo\n');
put('conf.yaml', 'name: foo\nitems:\n  - a\n');
put('data.json', '{"foo": [1, 2], "ok": true}\n');
put('run.sh', '#!/bin/bash\necho foo\n');
put('notes.txt', 'line one foo\nline two\n');
put('README.md', MD);
put('long.txt', Array.from({ length: 300 }, (_, i) => `row ${i + 1}${[5, 150, 290].includes(i + 1) ? ' needle' : ''}`).join('\n') + '\n');
put('wide.txt', 'w'.repeat(400) + '\n');
put('sub/other.txt', 'in another folder\n');
fs.writeFileSync(path.join(fx, 'blob.bin'), Buffer.concat([Buffer.from('x'), Buffer.alloc(50)]));
test.after(() => fs.rmSync(fx, { recursive: true, force: true }));

let srv, browser;
test.before(async () => {
  srv = await startServer({ port: 0, cwd: fx });
  if (hasChrome) browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
test.after(async () => { await browser?.close(); srv?.close(); });

const t = (name, fn) => test(name, { skip: !hasChrome && 'Chrome not installed' }, async () => {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  const problems = []; page.problems = problems;
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  try { await page.goto(srv.url); await ready(page); await fn(page); assert.deepEqual(problems, [], 'no CSP violations or page errors'); } finally { await page.close(); }
});
const ready = (page) => page.waitForFunction(() => window.__brick.app.tabs.every((tb) => window.__brick.leaves(tb.root).every((s) => s.cwd && s.active === null)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const row = (page, name) => page.locator(`.fb-row[data-path="${fx}/${name}"]`);
const files = async (page) => { await page.click('.pane-files'); await page.waitForSelector('.fb-row'); };
const show = async (page, name) => {   // preview a file beside the list
  await row(page, name).dblclick({ position: { x: 20, y: 8 } });   // the left edge: windows open on the right, but may be dragged anywhere
  await page.waitForFunction((name) => {
    const t = document.querySelector('.fb-pv-title')?.textContent || '', b = document.querySelector('.fb-preview .doc-body');
    return t.endsWith('/' + name) && b && b.children.length > 0 && !/Loading/.test(b.textContent);
  }, name);
};
const body = (page, scope = '.fb-preview') => page.locator(`${scope} .doc-body`);
const hl = (page, scope = '.fb-preview') => page.locator(`${scope} .doc-body [class*="hljs-"]`).count();
const rowsText = (page, scope = '.fb-preview') => page.locator(`${scope} .doc-body .pv-t`).allTextContents();
const find = async (page, q, scope = '.fb-preview') => { await page.locator(`${scope} .doc-q`).fill(q); await page.waitForTimeout(250); };
const count = (page, scope = '.fb-preview') => page.locator(`${scope} .doc-count`).innerText();
const win = (page, name) => page.locator('.vwin').filter({ has: page.locator('.vwin-title', { hasText: name }) });
const park = (page, name, x = 20, y = 560) => win(page, name).evaluate((e, [x, y]) => { e.style.left = `${x}px`; e.style.top = `${y}px`; e.style.width = '420px'; e.style.height = '200px'; }, [x, y]);   // out of the way, as a user would drag it
const popOut = async (page, name) => {
  await show(page, name);
  await page.click('.fb-pv-pop');
  await page.waitForFunction((n) => [...document.querySelectorAll('.vwin .vwin-title')].some((e) => e.textContent === n), name);
  await page.waitForFunction((n) => { const w = [...document.querySelectorAll('.vwin')].find((x) => x.querySelector('.vwin-title').textContent === n); return w && !/Loading/.test(w.querySelector('.doc-body').textContent); }, name);
};

t('syntax highlighting by file type: JavaScript, Python, YAML, JSON, shell; unknown types stay plain', async (page) => {
  await files(page);
  await show(page, 'app.js');
  assert.ok(await page.locator('.fb-preview .hljs-keyword').count() > 0, 'JavaScript keywords');
  assert.ok(await page.locator('.fb-preview .hljs-string').count() > 0);
  assert.match(await page.locator('.fb-preview .doc-foot').innerText(), /JavaScript · .* · 8 lines/);
  const commentRows = await page.locator('.fb-preview .pv-l:has(.hljs-comment)').count();
  assert.equal(commentRows, 3, 'a comment spanning two lines is coloured on both lines, plus the // comment');
  await show(page, 'tool.py'); assert.ok(await page.locator('.fb-preview .hljs-keyword').count() > 0); assert.match(await page.locator('.fb-preview .doc-foot').innerText(), /Python/);
  await show(page, 'conf.yaml'); assert.ok(await page.locator('.fb-preview .hljs-attr').count() > 0); assert.match(await page.locator('.fb-preview .doc-foot').innerText(), /YAML/);
  await show(page, 'data.json'); assert.ok(await page.locator('.fb-preview .hljs-attr').count() > 0); assert.match(await page.locator('.fb-preview .doc-foot').innerText(), /JSON/);
  await show(page, 'run.sh'); assert.ok(await hl(page) > 0); assert.match(await page.locator('.fb-preview .doc-foot').innerText(), /Bash/i);
  await show(page, 'notes.txt'); assert.equal(await hl(page), 0, 'no colouring for plain text');
  assert.match(await page.locator('.fb-preview .doc-foot').innerText(), /Plain text/);
});

t('Plain shows the text exactly as it is, Formatted brings the colours back; the choice is remembered', async (page) => {
  await files(page);
  await show(page, 'app.js');
  const formatted = await rowsText(page);
  await page.click('.fb-preview .doc-mode [data-v="plain"]');
  assert.equal(await hl(page), 0);
  assert.deepEqual(await rowsText(page), formatted, 'same text, no formatting');
  assert.equal(await page.locator('.fb-preview .doc-mode button.on').innerText(), 'Plain');
  await show(page, 'tool.py');                                     // another file keeps the choice
  assert.equal(await hl(page), 0);
  await page.reload(); await ready(page); await page.waitForSelector('.fb-row'); await show(page, 'app.js');
  assert.equal(await hl(page), 0, 'remembered across reloads');
  await page.click('.fb-preview .doc-mode [data-v="formatted"]');
  assert.ok(await hl(page) > 0);
});

t('line numbers and wrapping can be switched off and on', async (page) => {
  await files(page);
  await show(page, 'wide.txt');
  assert.equal(await page.locator('.fb-preview .pv-n').first().isVisible(), true);
  await page.uncheck('.fb-preview .doc-num');
  assert.equal(await page.locator('.fb-preview .pv-n').first().isVisible(), false);
  const ws = () => page.locator('.fb-preview .pv-t').first().evaluate((e) => getComputedStyle(e).whiteSpace);
  assert.equal(await ws(), 'pre');
  const tall = () => page.locator('.fb-preview .pv-l').first().evaluate((e) => e.getBoundingClientRect().height);
  const before = await tall();
  await page.check('.fb-preview .doc-wrap');
  assert.equal(await ws(), 'pre-wrap');
  assert.ok((await tall()) > before * 2, 'a 400-character line wraps onto several lines');
  await show(page, 'notes.txt');
  assert.equal(await page.locator('.fb-preview .pv-n').first().isVisible(), false, 'remembered for the next file');
  await page.check('.fb-preview .doc-num');
  assert.equal(await page.locator('.fb-preview .pv-n').first().isVisible(), true);
});

t('markdown is rendered (headings, emphasis, lists, tables, highlighted code); Plain shows the source', async (page) => {
  await files(page);
  await show(page, 'README.md');
  const md = page.locator('.fb-preview .md');
  assert.equal(await md.locator('h1').innerText(), 'Title foo');
  assert.equal(await md.locator('em').innerText(), 'emphasis');
  assert.equal(await md.locator('li').count(), 2);
  assert.equal(await md.locator('table th').count(), 2);
  assert.equal(await md.locator('table td').last().innerText(), 'foo');
  assert.ok(await md.locator('pre code [class*="hljs-"]').count() > 0, 'fenced code is highlighted');
  assert.equal(await page.locator('.fb-preview .doc-num').isDisabled(), true, 'line numbers make no sense for rendered text');
  assert.match(await page.locator('.fb-preview .doc-foot').innerText(), /Markdown, rendered/);
  await page.click('.fb-preview .doc-mode [data-v="plain"]');
  assert.equal(await page.locator('.fb-preview .md').count(), 0);
  assert.equal((await rowsText(page))[0], '# Title foo');
  assert.equal(await page.locator('.fb-preview .doc-num').isDisabled(), false);
});

t('markdown from a file cannot run script, load images or navigate this page', async (page) => {
  await files(page);
  // the payload really is dangerous before sanitising (otherwise the checks below prove nothing)
  const raw = await page.evaluate((md) => window.marked.parse(md), MD);
  assert.match(raw, /<script>/); assert.match(raw, /onerror=/); assert.match(raw, /javascript:/); assert.match(raw, /onclick=/);
  await show(page, 'README.md');
  await sleep(300);
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'nothing executed');
  const md = page.locator('.fb-preview .md');
  assert.equal(await md.locator('script, img, iframe, form, style').count(), 0);
  assert.equal(await md.locator('[onerror], [onclick], [style]').count(), 0);
  assert.equal(await md.locator('a[href^="javascript"]').count(), 0);
  assert.equal(await md.locator('a[href^="https://example.com"]').getAttribute('rel'), 'noopener noreferrer');
  const url = page.url();
  await md.locator('a').filter({ hasText: 'bad' }).click().catch(() => {});   // the neutered link goes nowhere
  assert.equal(page.url(), url);
  const popup = page.waitForEvent('popup', { timeout: 2000 }).catch(() => null);
  await md.locator('a[href^="https://example.com"]').click();
  assert.equal(page.url(), url, 'a web link never replaces Brick itself');
  const p = await popup; if (p) { assert.match(p.url(), /example\.com/); await p.close(); }
  assert.equal(await page.evaluate(() => window.__xss), undefined);
});

t('the page has a Content-Security-Policy: no foreign scripts, no inline scripts, no connections elsewhere', async (page) => {
  const res = await fetch(srv.url);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const msgs = [];
  page.on('console', (m) => msgs.push(m.text()));
  await page.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.append(s); });
  assert.equal(await page.evaluate(() => window.__inline), undefined, 'inline script blocked');
  const ext = await page.evaluate(() => fetch('http://example.com/').then(() => 'reached', () => 'blocked'));
  assert.equal(ext, 'blocked');
  assert.ok(msgs.some((m) => /Content Security Policy/.test(m)));
  page.problems.length = 0;   // those violations were the point of this test
});

t('find in file: counts, next/previous with wrap-around, case option, matches across highlighted tokens, clearing restores the text', async (page) => {
  await files(page);
  await show(page, 'app.js');
  const before = await rowsText(page);
  await find(page, 'foo');
  assert.equal(await count(page), '1 / 3');
  assert.equal(await page.locator('.fb-preview mark.find').count(), 3);
  assert.equal(await page.locator('.fb-preview mark.find.cur').count(), 1);
  const curRow = () => page.locator('.fb-preview mark.find.cur').first().evaluate((m) => [...m.closest('.doc-body').querySelectorAll('.pv-l')].indexOf(m.closest('.pv-l')) + 1);
  assert.equal(await curRow(), 2);
  await page.locator('.fb-preview .doc-q').press('Enter'); assert.equal(await count(page), '2 / 3'); assert.equal(await curRow(), 4);
  await page.locator('.fb-preview .doc-q').press('Enter'); assert.equal(await curRow(), 7);
  await page.locator('.fb-preview .doc-q').press('Enter'); assert.equal(await count(page), '1 / 3', 'wraps around');
  await page.locator('.fb-preview .doc-q').press('Shift+Enter'); assert.equal(await count(page), '3 / 3', 'and backwards');
  await page.click('.fb-preview .doc-prev'); assert.equal(await count(page), '2 / 3');
  await page.click('.fb-preview .doc-next'); assert.equal(await count(page), '3 / 3');
  await find(page, 'return foo');                              // "return" is a keyword span, " foo" is plain text
  assert.equal(await count(page), '1 / 1');
  assert.ok(await page.locator('.fb-preview mark.find').count() >= 2, 'one match drawn over two tokens');
  assert.equal(await page.locator('.fb-preview mark.find.cur').count(), await page.locator('.fb-preview mark.find').count(), 'all pieces of the current match are marked');
  await find(page, 'FOO');
  assert.equal(await count(page), '1 / 3', 'case-insensitive by default');
  await page.click('.fb-preview .doc-cs');
  assert.equal(await count(page), 'no match');
  assert.equal(await page.locator('.fb-preview .doc-count.none').count(), 1);
  assert.equal(await page.locator('.fb-preview mark.find').count(), 0);
  await page.click('.fb-preview .doc-cs');
  await page.locator('.fb-preview .doc-q').fill('');
  await page.waitForTimeout(250);
  assert.equal(await count(page), '');
  assert.equal(await page.locator('.fb-preview mark.find').count(), 0);
  assert.deepEqual(await rowsText(page), before, 'the text is exactly as it was');
  assert.equal(await page.locator('.fb-preview .hljs-keyword').count() > 0, true, 'and the colours survived');
});

t('find in file scrolls to the match; Enter right after typing shows the first; Esc clears; Ctrl/Cmd+F focuses the box', async (page) => {
  await files(page);
  await show(page, 'long.txt');
  await page.locator('.fb-preview .doc-body').focus();
  await page.keyboard.press('Control+f');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'doc-q', 'the viewer takes Ctrl+F, not the folder search');
  await page.keyboard.type('needle'); await page.keyboard.press('Enter');
  assert.equal(await count(page), '1 / 3');
  const inView = () => page.evaluate(() => { const b = document.querySelector('.fb-preview .doc-body').getBoundingClientRect(), m = document.querySelector('.fb-preview mark.find.cur').getBoundingClientRect(); return m.top >= b.top && m.bottom <= b.bottom; });
  assert.equal(await inView(), true);
  await page.keyboard.press('Enter'); assert.equal(await count(page), '2 / 3'); assert.equal(await inView(), true, 'row 150 scrolled into view');
  await page.keyboard.press('Enter'); assert.equal(await inView(), true, 'row 290 scrolled into view');
  assert.ok((await page.locator('.fb-preview .doc-body').evaluate((e) => e.scrollTop)) > 1000);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.fb-preview .doc-q').inputValue(), '');
  assert.equal(await page.locator('.fb-preview mark.find').count(), 0);
  assert.equal(await page.locator('.fb-preview').isVisible(), true, 'the first Esc only cleared the find box');
});

t('find works in rendered markdown (across bold/code boundaries) and survives switching between Formatted and Plain', async (page) => {
  await files(page);
  await show(page, 'README.md');
  await find(page, 'foo');
  assert.equal(await count(page), '1 / 3');
  await find(page, 'and code foo');                          // text, then a <code> element
  assert.equal(await count(page), '1 / 1');
  await find(page, 'foo');
  await page.click('.fb-preview .doc-mode [data-v="plain"]');
  assert.equal(await page.locator('.fb-preview mark.find').count() > 0, true, 'the search is applied to the other view too');
  assert.match(await count(page), /1 \/ \d+/);
  await page.click('.fb-preview .doc-mode [data-v="formatted"]');
  assert.equal(await count(page), '1 / 3');
});

t('pop out: a floating window with the same viewer; Esc/close of the pane preview does not touch it', async (page) => {
  await files(page);
  await popOut(page, 'app.js');
  assert.equal(await page.locator('.fb-preview').isVisible(), false, 'the preview beside the list closed');
  const w = win(page, 'app.js');
  assert.equal(await w.isVisible(), true);
  assert.ok(await w.locator('[class*="hljs-"]').count() > 0, 'highlighted in the window too');
  assert.match(await w.locator('.vwin-dir').innerText(), new RegExp(fx.replace(/[/.]/g, '\\$&')));
  assert.equal(await w.evaluate((e) => getComputedStyle(e).resize), 'both', 'resizable');
  await find(page, 'foo', '.vwin');
  assert.equal(await count(page, '.vwin'), '1 / 3', 'find works in the window');
  assert.equal(await page.locator('.fb-q').evaluate((e) => e === document.activeElement), false);
});

t('floating windows: drag by the title bar, raise on click, one per file', async (page) => {
  await files(page);
  await popOut(page, 'app.js'); await park(page, 'app.js', 20, 500); await popOut(page, 'tool.py');
  assert.equal(await page.locator('.vwin').count(), 2);
  const z = (name) => win(page, name).evaluate((e) => Number(e.style.zIndex));
  assert.ok((await z('tool.py')) > (await z('app.js')), 'the newest is in front');
  const a = await win(page, 'app.js').boundingBox();
  await page.mouse.move(a.x + 60, a.y + 14); await page.mouse.down();
  await page.mouse.move(a.x + 260, a.y + 150, { steps: 8 }); await page.mouse.up();
  const b = await win(page, 'app.js').boundingBox();
  assert.ok(Math.abs(b.x - (a.x + 200)) < 3 && Math.abs(b.y - (a.y + 136)) < 3, `moved ${JSON.stringify({ a, b })}`);
  assert.ok((await z('app.js')) > (await z('tool.py')), 'dragging raised it');
  await win(page, 'tool.py').locator('.doc-body').click();
  assert.ok((await z('tool.py')) > (await z('app.js')), 'clicking raises');
  await park(page, 'app.js', 20, 500); await park(page, 'tool.py', 460, 500);
  await show(page, 'app.js'); await page.click('.fb-pv-pop');            // the same file again: no second window
  await sleep(200);
  assert.equal(await page.locator('.vwin').count(), 2);
  await win(page, 'tool.py').locator('.vwin-x').click();
  assert.equal(await page.locator('.vwin').count(), 1);
  await page.evaluate(() => { const w = document.querySelector('.vwin'); w.style.left = '2000px'; });   // pushed off screen
  const r = await page.evaluate(() => { const w = document.querySelector('.vwin'); return w.getBoundingClientRect().left; });
  assert.ok(r > 1300);
});

t('minimize sends the window to a tray at the bottom; the chip restores it where it was, or closes it', async (page) => {
  await files(page);
  await popOut(page, 'app.js'); await park(page, 'app.js', 20, 500); await popOut(page, 'notes.txt');
  const stageBefore = (await page.locator('#stage').boundingBox()).height;
  const w = win(page, 'app.js'), pos = await w.boundingBox();
  await w.locator('.vwin-min').click();
  assert.equal(await w.isVisible(), false);
  assert.equal(await page.locator('#tray').isVisible(), true);
  const chip = page.locator('#tray .chip').filter({ hasText: 'app.js' });
  assert.equal(await chip.count(), 1);
  const cb = await chip.boundingBox();
  assert.ok(cb.y + cb.height > 800 - 20, `at the bottom: ${JSON.stringify(cb)}`);
  assert.ok((await page.locator('#stage').boundingBox()).height < stageBefore, 'the panes give up the room (and refit)');
  await win(page, 'notes.txt').locator('.vwin-min').click();
  assert.equal(await page.locator('#tray .chip').count(), 2);
  await chip.click();
  assert.equal(await w.isVisible(), true);
  const back = await w.boundingBox();
  assert.ok(Math.abs(back.x - pos.x) < 2 && Math.abs(back.y - pos.y) < 2 && Math.abs(back.width - pos.width) < 2, 'same place and size');
  assert.ok(await w.locator('[class*="hljs-"]').count() > 0);
  assert.equal(await page.locator('#tray .chip').count(), 1);
  await page.locator('#tray .chip .chip-x').click();           // close from the tray
  assert.equal(await win(page, 'notes.txt').count(), 0);
  assert.equal(await page.locator('#tray').isVisible(), false, 'an empty tray takes no room');
  assert.ok(Math.abs((await page.locator('#stage').boundingBox()).height - stageBefore) < 2);
});

t('windows are independent of the Files view: they stay while you browse elsewhere, leave the view, or change tabs', async (page) => {
  await files(page);
  await popOut(page, 'app.js');
  await win(page, 'app.js').locator('.vwin-min').click();
  await row(page, 'sub').dblclick();
  await page.waitForFunction((p) => document.querySelector('.fb-path').value === p, `${fx}/sub`);
  assert.equal(await page.locator('#tray .chip').count(), 1, 'still there in another folder');
  await page.click('.fb-term');                                // back to the terminal
  await page.click('#new-tab'); await page.waitForFunction(() => window.__brick.app.tabs.length === 2); await ready(page);
  assert.equal(await page.locator('#tray .chip').count(), 1, 'and in another tab');
  await page.locator('#tray .chip').click();
  assert.equal(await win(page, 'app.js').isVisible(), true);
  assert.ok(await win(page, 'app.js').locator('[class*="hljs-"]').count() > 0);
  await win(page, 'app.js').locator('.vwin-x').click();
  assert.equal(await page.locator('.vwin').count(), 0);
});

t('read-only: nothing in a viewer can be edited, and reload picks up changes made on disk', async (page) => {
  await files(page);
  await show(page, 'notes.txt');
  assert.equal(await page.locator('.fb-preview .doc-body [contenteditable], .fb-preview .doc-body textarea').count(), 0);
  assert.equal(await page.locator('.fb-preview .doc-body input').count(), 0);
  await page.locator('.fb-preview .pv-t').first().click();
  await page.keyboard.type('zzz');
  assert.ok(!(await body(page).innerText()).includes('zzz'), 'typing into the text changes nothing');
  fs.appendFileSync(path.join(fx, 'notes.txt'), 'added later\n');
  await page.click('.fb-preview .doc-reload');
  await page.waitForFunction(() => /added later/.test(document.querySelector('.fb-preview .doc-body').innerText));
  fs.writeFileSync(path.join(fx, 'notes.txt'), 'line one foo\nline two\n');
});

t('binary files and unreadable files say so instead of showing rubbish; the window works for them too', async (page) => {
  await files(page);
  await row(page, 'blob.bin').dblclick();
  await page.waitForFunction(() => /Binary file/.test(document.querySelector('.fb-preview .doc-body').innerText));
  fs.writeFileSync(path.join(fx, 'gone.txt'), 'x');
  await page.click('.fb-term'); await files(page);
  await page.click('.fb-refresh'); await page.waitForSelector(`.fb-row[data-path="${fx}/gone.txt"]`);
  fs.rmSync(path.join(fx, 'gone.txt'));
  await row(page, 'gone.txt').dblclick();
  await page.waitForFunction(() => /No such file/.test(document.querySelector('.fb-preview .doc-body').innerText));
  await page.click('.fb-pv-pop');
  await page.waitForFunction(() => /No such file/.test(document.querySelector('.vwin .doc-body')?.innerText || ''));
});

t('a grep hit still opens at its line with the match marked (now with colours), and can be popped out at that line', async (page) => {
  await files(page);
  await page.fill('.fb-q', 'foo'); await page.click('.fb-mode [data-m="text"]'); await page.locator('.fb-q').press('Enter');
  await page.waitForFunction(() => /hits? in/.test(document.querySelector('.gr-title')?.textContent || ''));
  await page.locator('.gr-file', { hasText: 'app.js' }).locator('xpath=following-sibling::div[contains(@class,"gr-line")][1]').click();
  await page.waitForSelector('.fb-preview .pv-l.hit');
  assert.ok(await page.locator('.fb-preview [class*="hljs-"]').count() > 0);
  assert.equal(await page.locator('.fb-preview .pv-l.hit mark').count(), 1);
  assert.match(await page.locator('.fb-preview .pv-l.hit').innerText(), /foo/);
  await page.click('.fb-pv-pop');
  await page.waitForSelector('.vwin .pv-l.hit');
  assert.equal(await page.locator('.vwin .pv-l.hit mark').count(), 1);
});
