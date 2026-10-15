// Appearance: window glass, per-pane look, the dismissable panel, backdrop picture. Real server, headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
let srv, browser;
test.before(async () => {
  if (!hasChrome) return;
  srv = await startServer({ port: 0, capture: async () => JPEG });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
test.after(async () => { await browser?.close(); srv?.close(); });
// each test gets a fresh browser context (so no stored settings) and a ready first pane
const t = (name, fn) => test(name, { skip: !hasChrome && 'Chrome not installed' }, async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  try { await page.goto(srv.url); await ready(page); await fn(page); } finally { await page.close(); }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = (page) => page.waitForFunction(() => window.__brick.app.tabs.every((tb) => window.__brick.leaves(tb.root).every((s) => s.cwd && s.active === null)));
const alpha = (page, sel, n = 0) => page.locator(sel).nth(n).evaluate((el) => { const m = getComputedStyle(el).backgroundColor.match(/\/ ([\d.]+)\)$|rgba\([^)]*, ([\d.]+)\)/); return m ? Number(m[1] ?? m[2]) : 1; });
const setRange = (page, id, v) => page.locator(id).evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(v));
const panelOpen = (page) => page.locator('#appearance-panel').isVisible();
const openPanel = async (page) => { if (!(await panelOpen(page))) await page.click('#appearance'); };
const bodyHas = (page, c) => page.evaluate((c) => document.body.classList.contains(c), c);
const blur = (page, n = 0) => page.locator('.pane').nth(n).evaluate((el) => getComputedStyle(el).backdropFilter);
async function splitRight(page) { await page.click('#split-right'); await page.waitForFunction(() => window.__brick.app.panes().length === 2); await ready(page); }
const headClick = (page, n) => page.locator('.pane').nth(n).locator('.pane-head').click({ position: { x: 20, y: 8 } });   // left edge: the panel may cover the right
const setMode = (page, mode) => page.click(`#pane-mode button[data-mode="${mode}"]`);

t('default: window level, solid panes, no controls on screen', async (page) => {
  assert.equal(await bodyHas(page, 'glass'), false);
  assert.equal(await bodyHas(page, 'backdrop'), false);
  assert.equal(await alpha(page, '.pane'), 1);
  assert.equal(await panelOpen(page), false);
  assert.equal(await page.locator('header input').count(), 0, 'no sliders permanently in the header');
  assert.equal(await page.locator('#appearance').innerText(), 'Appearance');
});

t('the panel opens from the header button and closes with x, Esc or the button again', async (page) => {
  await page.click('#appearance');
  assert.equal(await panelOpen(page), true);
  await page.click('#ap-close');
  assert.equal(await panelOpen(page), false);
  await page.click('#appearance'); await page.click('#appearance');
  assert.equal(await panelOpen(page), false, 'button toggles');
  await page.click('#appearance');
  await page.keyboard.press('Escape');
  assert.equal(await panelOpen(page), false, 'Esc closes');
  // after closing, typing goes to the shell again, and the Esc did not reach it
  await page.keyboard.type('echo after-close'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /after-close/.test([...document.querySelectorAll('.block')].pop()?.innerText || ''));
});

t('window glass: the checkbox turns every pane translucent with a blur; sliders control it', async (page) => {
  await openPanel(page);
  await page.check('#glass');
  assert.equal(await bodyHas(page, 'glass'), true);
  assert.equal(await bodyHas(page, 'backdrop'), true);
  await setRange(page, '#glass-opacity', 40); await setRange(page, '#glass-blur', 10);
  assert.ok(Math.abs((await alpha(page, '.pane')) - 0.4) < 0.02);
  assert.ok(Math.abs((await alpha(page, 'header')) - 0.4) < 0.02, 'header too');
  assert.equal(await blur(page), 'blur(10px)');
  assert.equal(await page.locator('#glass-opacity-out').innerText(), '40%');
  await setRange(page, '#glass-opacity', 100);
  assert.equal(await alpha(page, '.pane'), 1);
  await page.uncheck('#glass');
  assert.equal(await bodyHas(page, 'backdrop'), false);
  assert.equal(await blur(page), 'none');
});

t('Alt+Shift+G still toggles window glass from the keyboard, and the panel checkbox follows', async (page) => {
  await page.locator('.input').first().click();
  await page.keyboard.press('Alt+Shift+KeyG');
  assert.equal(await bodyHas(page, 'glass'), true);
  await openPanel(page);
  assert.equal(await page.locator('#glass').isChecked(), true);
  await page.keyboard.press('Alt+Shift+KeyG');
  assert.equal(await page.locator('#glass').isChecked(), false);
});

