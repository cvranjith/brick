// Brick backend: serves the UI and bridges one WebSocket to one zsh running on a pty.
// Security: a shell reachable from a web page is remote code execution, so we
// bind to loopback only, require a random token, and check Host and Origin.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';

const root = path.dirname(fileURLToPath(import.meta.url));
const nm = (p) => path.join(root, 'node_modules', p);
const FILES = {
  '/': ['public/index.html', 'text/html'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/splitter.js': ['public/splitter.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/vendor/xterm.js': [nm('@xterm/xterm/lib/xterm.js'), 'text/javascript'],
  '/vendor/xterm.css': [nm('@xterm/xterm/css/xterm.css'), 'text/css'],
  '/vendor/addon-fit.js': [nm('@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript'],
};

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

export function startServer({ port = 4477, host = '127.0.0.1', shell = process.env.SHELL || '/bin/zsh', cwd = os.homedir() } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  let nextSession = 1;   // each WebSocket (tab/pane) is its own shell with its own session id
  let allowedHosts = [];
  const hostOk = (h) => allowedHosts.includes(h);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const entry = FILES[url.pathname];
    if (!hostOk(req.headers.host) || !entry) { res.writeHead(404).end('not found'); return; }
    if (url.pathname === '/' && url.searchParams.get('t') !== token) { res.writeHead(403).end('missing or bad token'); return; }
    res.writeHead(200, { 'content-type': entry[1] + '; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(path.isAbsolute(entry[0]) ? entry[0] : path.join(root, entry[0])).pipe(res);
  });

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
