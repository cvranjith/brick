// Tabs and split panes, end to end in headless Chrome against the real server and shells.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);
let srv, browser, page;

test.before(async () => {
  if (!hasChrome) return;
  srv = await startServer({ port: 0 });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(srv.url);
  await ready();
});
test.after(async () => { await browser?.close(); srv?.close(); });
const t = (name, fn) => test(name, { skip: !hasChrome && 'Chrome not installed' }, fn);

const tabs = () => page.locator('#tabs .tab');
const visiblePanes = () => page.locator('.tab-content:not(.hidden) .pane');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A pane is ready once its shell has sent its first prompt hook and no command is running.
const ready = (i) => page.waitForFunction((i) => { const p = window.__brick.app.panes(); return (i === undefined ? p : [p[i]]).every((s) => s && s.cwd && s.active === null); }, i);
async function focusPane(i) { await visiblePanes().nth(i).locator('.input').click(); }
async function runIn(i, cmd) {
  await ready(i);
  await focusPane(i);
  const p = visiblePanes().nth(i);
  const before = await p.locator('.block').count();
  await page.keyboard.type(cmd);
  await page.keyboard.press('Enter');
  const blk = p.locator('.block').nth(before);
  await blk.waitFor();
  return blk;
}
async function typeIn(i, cmd) {   // for commands whose pane disappears (exit): no block to wait for
  await ready(i);
  await focusPane(i);
  await page.keyboard.type(cmd);
  await page.keyboard.press('Enter');
}
const finished = (blk) => blk.evaluate((el) => new Promise((r) => { const c = () => (el.classList.contains('running') ? setTimeout(c, 50) : r()); c(); }));
const out = async (blk, re) => {   // DOM renderer paints on the next frame: poll
  for (let i = 0; i < 60; i++) { const x = await blk.locator('.xterm-rows').innerText(); if (re.test(x)) return x; await sleep(50); }
  return blk.locator('.xterm-rows').innerText();
};
const cmdText = (blk) => blk.locator('.cmd').innerText();
const ptyCols = async (i) => { const b = await runIn(i, 'stty size'); await finished(b); return Number((await out(b, /\d+ \d+/)).trim().split(/\s+/)[1]); };
const box = (loc) => loc.boundingBox();

t('starts with one tab and one pane with a working shell', async () => {
  assert.equal(await tabs().count(), 1);
  assert.equal(await visiblePanes().count(), 1);
  const b = await runIn(0, 'echo first-tab'); await finished(b);
  assert.match(await out(b, /first-tab/), /first-tab/);
});

