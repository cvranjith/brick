// Brick backend: serves the UI and bridges one WebSocket to one zsh running on a pty.
// Security: a shell reachable from a web page is remote code execution, so we
// bind to loopback only, require a random token, and check Host and Origin.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import * as fsapi from './fsapi.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const nm = (p) => path.join(root, 'node_modules', p);
const FILES = {
  '/': ['public/index.html', 'text/html'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/splitter.js': ['public/splitter.js', 'text/javascript'],
  '/files.js': ['public/files.js', 'text/javascript'],
  '/docview.js': ['public/docview.js', 'text/javascript'],
  '/vendor/highlight.js': [nm('@highlightjs/cdn-assets/highlight.min.js'), 'text/javascript'],
  '/vendor/hljs.css': [nm('@highlightjs/cdn-assets/styles/github-dark.min.css'), 'text/css'],
  '/vendor/marked.js': [nm('marked/lib/marked.umd.js'), 'text/javascript'],
  '/vendor/purify.js': [nm('dompurify/dist/purify.min.js'), 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/vendor/xterm.js': [nm('@xterm/xterm/lib/xterm.js'), 'text/javascript'],
  '/vendor/xterm.css': [nm('@xterm/xterm/css/xterm.css'), 'text/css'],
  '/vendor/addon-fit.js': [nm('@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript'],
};

// Defence in depth: the page can reach a shell, so even if untrusted file contents (markdown, filenames...) slipped some markup
// through, no script from anywhere but this server may run, and nothing may be sent anywhere else.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

// ZDOTDIR trick: zsh reads our proxy dotfiles, which source the user's real ones,
// then ~/.brick/zshrc (optional, Brick-only config such as oh-my-zsh), then the Brick hooks last.
function makeZdotdir(origZdotdir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brick-zsh-'));
  const proxy = (name, extra = '') => fs.writeFileSync(path.join(dir, name),
    `[[ -f "$BRICK_ORIG_ZDOTDIR/${name}" ]] && source "$BRICK_ORIG_ZDOTDIR/${name}"\n${extra}`);
  proxy('.zshenv');
  proxy('.zprofile');
  proxy('.zlogin');
  const extraRc = process.env.BRICK_ZSHRC || path.join(os.homedir(), '.brick', 'zshrc');
  // macOS /etc/zshrc points HISTFILE at ${ZDOTDIR}/.zsh_history, i.e. our temp dir, so set it back to the
  // real location here: after /etc/zshrc, before the user's own .zshrc (which may override it).
  proxy('.zshrc', `[[ -f ${JSON.stringify(extraRc)} ]] && source ${JSON.stringify(extraRc)}\n` +
    `source ${JSON.stringify(path.join(root, 'shell/brick.zsh'))}\n`);
  const zshrc = path.join(dir, '.zshrc');
  fs.writeFileSync(zshrc, 'HISTFILE="$BRICK_ORIG_ZDOTDIR/.zsh_history"\n' + fs.readFileSync(zshrc, 'utf8'));
  return dir;
}

const run = (cmd, args, timeout) => new Promise((resolve, reject) => execFile(cmd, args, { timeout }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));

// The wallpaper helper (tools/wallpaper.swift) is compiled once into ~/.brick/bin and rebuilt when its source changes.
let helperReady;
function wallpaperHelper() {
  const src = path.join(root, 'tools', 'wallpaper.swift'), bin = path.join(os.homedir(), '.brick', 'bin', 'wallpaper');
  helperReady ??= (async () => {
    const fresh = fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs;
    if (!fresh) { fs.mkdirSync(path.dirname(bin), { recursive: true }); await run('swiftc', ['-O', src, '-o', bin], 180000); }
    return bin;
  })().catch((e) => { helperReady = undefined; throw e; });
  return helperReady;
}

// Pictures of the screen as JPEG bytes. Both need Screen Recording permission for the app that runs Brick.
//   'wallpaper': only the desktop picture, without any windows, so nothing has to be hidden (ScreenCaptureKit helper)
//   'screen':    everything visible right now (macOS `screencapture`)
async function captureDesktop(kind = 'screen') {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brick-shot-')), 'shot.jpg');
  try {
    if (kind === 'wallpaper') await run(await wallpaperHelper(), [file], 20000);
    else await run('screencapture', ['-x', '-t', 'jpg', file], 15000);
    return fs.readFileSync(file);   // throws if nothing was written (permission denied)
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }   // the picture is never kept on disk
}

export function startServer({ port = 4477, host = '127.0.0.1', shell = process.env.SHELL || '/bin/zsh', cwd = os.homedir(), capture = captureDesktop } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  let nextSession = 1;   // each WebSocket (tab/pane) is its own shell with its own session id
  let allowedHosts = [];
  const hostOk = (h) => allowedHosts.includes(h);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/capture') return handleCapture(req, res, url);
    if (url.pathname.startsWith('/fs/')) return handleFs(req, res, url);
    const entry = FILES[url.pathname];
    if (!hostOk(req.headers.host) || !entry) { res.writeHead(404).end('not found'); return; }
    if (url.pathname === '/' && url.searchParams.get('t') !== token) { res.writeHead(403).end('missing or bad token'); return; }
    res.writeHead(200, { 'content-type': entry[1] + '; charset=utf-8', 'cache-control': 'no-store', ...(url.pathname === '/' ? { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } : {}) });
    fs.createReadStream(path.isAbsolute(entry[0]) ? entry[0] : path.join(root, entry[0])).pipe(res);
  });

  // A picture of the user's screen is sensitive: POST only, token + Host + Origin checked, on an explicit click,
  // bytes returned in the response and never stored.
  async function handleCapture(req, res, url) {
    const origin = req.headers.origin;
    if (!hostOk(req.headers.host) || url.searchParams.get('t') !== token || !allowedHosts.some((h) => origin === `http://${h}`)) { res.writeHead(403).end('forbidden'); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end('POST only'); return; }
    const kind = url.searchParams.get('kind') || 'screen';
    if (kind !== 'screen' && kind !== 'wallpaper') { res.writeHead(400).end('unknown kind'); return; }
    try {
      const img = await capture(kind);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'content-length': img.length }).end(img);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('Capture failed. Allow Screen Recording for the app running Brick (System Settings > Privacy & Security > Screen & System Audio Recording), then restart it. The wallpaper option also needs the Xcode command line tools (xcode-select --install) once, to build its small helper.');
    }
  }

  // File browsing (Files view): POST + JSON body, same token/Host/Origin rules as the shell itself.
  async function handleFs(req, res, url) {
    const origin = req.headers.origin;
    if (!hostOk(req.headers.host) || url.searchParams.get('t') !== token || !allowedHosts.some((h) => origin === `http://${h}`)) { res.writeHead(403).end('forbidden'); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end('POST only'); return; }
    const fail = (e) => { if (!res.headersSent) res.writeHead(e.status || 500, { 'content-type': 'text/plain' }); res.end(e.message); };
    let body = '';
    try {
      for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new fsapi.FsError('request too large', 413); }
      const args = JSON.parse(body || '{}');
      const json = (obj) => res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
      if (url.pathname === '/fs/list') return json(await fsapi.list(args.path));
      if (url.pathname === '/fs/read') return json(await fsapi.read(args.path));
      if (url.pathname === '/fs/search') {
        const ac = new AbortController();
        res.on('close', () => ac.abort());   // the page stopped waiting (Stop, a new search, closed)
        const emit = (o) => {
          if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
          res.write(JSON.stringify(o) + '\n');
        };
        await fsapi.search(args, emit, ac.signal);   // validation errors throw before anything is written
        return res.end();
      }
      res.writeHead(404).end('not found');
    } catch (e) { fail(e instanceof SyntaxError ? new fsapi.FsError('bad JSON') : e); }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const origin = req.headers.origin;
    const ok = url.pathname === '/ws' && url.searchParams.get('t') === token &&
      hostOk(req.headers.host) && allowedHosts.some((h) => origin === `http://${h}`);
    if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws));
  });

  function bridge(ws) {
    const origZdotdir = process.env.ZDOTDIR || os.homedir();
    const zdotdir = makeZdotdir(origZdotdir);
    const term = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color', cols: 100, rows: 6, cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Brick',
        BRICK_SESSION: String(nextSession++), BRICK_ORIG_ZDOTDIR: origZdotdir, ZDOTDIR: zdotdir },
    });
    const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    term.onData((d) => send({ t: 'o', d }));
    term.onExit(({ exitCode }) => { send({ t: 'exit', code: exitCode }); ws.close(); });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'input' && typeof m.data === 'string') term.write(m.data);
      else if (m.type === 'resize' && m.cols > 0 && m.rows > 0) term.resize(Math.min(m.cols, 500) | 0, Math.min(m.rows, 200) | 0);
    });
    ws.on('close', () => { try { term.kill(); } catch {} try { fs.rmSync(zdotdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const p = server.address().port;
      allowedHosts = [`127.0.0.1:${p}`, `localhost:${p}`];
      resolve({ url: `http://127.0.0.1:${p}/?t=${token}`, port: p, token, close: () => { wss.clients.forEach((c) => c.terminate()); server.close(); } });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer({ port: Number(process.env.PORT) || 4477 });
  console.log(`Brick running. Open:\n  ${url}`);
}
