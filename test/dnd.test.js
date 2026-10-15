// Drag and drop: reorder tabs, move panes inside a tab, pop a pane out, move it into another tab.
// Real server, real shells, headless Chrome with real mouse events.
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try { await page.goto(srv.url); await ready(page); await fn(page); } finally { await page.close(); }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = (page) => page.waitForFunction(() => {
  const a = window.__brick.app;
  return a.tabs.length && a.tabs.every((tb) => window.__brick.leaves(tb.root).every((s) => s.cwd && s.active === null));
});
// Give every pane a letter (in tab order, then layout order) so tests can name them.
const tag = (page) => page.evaluate(() => {
  let i = 0;
  for (const tb of window.__brick.app.tabs) { tb.label = `T${window.__brick.app.tabs.indexOf(tb)}`; for (const s of window.__brick.leaves(tb.root)) s.el.dataset.label = 'ABCDEF'[i++]; }
});
const pane = (page, l) => page.locator(`.pane[data-label="${l}"]`);
const head = async (page, l) => { const b = await pane(page, l).locator('.pane-head').boundingBox(); return { x: b.x + 60, y: b.y + b.height / 2 }; };
const spot = async (loc, where) => {
  const b = await loc.boundingBox(), fx = { left: .08, right: .92 }[where] ?? .5, fy = { top: .08, bottom: .92 }[where] ?? .5;
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
};
async function drag(page, from, to, { hold = 0, release = true } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  if (hold) await sleep(hold);
  if (release) await page.mouse.up();
}
// Letters of the panes in the visible tab, in layout order.
const order = (page) => page.evaluate(() => [...document.querySelectorAll('.tab-content:not(.hidden) .pane')].map((e) => e.dataset.label).join(''));
const tabsOf = (page) => page.evaluate(() => window.__brick.app.tabs.map((tb) => window.__brick.leaves(tb.root).map((s) => s.el.dataset.label).join('')));
const domTabs = (page) => page.evaluate(() => [...document.querySelectorAll('#tabs .tab')].length);
// Shell session number, to prove the same shell survived a move.
async function sid(page, l) {
  await page.waitForFunction((l) => { const s = document.querySelector(`.pane[data-label="${l}"]`)._session; return s.active === null; }, l);
  await pane(page, l).locator('.input').click();
  const p = pane(page, l), n = await p.locator('.block').count();
  await page.keyboard.type('echo sid=$BRICK_SESSION'); await page.keyboard.press('Enter');
  const blk = p.locator('.block').nth(n);
  for (let i = 0; i < 80; i++) { const m = (await blk.locator('.xterm-rows').innerText()).match(/sid=(\d+)/); if (m) return Number(m[1]); await sleep(50); }
  throw new Error('no sid output');
}
async function splitRight(page) { await page.click('#split-right'); await page.waitForFunction(() => window.__brick.app.tabs.some((tb) => window.__brick.leaves(tb.root).length > 1)); await ready(page); }
const tabBtn = (page, i) => page.locator('#tabs .tab').nth(i);
async function newTab(page) { const n = await domTabs(page); await page.click('#new-tab'); await page.waitForFunction((n) => window.__brick.app.tabs.length === n + 1, n); await ready(page); }

t('tabs: dragging a tab reorders it, and the click that ends the drag does not switch tabs', async (page) => {
  await newTab(page); await newTab(page);
  await tag(page);
  const activeBefore = await page.evaluate(() => window.__brick.app.tabs.indexOf(window.__brick.app.active));
  assert.equal(activeBefore, 2);
  // drag the last tab (T2) onto the left half of the first
  const from = await spot(tabBtn(page, 2), 'center'), to = await spot(tabBtn(page, 0), 'left');
  await drag(page, from, { x: to.x + 4, y: to.y });
  assert.deepEqual(await page.evaluate(() => window.__brick.app.tabs.map((tb) => tb.label)), ['T2', 'T0', 'T1']);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((b) => window.__brick.app.tabs.findIndex((tb) => tb.btn === b))), [0, 1, 2], 'DOM order equals app.tabs order');
  // dragging T0 (now second) onto T1 (third) moves it to the end
  const f2 = await spot(tabBtn(page, 1), 'center'), t2 = await spot(tabBtn(page, 2), 'right');
  await drag(page, f2, t2);
  assert.deepEqual(await page.evaluate(() => window.__brick.app.tabs.map((tb) => tb.label)), ['T2', 'T1', 'T0']);
  // a drag must not count as a click: still on the tab that was active (T2, now first)
  assert.equal(await page.evaluate(() => window.__brick.app.active.label), 'T2');
  // and a normal click works again afterwards
  await tabBtn(page, 2).click();
  assert.equal(await page.evaluate(() => window.__brick.app.active.label), 'T0');
});

