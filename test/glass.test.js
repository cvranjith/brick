// Appearance: one panel, background kinds (Desktop, Image, Capture, Solid, Blend), whole tab or focused pane. Real server, headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../server.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
let srv, browser;
const kinds = [];   // which kind of picture the page asked the server for
test.before(async () => {
  if (!hasChrome) return;
  srv = await startServer({ port: 0, capture: async (kind) => { kinds.push(kind); return JPEG; } });
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
const tint = (page, n = 0) => alpha(page, '.pane .pane-tint', n);
const layer = (page, n = 0) => page.locator('.pane').nth(n).evaluate((el) => el.style.getPropertyValue('--layer'));
const blur = (page, n = 0) => page.locator('.pane .pane-bg').nth(n).evaluate((el) => getComputedStyle(el).filter);
const bg = (page, kind) => page.click(`#bg-kind button[data-bg="${kind}"]`);
const scopeTo = (page, sc) => page.click(`#scope button[data-scope="${sc}"]`);
const setColour = (page, n, v) => page.locator('#colors input').nth(n).evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
const near = (a, b) => Math.abs(a - b) < 0.02;
async function splitRight(page) { await page.click('#split-right'); await page.waitForFunction(() => window.__brick.app.panes().length === 2); await ready(page); }
const headClick = (page, n) => page.locator('.pane').nth(n).locator('.pane-head').click({ position: { x: 20, y: 8 } });   // left edge: the panel may cover the right
const moveAside = (page) => page.locator('#appearance-panel').evaluate((el) => { el.style.right = 'auto'; el.style.left = '10px'; el.style.top = '300px'; });

t('default: plain dark panes, panel closed, no controls on screen, no per-pane button', async (page) => {
  assert.equal(await tint(page), 1);
  assert.equal(await layer(page), 'none');
  assert.equal(await panelOpen(page), false);
  assert.equal(await page.locator('header input').count(), 0, 'no sliders permanently in the header');
  assert.equal(await page.locator('.pane-head button').count(), 2, 'only pop-out and close in a pane header');
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

t('one opacity and one blur slider, five backgrounds, two scopes', async (page) => {
  await openPanel(page);
  assert.equal(await page.locator('#appearance-panel input[type=range]').count(), 2);
  assert.deepEqual(await page.locator('#bg-kind button').allInnerTexts(), ['Desktop', 'Image', 'Capture', 'Solid', 'Blend']);
  assert.deepEqual(await page.locator('#scope button').allInnerTexts(), ['Whole tab', 'Focused pane']);
  assert.equal(await page.locator('#bg-kind button.on').innerText(), 'Solid');
  assert.equal(await page.locator('#scope button.on').innerText(), 'Whole tab');
});

t('Blend: three colours, opacity and blur apply to every pane; Solid: one colour; Reset', async (page) => {
  await splitRight(page); await openPanel(page);
  await bg(page, 'blend');
  assert.equal(await page.locator('#colors input').count(), 3);
  assert.match(await layer(page, 0), /radial-gradient/);
  assert.match(await layer(page, 1), /radial-gradient/, 'every pane in the tab');
  assert.ok(near(await tint(page, 0), 0.6), 'a picture is not visible behind an opaque pane, so opacity drops to 60%');
  await setColour(page, 0, '#ff0000');
  assert.match(await layer(page, 1), /rgb\(255, 0, 0\)|#ff0000/);
  await setRange(page, '#opacity', 35); await setRange(page, '#blur', 9);
  assert.ok(near(await tint(page, 1), 0.35));
  assert.equal(await blur(page, 1), 'blur(9px)');
  assert.equal(await page.locator('#opacity-out').innerText(), '35%');
  await bg(page, 'solid');
  assert.equal(await page.locator('#colors input').count(), 1);
  assert.equal(await page.locator('#blur').isDisabled(), true, 'nothing to blur behind a plain colour');
  assert.equal(await layer(page, 0), 'none');
  await setColour(page, 0, '#336699'); await setRange(page, '#opacity', 100);
  assert.equal(await page.locator('.pane').first().evaluate((el) => el.style.getPropertyValue('--layer-base')), '#336699');
  await page.click('#ap-reset');
  assert.equal(await tint(page), 1);
  assert.equal(await page.locator('.pane').first().evaluate((el) => el.style.getPropertyValue('--layer-base')), '#14161b');
});

t('Desktop: fetches the wallpaper by itself, no countdown and no hiding; it is remembered and refreshed', async (page) => {
  await openPanel(page);
  kinds.length = 0;
  await bg(page, 'desktop');
  await page.waitForFunction(() => /loaded/.test(document.querySelector('#bd-status').textContent));
  assert.deepEqual(kinds, ['wallpaper']);
  assert.match(await layer(page), /url\("blob:/);
  assert.equal(await page.locator('#bd-action').innerText(), 'Refresh');
  const bytes = await page.evaluate(async () => (await (await fetch(document.querySelector('.pane').style.getPropertyValue('--layer').match(/url\("(.*?)"\)/)[1])).arrayBuffer()).byteLength);
  assert.equal(bytes, JPEG.length);
  await sleep(300);
  kinds.length = 0;
  await page.reload(); await ready(page);
  await page.waitForFunction(() => /blob:/.test(document.querySelector('.pane').style.getPropertyValue('--layer')));   // stored picture shows at once
  await page.waitForFunction(() => window.__brick.app.panes().length === 1);
  await sleep(500);
  assert.deepEqual(kinds, ['wallpaper'], 'refreshed on start so it follows wallpaper changes');
});

t('Capture: nothing is taken until you press the button; then a countdown and a screenshot', async (page) => {
  await openPanel(page);
  await page.evaluate(() => { window.__brick.captureDelay = 1; });
  kinds.length = 0;
  await bg(page, 'capture');
  assert.equal(await page.locator('#bd-status').innerText(), 'No screenshot yet');
  await sleep(300);
  assert.deepEqual(kinds, [], 'choosing Capture does not capture');
  await page.click('#bd-action');
  assert.match(await page.locator('#bd-action').innerText(), /Capturing in/);
  await page.waitForFunction(() => /blob:/.test(document.querySelector('.pane').style.getPropertyValue('--layer')));
  assert.deepEqual(kinds, ['screen']);
  assert.equal(await page.locator('#bd-action').innerText(), 'Take screenshot');
  assert.equal(await page.locator('#bd-action').isEnabled(), true);
});

t('Image: choosing Image opens the file chooser; the file becomes the background', async (page) => {
  await openPanel(page);
  const chooser = page.waitForEvent('filechooser');
  await bg(page, 'image');
  await (await chooser).setFiles({ name: 'wall.jpg', mimeType: 'image/jpeg', buffer: JPEG });
  await page.waitForFunction(() => /blob:/.test(document.querySelector('.pane').style.getPropertyValue('--layer')));
  assert.equal(await page.locator('#bd-action').innerText(), 'Choose file…');
  await sleep(300); await page.reload(); await ready(page);
  await page.waitForFunction(() => /blob:/.test(document.querySelector('.pane').style.getPropertyValue('--layer')));   // kept in this browser
});

t('a failed capture shows the server message in the panel and changes nothing else', async (page) => {
  await openPanel(page);
  await page.route('**/capture*', (route) => route.fulfill({ status: 500, body: 'Capture failed. Allow Screen Recording' }));
  await bg(page, 'desktop');
  await page.waitForFunction(() => /Screen Recording/.test(document.querySelector('#bd-msg').textContent));
  assert.equal(await page.locator('#bd-msg').isVisible(), true);
  assert.equal(await layer(page), 'none');
  assert.equal(await page.locator('#bd-action').isEnabled(), true);
});

t('Focused pane scope changes only that pane; Follow tab undoes it; Whole tab overrides every pane again', async (page) => {
  await splitRight(page); await page.click('#split-right'); await page.waitForFunction(() => window.__brick.app.panes().length === 3); await ready(page);
  await openPanel(page); await moveAside(page);
  await bg(page, 'blend');                                   // whole tab: all three
  await headClick(page, 1); await scopeTo(page, 'pane');
  assert.equal(await page.locator('#ap-pane-reset').isVisible(), false, 'no own look yet');
  await bg(page, 'solid'); await setColour(page, 0, '#550055');
  assert.match(await layer(page, 0), /radial/);
  assert.equal(await layer(page, 1), 'none');
  assert.match(await layer(page, 2), /radial/);
  assert.equal(await page.locator('#ap-pane-reset').isVisible(), true);
  await headClick(page, 2);                                  // the panel follows the focused pane: it shows the tab look
  assert.equal(await page.locator('#bg-kind button.on').innerText(), 'Blend');
  await headClick(page, 1);
  assert.equal(await page.locator('#bg-kind button.on').innerText(), 'Solid');
  await page.click('#ap-pane-reset');
  assert.match(await layer(page, 1), /radial/, 'follows the tab again');
  await bg(page, 'solid');                                   // own look again, then override from the tab scope
  assert.equal(await layer(page, 1), 'none');
  await scopeTo(page, 'tab'); await setRange(page, '#opacity', 50);
  assert.ok(near(await tint(page, 0), 0.5) && near(await tint(page, 1), 0.5) && near(await tint(page, 2), 0.5), 'all panes');
  assert.equal(await page.evaluate(() => window.__brick.app.panes().every((s) => s.look === null)), true);
});

t('each tab has its own look; new tabs start with the look you last chose', async (page) => {
  await openPanel(page);
  await bg(page, 'blend'); await setRange(page, '#opacity', 45);
  await page.click('#new-tab'); await page.waitForFunction(() => window.__brick.app.tabs.length === 2); await ready(page);
  assert.match(await page.locator('.tab-content:not(.hidden) .pane').evaluate((el) => el.style.getPropertyValue('--layer')), /radial/, 'new tab inherits');
  assert.equal(await page.locator('#bg-kind button.on').innerText(), 'Blend');
  await bg(page, 'solid');
  await page.locator('#tabs .tab').first().click();
  assert.match(await page.locator('.tab-content:not(.hidden) .pane').evaluate((el) => el.style.getPropertyValue('--layer')), /radial/, 'the first tab is unchanged');
});

t('Alt+Shift+G flips the tab between plain and its picture look', async (page) => {
  await page.locator('.input').first().click();
  await page.keyboard.press('Alt+Shift+KeyG');
  assert.match(await layer(page), /radial/);
  await page.keyboard.press('Alt+Shift+KeyG');
  assert.equal(await layer(page), 'none');
  assert.equal(await tint(page), 1);
});

t('a pane that moves to another tab keeps its own look, and otherwise takes the new tab look', async (page) => {
  await splitRight(page); await openPanel(page); await moveAside(page);
  await headClick(page, 1); await scopeTo(page, 'pane'); await bg(page, 'blend');
  await page.click('#ap-close');
  await page.locator('.pane').nth(1).locator('.pane-pop').click();
  await page.waitForFunction(() => window.__brick.app.tabs.length === 2);
  assert.match(await page.locator('.tab-content:not(.hidden) .pane').evaluate((el) => el.style.getPropertyValue('--layer')), /radial/, 'own look moved with it');
});

t('terminal text stays readable: no opaque layer inside a terminal over a picture', async (page) => {
  await openPanel(page);
  await bg(page, 'blend'); await setRange(page, '#opacity', 30);
  await page.locator('.input').first().click();
  await page.keyboard.type('echo glass-ok'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /glass-ok/.test([...document.querySelectorAll('.block')].pop()?.innerText || ''));
  assert.ok((await alpha(page, '.block')) < 0.5, 'block background is translucent');
  const opaque = await page.evaluate(() => [...document.querySelectorAll('.block-body *, .input *')]
    .filter((el) => { const m = getComputedStyle(el).backgroundColor.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/); return m && (m[4] ?? 1) > 0.5 && !el.closest('.xterm-rows span') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).opacity !== '0'; })   // skip invisible helpers
    .map((el) => `${el.className} ${getComputedStyle(el).backgroundColor}`));
  assert.deepEqual(opaque, []);
});

t('the tab look survives a reload (the panel itself starts closed)', async (page) => {
  await openPanel(page);
  await bg(page, 'blend'); await setColour(page, 1, '#00ff00'); await setRange(page, '#opacity', 55); await setRange(page, '#blur', 7);
  await page.reload(); await ready(page);
  assert.equal(await panelOpen(page), false);
  assert.ok(near(await tint(page), 0.55));
  await openPanel(page);
  assert.equal(await page.locator('#bg-kind button.on').innerText(), 'Blend');
  assert.equal(await page.locator('#blur').inputValue(), '7');
  assert.equal(await page.locator('#colors input').nth(1).inputValue(), '#00ff00');
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
