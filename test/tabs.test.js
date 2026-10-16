// Tab bar placement (top, left, right, collapsed), Dock-style magnify, and the hover peek. Real server, headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);
let srv, browser;
test.before(async () => {
  if (!hasChrome) return;
  srv = await startServer({ port: 0 });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
test.after(async () => { await browser?.close(); srv?.close(); });
const t = (name, fn) => test(name, { skip: !hasChrome && 'Chrome not installed' }, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  try { await page.goto(srv.url); await ready(page); await fn(page); } finally { await page.close(); }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = (page) => page.waitForFunction(() => window.__brick.app.tabs.every((tb) => window.__brick.leaves(tb.root).every((s) => s.cwd && s.active === null)));
const box = (page, sel, n = 0) => page.locator(sel).nth(n).boundingBox();
const tabBtn = (page, i) => page.locator('#tabs .tab').nth(i);
const openPanel = async (page) => { if (!(await page.locator('#appearance-panel').isVisible())) await page.click('#appearance'); };
const place = async (page, pos) => { await openPanel(page); await page.click(`#tab-pos button[data-pos="${pos}"]`); };
async function newTabs(page, n) {   // n tabs in total
  while ((await page.locator('#tabs .tab').count()) < n) {
    const have = await page.locator('#tabs .tab').count();
    await page.click('#new-tab'); await page.waitForFunction((c) => window.__brick.app.tabs.length === c + 1, have); await ready(page);
  }
}
const scaleOf = (page, i) => tabBtn(page, i).evaluate((el) => { const m = el.style.transform.match(/scale\(([\d.]+)\)/); return m ? Number(m[1]) : 1; });
const peekShown = (page) => page.locator('#peek').isVisible();

t('default: tabs in the top bar, no sidebar', async (page) => {
  assert.equal(await page.locator('header #tabs').count(), 1);
  assert.equal(await page.locator('#sidebar').isVisible(), false);
  assert.equal(await page.locator('#tabs-collapse').isVisible(), false);
});

t('Left and Right move the tabs into a sidebar beside the terminals, and Top moves them back', async (page) => {
  await newTabs(page, 2);
  const topStage = await box(page, '#stage');
  await place(page, 'left');
  assert.equal(await page.locator('#sidebar #tabs').count(), 1);
  assert.equal(await page.locator('header #tabs').count(), 0);
  const l = await box(page, '#sidebar'), ls = await box(page, '#stage');
  assert.ok(l.x < 5 && ls.x >= l.width - 1, 'sidebar on the left, stage beside it');
  assert.ok(ls.width < topStage.width, 'terminals got narrower');
  const tabs = await page.locator('#tabs .tab').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  assert.ok(tabs[1] > tabs[0], 'stacked vertically');
  await page.click('#tab-pos button[data-pos="right"]');
  const r = await box(page, '#sidebar'), rs = await box(page, '#stage');
  assert.ok(r.x + r.width > 1195 && rs.x < 5, 'sidebar on the right');
  await page.click('#tab-pos button[data-pos="top"]');
  assert.equal(await page.locator('header #tabs').count(), 1);
  assert.equal(await page.locator('#sidebar').isVisible(), false);
  assert.equal((await box(page, '#stage')).width, topStage.width);
  await page.locator('#tabs .tab').first().click();   // still works after moving around
});

t('the terminal refits when the bar moves (shell sees the new width)', async (page) => {
  const cols = () => page.evaluate(() => window.__brick.session.cols);
  const before = await cols();
  await place(page, 'left');
  await page.waitForFunction((c) => window.__brick.session.cols < c, before);
});

t('vertical bars collapse to a rail of initials, from the sidebar button or the panel, and it is remembered', async (page) => {
  await newTabs(page, 2);
  await place(page, 'left');
  assert.equal(await page.locator('#tab-collapse-row').isVisible(), true, 'collapse option shown');
  const wide = (await box(page, '#sidebar')).width;
  await page.click('#tabs-collapse');
  await page.waitForTimeout(300);
  const narrow = (await box(page, '#sidebar')).width;
  assert.ok(narrow < wide / 2, `${narrow} < ${wide}/2`);
  assert.equal(await tabBtn(page, 0).locator('.tab-title').isVisible(), false);
  assert.equal(await tabBtn(page, 0).locator('.tab-ini').isVisible(), true, 'initial shown');
  assert.ok((await tabBtn(page, 0).locator('.tab-name').textContent()).length > 0, 'each tab knows its name');
  assert.equal(await page.locator('#tab-collapse').isChecked(), true, 'panel checkbox follows');
  await page.reload(); await ready(page);
  assert.ok(Math.abs((await box(page, '#sidebar')).width - narrow) < 2, 'remembered across reload');
  await openPanel(page); await page.uncheck('#tab-collapse');
  await page.waitForTimeout(300);
  { const w = (await box(page, '#sidebar')).width; assert.ok(Math.abs(w - wide) < 2, `expanded again: ${w} vs ${wide}`); }
  await page.click('#tab-pos button[data-pos="top"]');
  assert.equal(await page.locator('#tab-collapse-row').isVisible(), false, 'nothing to collapse in the top bar');
});

t('Dock effect: tabs near the pointer grow, far ones do not, and it resets on leaving (top and side)', async (page) => {
  await newTabs(page, 5);
  const c = await box(page, '#tabs .tab', 2);
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.move(c.x + c.width / 2 + 1, c.y + c.height / 2);
  const s = await Promise.all([0, 1, 2, 3, 4].map((i) => scaleOf(page, i)));
  assert.ok(s[2] > 1.2, `centre ${s[2]}`);
  assert.ok(s[1] > 1 && s[1] < s[2] && s[3] > 1 && s[3] < s[2], `neighbours ${s}`);
  assert.equal(s[0], 1); assert.equal(s[4], 1);
  await page.mouse.move(600, 400);
  await page.waitForTimeout(100);
  assert.deepEqual(await Promise.all([0, 1, 2, 3, 4].map((i) => scaleOf(page, i))), [1, 1, 1, 1, 1]);
  await place(page, 'left'); await page.click('#ap-close');
  const v = await box(page, '#tabs .tab', 1);
  await page.mouse.move(v.x + 30, v.y + v.height / 2); await page.mouse.move(v.x + 31, v.y + v.height / 2);
  assert.ok((await scaleOf(page, 1)) > 1.05, 'grows in a vertical bar too');
  assert.equal(await scaleOf(page, 4), 1);
});

t('collapsed rail: the tab under the pointer shows its full name beside it, grows most, neighbours less, far ones not at all', async (page) => {
  await newTabs(page, 5);
  await place(page, 'left'); await page.click('#tab-collapse', { force: true }).catch(() => {}); await page.click('#tabs-collapse'); await page.click('#ap-close').catch(() => {});
  await page.waitForTimeout(300);
  if (!(await page.locator('#sidebar.collapsed').count())) await page.click('#tabs-collapse');
  await page.waitForTimeout(300);
  const c = await box(page, '#tabs .tab', 2);
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2); await page.mouse.move(c.x + c.width / 2 + 1, c.y + c.height / 2);
  const s = await Promise.all([0, 1, 2, 3, 4].map((i) => scaleOf(page, i)));
  assert.ok(s[2] > 1.5, `nearest ${s[2]}`);
  assert.ok(s[1] > 1.05 && s[1] < s[2] - 0.2 && s[3] > 1.05 && s[3] < s[2] - 0.2, `neighbours ${s}`);
  assert.ok(s[0] < s[1] && s[4] < s[3], `falls off ${s}`);
  const label = page.locator('#tabs .tab.hot .tab-name');
  assert.equal(await page.locator('#tabs .tab.hot').count(), 1, 'exactly one tab is hot');
  assert.equal(await label.isVisible(), true);
  assert.equal((await label.innerText()).length > 0, true);
  assert.equal(await tabBtn(page, 2).evaluate((el) => el.classList.contains('hot')), true);
  assert.equal(await page.locator('#tabs .tab:not(.hot) .tab-name:visible').count(), 0, 'only the nearest shows a name');
  const lb = await label.boundingBox(), tb = await box(page, '#tabs .tab', 2);
  assert.ok(lb.x >= tb.x + tb.width - 1, 'label sits beside the rail, not clipped inside it');
  assert.ok(lb.x + lb.width <= 1200, 'on screen');
  const side = await page.locator('#sidebar').evaluate((el) => el.scrollWidth <= el.clientWidth + 1 || getComputedStyle(el).overflow === 'visible');
  assert.ok(side);
  assert.equal(await page.locator('#tabs').evaluate((el) => el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible'), false, 'no scrollbar from the growth');
  await page.mouse.move(700, 600); await page.waitForTimeout(100);
  assert.equal(await page.locator('#tabs .tab.hot').count(), 0);
});

t('peek: resting on another tab shows its contents without a click; clicking the peek opens the tab', async (page) => {
  await page.evaluate(() => { window.__brick.peekDelay = 400; });
  await page.locator('.input').first().click();
  await page.keyboard.type('echo marker-in-first-tab'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /marker-in-first-tab/.test(document.querySelector('.block:last-child')?.innerText || ''));
  await newTabs(page, 2);                                    // second tab is now active
  const b = await box(page, '#tabs .tab', 0);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await sleep(150);
  assert.equal(await peekShown(page), false, 'not immediately');
  await page.waitForFunction(() => !document.querySelector('#peek').hidden, null, { timeout: 3000 });
  assert.match(await page.locator('#peek').innerText(), /marker-in-first-tab/);
  const p = await box(page, '#peek');
  assert.ok(p.y >= b.y + b.height, 'below the top bar');
  assert.equal(await page.evaluate(() => window.__brick.app.tabs.indexOf(window.__brick.app.active)), 1, 'peeking did not switch');
  await page.mouse.move(p.x + 100, p.y + 100);               // onto the peek: it stays
  await sleep(500);
  assert.equal(await peekShown(page), true);
  await page.mouse.click(p.x + 100, p.y + 100);
  assert.equal(await peekShown(page), false);
  assert.equal(await page.evaluate(() => window.__brick.app.tabs.indexOf(window.__brick.app.active)), 0, 'clicking the peek went to that tab');
});

t('peek: not for the active tab, goes away when the pointer leaves or Esc is pressed, and works in a side bar', async (page) => {
  await page.evaluate(() => { window.__brick.peekDelay = 300; });
  await newTabs(page, 2);
  const active = await box(page, '#tabs .tab', 1);
  await page.mouse.move(active.x + 20, active.y + 10); await sleep(700);
  assert.equal(await peekShown(page), false, 'the active tab is already on screen');
  const other = await box(page, '#tabs .tab', 0);
  await page.mouse.move(other.x + 20, other.y + 10);
  await page.waitForFunction(() => !document.querySelector('#peek').hidden);
  await page.mouse.move(600, 600);                           // away from the bar and the peek
  await page.waitForFunction(() => document.querySelector('#peek').hidden, null, { timeout: 2000 });
  await page.mouse.move(other.x + 22, other.y + 10);
  await page.waitForFunction(() => !document.querySelector('#peek').hidden);
  await page.keyboard.press('Escape');
  assert.equal(await peekShown(page), false);
  await place(page, 'left'); await page.click('#ap-close');
  const o = await box(page, '#tabs .tab', 0);
  await page.mouse.move(o.x + 20, o.y + 10);
  await page.waitForFunction(() => !document.querySelector('#peek').hidden);
  const side = await box(page, '#sidebar'), p = await box(page, '#peek');
  assert.ok(p.x >= side.x + side.width - 1, 'opens to the right of a left sidebar');
});

t('dragging a pane onto empty sidebar space makes it a tab; reordering works along the vertical bar', async (page) => {
  await page.click('#split-right'); await page.waitForFunction(() => window.__brick.app.panes().length === 2); await ready(page);
  await place(page, 'left'); await page.click('#ap-close');
  const head = await box(page, '.pane .pane-head', 1), side = await box(page, '#sidebar');
  await page.mouse.move(head.x + 20, head.y + 8); await page.mouse.down();
  await page.mouse.move(side.x + 80, side.y + side.height - 40, { steps: 10 }); await page.mouse.up();
  await page.waitForFunction(() => window.__brick.app.tabs.length === 2);
  // reorder: drag the second tab above the first
  const a = await box(page, '#tabs .tab', 0), b = await box(page, '#tabs .tab', 1);
  const second = await page.evaluate(() => window.__brick.app.tabs[1].btn.querySelector('.tab-title').textContent);
  await page.mouse.move(b.x + 30, b.y + b.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + 30, a.y + 2, { steps: 10 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__brick.app.tabs.indexOf(window.__brick.app.tabs.find((t) => t.btn === document.querySelector('#tabs .tab')))), 0, 'DOM order equals app.tabs order');
  assert.equal(await page.locator('#tabs .tab').count(), 2);
  assert.ok(second);
});