t('panes: dragging to an edge reorders and re-splits inside the tab; shells stay alive', async (page) => {
  await splitRight(page); await tag(page);
  assert.equal(await order(page), 'AB');
  const sidB = await sid(page, 'B');
  // B onto the left edge of A -> B | A
  await drag(page, await head(page, 'B'), await spot(pane(page, 'A'), 'left'));
  assert.equal(await order(page), 'BA');
  assert.equal(await page.locator('.split.h').count(), 1);
  // A onto the bottom edge of B -> B above A (vertical split)
  await drag(page, await head(page, 'A'), await spot(pane(page, 'B'), 'bottom'));
  assert.equal(await order(page), 'BA');
  assert.equal(await page.locator('.split.v').count(), 1);
  assert.equal(await page.locator('.split.h').count(), 0);
  const [bb, ba] = [await pane(page, 'B').boundingBox(), await pane(page, 'A').boundingBox()];
  assert.ok(ba.y > bb.y + bb.height - 4, 'A is below B');
  assert.equal(await sid(page, 'B'), sidB, 'B kept its shell');
});

t('panes: dropping on the middle of another pane swaps them', async (page) => {
  await splitRight(page); await tag(page);
  assert.equal(await order(page), 'AB');
  await drag(page, await head(page, 'B'), await spot(pane(page, 'A'), 'center'));
  assert.equal(await order(page), 'BA');
});

t('panes: Escape cancels a drag and nothing moves', async (page) => {
  await splitRight(page); await tag(page);
  await drag(page, await head(page, 'B'), await spot(pane(page, 'A'), 'left'), { release: false });
  assert.equal(await page.locator('.drop-ind').evaluate((e) => getComputedStyle(e).display), 'block', 'drop indicator shows while dragging');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await order(page), 'AB');
  assert.equal(await page.locator('.drop-ind').count(), 0, 'indicator removed');
  assert.equal(await page.evaluate(() => document.body.classList.contains('dragging')), false);
});

t('panes: dragging onto the empty tab bar moves the pane into its own tab', async (page) => {
  await splitRight(page); await tag(page);
  const sidB = await sid(page, 'B');
  const bar = await page.locator('header').boundingBox(); bar.x = 700; bar.width = 100;   // empty part of the bar
  await drag(page, await head(page, 'B'), { x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 });
  assert.deepEqual(await tabsOf(page), ['A', 'B']);
  assert.equal(await page.evaluate(() => window.__brick.app.active.root.session.el.dataset.label), 'B', 'follows the pane');
  assert.equal(await sid(page, 'B'), sidB, 'same shell');
});

t('panes: the pop-out button does the same, and does nothing for a lone pane', async (page) => {
  await tag(page);
  await pane(page, 'A').locator('.pane-pop').click();     // lone pane: nothing happens
  assert.deepEqual(await tabsOf(page), ['A']);
  await splitRight(page); await tag(page);
  await pane(page, 'B').locator('.pane-pop').click();
  assert.deepEqual(await tabsOf(page), ['A', 'B']);
});

t('panes: dropping on another tab button inserts the pane into that tab', async (page) => {
  await splitRight(page);       // tab 1: A | B
  await newTab(page);           // tab 2: C
  await tag(page);
  assert.deepEqual(await tabsOf(page), ['AB', 'C']);
  await tabBtn(page, 0).click();
  const sidB = await sid(page, 'B');
  await drag(page, await head(page, 'B'), await spot(tabBtn(page, 1), 'center'));
  assert.deepEqual(await tabsOf(page), ['A', 'CB']);
  assert.equal(await page.evaluate(() => window.__brick.app.tabs.indexOf(window.__brick.app.active)), 1, 'follows the pane');
  assert.equal(await sid(page, 'B'), sidB, 'B kept its shell');
  assert.equal(await order(page), 'CB');
});

t('panes: moving the only pane of a tab into another tab removes the emptied tab', async (page) => {
  await newTab(page);           // tab 1: A, tab 2: B
  await tag(page);
  await drag(page, await head(page, 'B'), await spot(tabBtn(page, 0), 'center'));
  assert.deepEqual(await tabsOf(page), ['AB']);
  assert.equal(await domTabs(page), 1);
});

t('panes: hovering a tab while dragging opens it, so the pane can be dropped at an exact edge', async (page) => {
  await splitRight(page);       // tab 1: A | B
  await newTab(page);           // tab 2: C
  await tag(page);
  await tabBtn(page, 0).click();
  const from = await head(page, 'B');
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  const over = await spot(tabBtn(page, 1), 'center');
  await page.mouse.move(over.x, over.y, { steps: 10 });
  await page.waitForFunction(() => window.__brick.app.tabs.indexOf(window.__brick.app.active) === 1, null, { timeout: 3000 });
  await page.mouse.move(...Object.values(await spot(pane(page, 'C'), 'left')), { steps: 10 });
  await page.mouse.up();
  assert.deepEqual(await tabsOf(page), ['A', 'BC']);
});
