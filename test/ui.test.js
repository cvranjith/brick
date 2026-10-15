// End-to-end: headless Chrome drives the real page against the real server and zsh.
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
  page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__brick.session && window.__brick.session.cwd, null, { timeout: 15000 });
});
test.after(async () => { await browser?.close(); srv?.close(); });

const t = (name, fn) => test(name, { skip: !hasChrome && 'Chrome not installed' }, fn);
async function run(cmd) {
  const before = await page.locator('.block').count();
  await page.waitForFunction(() => window.__brick.session.active === null);
  await page.keyboard.type(cmd);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('.block').length === n + 1, before);
  return page.locator('.block').nth(before);
}
const done = (blk) => blk.evaluate((el) => new Promise((r) => { const c = () => (el.classList.contains('running') ? setTimeout(c, 50) : r()); c(); }));
// The DOM renderer paints on the next animation frame, so wait for the text instead of sampling once.
const text = async (blk, re) => {
  for (let i = 0; i < 60; i++) {
    const t = await blk.locator('.xterm-rows').innerText();
    if (!re || re.test(t)) return t;
    await new Promise((r) => setTimeout(r, 50));
  }
  return blk.locator('.xterm-rows').innerText();
};

t('simple command becomes a block with command, output, success badge, duration', async () => {
  const b = await run('echo hello-ui');
  await done(b);
  assert.equal(await b.locator('.cmd').innerText(), 'echo hello-ui');
  assert.match(await text(b, /hello-ui/), /hello-ui/);
  assert.equal(await b.locator('.badge').innerText(), '✓');
  assert.match(await b.locator('.meta').innerText(), /^\d+\.\d\ds$/);
});

t('multiline output: one block, three lines, sized to content', async () => {
  const b = await run(`printf 'one\\ntwo\\nthree\\n'`);
  await done(b);
  const lines = (await text(b, /three/)).split('\n').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(lines, ['one', 'two', 'three']);
  const rows = await b.evaluate((el) => el.querySelectorAll('.xterm-rows > div').length);
  assert.equal(rows, 3);
});

t('failed command: red block and the exit code', async () => {
  const b = await run('sh -c "echo oops >&2; exit 3"');
  await done(b);
  assert.ok(await b.evaluate((el) => el.classList.contains('bad')));
  assert.equal(await b.locator('.badge').innerText(), '✗ 3');
  assert.match(await text(b, /oops/), /oops/);
});

t('long-running command: live running state, then final duration', async () => {
  const b = await run('sleep 1.5');
  assert.ok(await b.evaluate((el) => el.classList.contains('running')));
  await done(b);
  const secs = parseFloat(await b.locator('.meta').innerText());
  assert.ok(secs >= 1.4 && secs < 4, `duration ${secs}`);
});

t('interactive: keystrokes go to the running command, not the prompt', async () => {
  const b = await run('read -r name; echo hi-$name');
  await page.waitForTimeout(300);
  await page.keyboard.type('bob');
  await page.keyboard.press('Enter');
  await done(b);
  assert.match(await text(b, /hi-bob/), /hi-bob/);
});

t('interactive: full-screen (alternate screen) program gets an overlay and releases it', async () => {
  const b = await run(`printf '\\033[?1049h\\033[Hfullscreen-demo'; sleep 1.5; printf '\\033[?1049l'`);
  await page.waitForSelector('.block.overlay', { timeout: 5000 });
  const box = await page.locator('.block.overlay').boundingBox();
  assert.ok(box.width >= 1090 && box.height >= 700, `overlay ${JSON.stringify(box)}`);
  await page.screenshot({ path: new URL('../docs/overlay.png', import.meta.url).pathname });
  await done(b);
  assert.equal(await page.locator('.block.overlay').count(), 0);
  assert.equal(await b.locator('.badge').innerText(), '✓');
});

t('real full-screen program: less opens an overlay, responds to keys, q returns to blocks', async () => {
  const b = await run('less /etc/services');
  await page.waitForSelector('.block.overlay', { timeout: 5000 });
  await page.waitForTimeout(500);
  assert.match(await text(b, /\S/), /\S/);
  await page.keyboard.press('Space');            // page down: proves keys reach less
  await page.waitForTimeout(300);
  await page.keyboard.press('q');
  await done(b);
  assert.equal(await page.locator('.block.overlay').count(), 0);
  assert.equal(await b.locator('.badge').innerText(), '✓');
});

t('example: analogue clock draws in an overlay, keeps updating, and exits cleanly', async () => {
  const script = new URL('../examples/analog-clock.py', import.meta.url).pathname;
  const b = await run(`python3 ${script} --seconds 3`);
  await page.waitForSelector('.block.overlay', { timeout: 8000 });
  const snap = () => page.evaluate(() => { const t = document.querySelector('.block.overlay .xterm-rows').innerText; return { dots: (t.match(/[\u2801-\u28ff]/g) || []).length, caption: (t.match(/\d\d:\d\d:\d\d/) || [])[0] }; });
  await page.waitForTimeout(600);
  const a = await snap();
  await page.waitForTimeout(1300);
  const c = await snap();
  assert.ok(a.dots > 100, `clock face drawn (${a.dots} braille cells)`);
  assert.ok(a.caption && c.caption && a.caption !== c.caption, `caption advanced ${a.caption} -> ${c.caption}`);
  await page.screenshot({ path: new URL('../docs/analog-clock.png', import.meta.url).pathname });
  await done(b);
  assert.equal(await page.locator('.block.overlay').count(), 0);
  assert.equal(await b.locator('.badge').innerText(), '✓');
});

t('Ctrl-C interrupts a running block (exit 130) and the prompt returns', async () => {
  const b = await run('sleep 30');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+C');
  await done(b);
  assert.equal(await b.locator('.badge').innerText(), '✗ 130');
  await page.waitForFunction(() => window.__brick.session.active === null);
});

t('regression: tall blocks keep their full height when many blocks exist', async () => {
  const b = await run('seq 1 120');
  await done(b);
  await text(b, /120/);
  const h = (await b.boundingBox()).height;
  assert.ok(h > 120 * 12, `block squashed to ${h}px`);   // 120 lines at ~15px each
});

t('screenshot of a few blocks', async () => {
  await run('ls /usr | head -5').then(done);
  await page.screenshot({ path: new URL('../docs/blocks.png', import.meta.url).pathname });
});