t('new tab: independent shell, own session id, own working directory', async () => {
  const b1 = await runIn(0, 'echo sid=$BRICK_SESSION'); await finished(b1);
  const sid1 = (await out(b1, /sid=\d+/)).match(/sid=(\d+)/)[1];
  await page.click('#new-tab');
  assert.equal(await tabs().count(), 2);
  assert.ok(await tabs().nth(1).evaluate((el) => el.classList.contains('active')));
  const b2 = await runIn(0, 'cd /tmp && echo sid=$BRICK_SESSION'); await finished(b2);
  const sid2 = (await out(b2, /sid=\d+/)).match(/sid=(\d+)/)[1];
  assert.notEqual(sid1, sid2);
  await page.waitForFunction(() => document.querySelectorAll('#tabs .tab-title')[1].textContent === 'tmp');
  // back to tab 1: its blocks are still there and it is still in the old directory
  await tabs().nth(0).click();
  assert.ok(await page.locator('.tab-content:not(.hidden) .block').count() >= 2);
  const pwd = await runIn(0, 'pwd'); await finished(pwd);
  assert.doesNotMatch(await out(pwd, /\//), /^\/tmp\s*$/m);
});

t('closing a tab removes it; closing the last tab opens a fresh one', async () => {
  await tabs().nth(1).locator('.tab-close').click();
  assert.equal(await tabs().count(), 1);
  const before = await page.evaluate(() => window.__brick.session.el.isConnected && Math.random());
  await tabs().nth(0).locator('.tab-close').click();
  assert.equal(await tabs().count(), 1);   // replaced by a new tab
  await ready();
  assert.equal(await visiblePanes().locator('.block').count(), 0, 'fresh tab has no blocks');
  assert.ok(before);
});

t('split right: two live panes side by side, narrower pty, independent output', async () => {
  const full = await ptyCols(0);
  await page.click('#split-right');
  assert.equal(await visiblePanes().count(), 2);
  await ready();
  const [a, b] = [await box(visiblePanes().nth(0)), await box(visiblePanes().nth(1))];
  assert.ok(a.x < b.x && Math.abs(a.y - b.y) < 2, 'side by side');
  assert.ok(Math.abs(a.width - b.width) < 12, `halves: ${a.width} vs ${b.width}`);
  const left = await runIn(0, 'echo only-left'); await finished(left);
  const right = await runIn(1, 'echo only-right'); await finished(right);
  assert.match(await out(left, /only-left/), /only-left/);
  assert.match(await out(right, /only-right/), /only-right/);
  assert.doesNotMatch(await visiblePanes().nth(0).locator('.blocks').innerText(), /only-right/);
  assert.doesNotMatch(await visiblePanes().nth(1).locator('.blocks').innerText(), /only-left/);
  assert.ok((await ptyCols(1)) < full * 0.7, 'right pane pty is narrower than the full-width one');
});

t('typing goes to the focused pane while another pane runs a command', async () => {
  const slow = await runIn(0, 'sleep 1.5');
  const fast = await runIn(1, 'echo quick'); await finished(fast);
  assert.ok(await slow.evaluate((el) => el.classList.contains('running')), 'left still running');
  assert.match(await out(fast, /quick/), /quick/);
  await finished(slow);
  assert.equal(await cmdText(fast), 'echo quick');
});

t('full-screen program covers only its own pane', async () => {
  const blk = await runIn(1, `printf '\\033[?1049h\\033[Hin-right'; sleep 1.5; printf '\\033[?1049l'`);
  await page.waitForSelector('.block.overlay');
  const o = await box(page.locator('.block.overlay')), right = await box(visiblePanes().nth(1)), left = await box(visiblePanes().nth(0));
  assert.ok(o.x >= right.x - 2 && o.x + o.width <= right.x + right.width + 2, 'inside the right pane');
  assert.ok(o.x >= left.x + left.width - 2, 'does not cover the left pane');
  await finished(blk);
  assert.equal(await page.locator('.block.overlay').count(), 0);
});

t('dragging the divider resizes the panes', async () => {
  const before = await box(visiblePanes().nth(0));
  const d = await box(page.locator('.divider').first());
  await page.mouse.move(d.x + 2, d.y + 40);
  await page.mouse.down();
  await page.mouse.move(d.x + 2 - 200, d.y + 40, { steps: 5 });
  await page.mouse.up();
  const after = await box(visiblePanes().nth(0));
  assert.ok(before.width - after.width > 150, `${before.width} -> ${after.width}`);
  await ready();
  const cols = await ptyCols(0);
  assert.ok(cols < 80, `left pane pty follows the new width (${cols} cols)`);
});

t('split down inside a pane makes a 3-pane layout; closing a pane gives the space back', async () => {
  await focusPane(1);
  await page.click('#split-down');
  assert.equal(await visiblePanes().count(), 3);
  await ready();
  const [b, c] = [await box(visiblePanes().nth(1)), await box(visiblePanes().nth(2))];
  assert.ok(Math.abs(b.x - c.x) < 2 && c.y > b.y, 'stacked');
  await visiblePanes().nth(2).locator('.pane-close').click();
  assert.equal(await visiblePanes().count(), 2);
  await ready();
  const b2 = await box(visiblePanes().nth(1));
  assert.ok(b2.height > b.height * 1.6, 'remaining pane reclaimed the height');
});

t('`exit` in a pane ends its shell and closes just that pane', async () => {
  const sessions = await page.evaluate(() => window.__brick.app.panes().length);
  assert.equal(sessions, 2);
  await typeIn(1, 'exit');
  await page.waitForFunction(() => window.__brick.app.panes().length === 1);
  await ready();
  const b = await runIn(0, 'echo survivor'); await finished(b);
  assert.match(await out(b, /survivor/), /survivor/);
});

t('keyboard shortcuts work and never leak into the shell', async () => {
  await page.keyboard.press('Alt+Shift+KeyD');
  assert.equal(await visiblePanes().count(), 2);
  await ready();
  await page.keyboard.press('Alt+Shift+KeyS');
  assert.equal(await visiblePanes().count(), 3);
  await ready();
  await page.keyboard.press('Alt+Shift+BracketLeft');
  await page.keyboard.press('Alt+Shift+BracketRight');
  await page.keyboard.press('Alt+Shift+KeyW');
  assert.equal(await visiblePanes().count(), 2);
  await page.keyboard.press('Alt+Shift+KeyT');
  assert.equal(await tabs().count(), 2);
  await ready();
  await page.keyboard.press('Alt+Shift+Digit1');
  assert.ok(await tabs().nth(0).evaluate((el) => el.classList.contains('active')));
  await ready();
  // if any shortcut had leaked ESC-prefixed bytes into zsh, the typed command text would differ
  const b = await runIn(0, 'echo clean'); await finished(b);
  assert.equal(await cmdText(b), 'echo clean');
  assert.equal(await page.locator('.tab-content:not(.hidden) .multi, .tab-content.multi:not(.hidden)').count() >= 1, true);
});

t('`exit` in the very last pane replaces it with a fresh session', async () => {
  while ((await tabs().count()) > 1) await tabs().nth(1).locator('.tab-close').click();
  while ((await visiblePanes().count()) > 1) await visiblePanes().nth(1).locator('.pane-close').click();
  await ready();
  const before = await page.evaluate(() => window.__brick.session.el.dataset.k = 'old');
  await typeIn(0, 'exit');
  await page.waitForFunction(() => window.__brick.session && window.__brick.session.el.dataset.k !== 'old' && window.__brick.session.cwd);
  assert.equal(await tabs().count(), 1);
  await page.screenshot({ path: new URL('../docs/layout.png', import.meta.url).pathname });
  assert.equal(before, 'old');
});

t('screenshot of a split layout', async () => {
  await ready();
  await page.click('#split-right'); await ready();
  await page.click('#new-tab'); await ready();
  await tabs().nth(0).click(); await ready();
  await page.click('#split-down'); await ready();
  for (const [i, c] of [[0, 'ls /usr'], [1, 'echo hello from the right'], [2, 'false']]) await finished(await runIn(i, c));
  await page.screenshot({ path: new URL('../docs/splits.png', import.meta.url).pathname });
});

t('regression: echo still queued in the input terminal must not reappear after the Preexec reset', async () => {
  await ready();
  await page.evaluate(() => {
    const s = window.__brick.session;
    s.inputTerm.write('stale-echo');   // xterm queues this; it is parsed after the next tick
    s.onHook({ hook: 'Preexec', value: { command: 'fake', cwd: '/' } });
    s.onHook({ hook: 'CommandFinished', value: { exit_code: 0 } });
  });
  await sleep(300);
  const text = await page.evaluate(() => {
    const b = window.__brick.session.inputTerm.buffer.active;
    let t = '';
    for (let y = 0; y < b.length; y++) t += b.getLine(y).translateToString(true) + '\n';
    return t;
  });
  assert.doesNotMatch(text, /stale-echo/);
});