t('per pane: one pane solid, one glass, one following the window', async (page) => {
  await splitRight(page); await page.click('#split-right'); await page.waitForFunction(() => window.__brick.app.panes().length === 3); await ready(page);
  await openPanel(page);
  await page.locator('#appearance-panel').evaluate((el) => { el.style.right = 'auto'; el.style.left = '10px'; el.style.top = '300px'; });   // out of the way of the right-hand pane
  await page.check('#glass'); await setRange(page, '#glass-opacity', 30);       // window: glass at 30%
  const panes = page.locator('.pane');
  await headClick(page, 0);                                                      // focus pane 0 -> make it solid
  await setMode(page, 'solid');
  await headClick(page, 1);                                                      // pane 1 follows the window (default)
  assert.equal(await page.locator('#pane-mode button.on').innerText(), 'Window');
  await headClick(page, 2);                                                      // pane 2: own glass at 80%
  await setMode(page, 'glass');
  await setRange(page, '#pane-opacity', 80); await setRange(page, '#pane-blur', 4);
  assert.equal(await alpha(page, '.pane', 0), 1, 'solid pane stays opaque although the window is glass');
  assert.ok(Math.abs((await alpha(page, '.pane', 1)) - 0.3) < 0.02, 'default pane follows the window 30%');
  assert.ok(Math.abs((await alpha(page, '.pane', 2)) - 0.8) < 0.02, 'own glass 80%');
  assert.equal(await blur(page, 0), 'none');
  assert.equal(await blur(page, 1), 'blur(12px)');
  assert.equal(await blur(page, 2), 'blur(4px)');
  // blocks and the input area inside a pane use that pane's setting
  assert.equal(await alpha(page, '.pane:nth-of-type(1) footer'.replace(':nth-of-type(1)', ''), 0), 1);
  // switching the window off leaves the solid pane solid, the default pane solid, and the glass pane glass
  await page.uncheck('#glass');
  assert.equal(await alpha(page, '.pane', 1), 1);
  assert.ok(Math.abs((await alpha(page, '.pane', 2)) - 0.8) < 0.02);
  assert.equal(await bodyHas(page, 'glass'), false);
  assert.equal(await bodyHas(page, 'backdrop'), true, 'backdrop stays while a pane is glass');
  assert.equal(await alpha(page, 'header'), 1, 'header is window level, so solid again');
  // the panel follows the focused pane
  await headClick(page, 0);
  assert.equal(await page.locator('#pane-mode button.on').innerText(), 'Solid');
  assert.equal(await page.locator('#pane-glass').isVisible(), false);
  await headClick(page, 2);
  assert.equal(await page.locator('#pane-mode button.on').innerText(), 'Glass');
  assert.equal(await page.locator('#pane-opacity').inputValue(), '80');
});

t('a pane with its own glass keeps working with no window glass, and going back to Window removes the backdrop', async (page) => {
  await openPanel(page);
  await setMode(page, 'glass');
  assert.equal(await bodyHas(page, 'backdrop'), true);
  assert.equal(await bodyHas(page, 'glass'), false);
  assert.ok((await alpha(page, '.pane')) < 1);
  await setMode(page, 'window');
  assert.equal(await bodyHas(page, 'backdrop'), false);
  assert.equal(await alpha(page, '.pane'), 1);
});

t('the pane header button opens the panel for that pane', async (page) => {
  await splitRight(page);
  await page.locator('.pane').nth(1).locator('.pane-fx').click();
  assert.equal(await panelOpen(page), true);
  assert.equal(await page.evaluate(() => window.__brick.app.panes().indexOf(window.__brick.app.focused)), 1);
  await setMode(page, 'solid');
  assert.equal(await page.evaluate(() => window.__brick.app.panes().map((s) => s.fx.mode).join()), 'window,solid');
});

t('new panes follow the window setting; a moved pane keeps its own', async (page) => {
  await openPanel(page);
  await page.check('#glass'); await setRange(page, '#glass-opacity', 35);
  await page.click('#split-right'); await page.waitForFunction(() => window.__brick.app.panes().length === 2); await ready(page);
  assert.ok(Math.abs((await alpha(page, '.pane', 1)) - 0.35) < 0.02, 'a new pane is glass like the window');
  await setMode(page, 'solid');
  await page.click('#ap-close');
  await page.locator('.pane').nth(1).locator('.pane-pop').click();   // pop it out into its own tab
  await page.waitForFunction(() => window.__brick.app.tabs.length === 2);
  assert.equal(await page.evaluate(() => window.__brick.app.focused.fx.mode), 'solid');
  assert.equal(await alpha(page, '.tab-content:not(.hidden) .pane'), 1);
});

t('terminal text stays readable: no opaque layer inside a terminal in glass mode', async (page) => {
  await openPanel(page);
  await page.check('#glass'); await setRange(page, '#glass-opacity', 30);
  await page.locator('.input').first().click();
  await page.keyboard.type('echo glass-ok'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /glass-ok/.test([...document.querySelectorAll('.block')].pop()?.innerText || ''));
  assert.ok((await alpha(page, '.block')) < 0.5, 'block background is translucent');
  const opaque = await page.evaluate(() => [...document.querySelectorAll('.block-body *, .input *')]
    .filter((el) => { const m = getComputedStyle(el).backgroundColor.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/); return m && (m[4] ?? 1) > 0.5 && !el.closest('.xterm-rows span') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).opacity !== '0'; })   // skip invisible helpers
    .map((el) => `${el.className} ${getComputedStyle(el).backgroundColor}`));
  assert.deepEqual(opaque, []);
});

t('window settings survive a reload', async (page) => {
  await openPanel(page);
  await page.check('#glass'); await setRange(page, '#glass-opacity', 55); await setRange(page, '#glass-blur', 7);
  await page.reload(); await ready(page);
  assert.equal(await bodyHas(page, 'glass'), true);
  assert.equal(await panelOpen(page), false, 'the panel itself starts closed');
  await openPanel(page);
  assert.equal(await page.locator('#glass-opacity').inputValue(), '55');
  assert.equal(await page.locator('#glass-blur').inputValue(), '7');
});

const backdrop = (page) => page.evaluate(() => document.body.style.getPropertyValue('--bd'));
t('Desktop button: counts down, then uses the server capture as the backdrop; Reset restores the gradient', async (page) => {
  await openPanel(page);
  await page.evaluate(() => { window.__brick.captureDelay = 1; });
  assert.equal(await backdrop(page), '');
  await page.click('#bd-capture');
  assert.match(await page.locator('#bd-capture').innerText(), /Hide this window/);
  await page.waitForFunction(() => document.body.style.getPropertyValue('--bd').includes('blob:'));
  assert.match(await backdrop(page), /url\("blob:.*"\) center \/ cover no-repeat/);
  assert.equal(await page.locator('#bd-capture').innerText(), 'Desktop');
  assert.equal(await page.locator('#bd-reset').isVisible(), true);
  const bytes = await page.evaluate(async () => { const u = document.body.style.getPropertyValue('--bd').match(/url\("(.*?)"\)/)[1]; return (await (await fetch(u)).arrayBuffer()).byteLength; });
  assert.equal(bytes, JPEG.length);
  await sleep(300);
  await page.reload(); await ready(page);
  await page.waitForFunction(() => document.body.style.getPropertyValue('--bd').includes('blob:'));   // persisted in IndexedDB
  await openPanel(page);
  await page.click('#bd-reset');
  assert.equal(await backdrop(page), '');
  assert.equal(await page.locator('#bd-reset').isVisible(), false);
  await sleep(300);
  await page.reload(); await ready(page); await sleep(300);
  assert.equal(await backdrop(page), '', 'reset is remembered too');
});

t('Image button: a chosen file becomes the backdrop', async (page) => {
  await openPanel(page);
  await page.locator('#bd-input').setInputFiles({ name: 'wall.jpg', mimeType: 'image/jpeg', buffer: JPEG });
  await page.waitForFunction(() => document.body.style.getPropertyValue('--bd').includes('blob:'));
  assert.equal(await page.locator('#bd-reset').isVisible(), true);
});

t('a failed capture shows the server message and leaves the backdrop alone', async (page) => {
  await openPanel(page);
  await page.route('**/capture*', (route) => route.fulfill({ status: 500, body: 'Capture failed. Allow Screen Recording' }));
  await page.evaluate(() => { window.__brick.captureDelay = 0; });
  const dialog = page.waitForEvent('dialog');
  await page.click('#bd-capture');
  const d = await dialog;
  assert.match(d.message(), /Screen Recording/);
  await d.dismiss();
  assert.equal(await backdrop(page), '');
  assert.equal(await page.locator('#bd-capture').isEnabled(), true);
});

t('the panel can be dragged by its title and stays where it was put', async (page) => {
  await openPanel(page);
  const before = await page.locator('#appearance-panel').boundingBox();
  await page.mouse.move(before.x + 60, before.y + 14); await page.mouse.down();
  await page.mouse.move(before.x - 300, before.y + 150, { steps: 8 }); await page.mouse.up();
  const after = await page.locator('#appearance-panel').boundingBox();
  assert.ok(Math.abs(after.x - (before.x - 360)) < 4 && Math.abs(after.y - (before.y + 136)) < 4, JSON.stringify({ before, after }));
  await page.click('#ap-close'); await page.click('#appearance');
  assert.ok(Math.abs((await page.locator('#appearance-panel').boundingBox()).x - after.x) < 1, 'reopens in the same place');
});
