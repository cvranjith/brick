// Command history must land in the user's real history file (not the temp ZDOTDIR) and survive the pane closing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server.js';

test('history is written to the original ZDOTDIR even when the websocket just drops', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brick-hist-'));
  process.env.ZDOTDIR = home;                      // stands in for the user's dotfile dir
  process.env.BRICK_ZSHRC = path.join(home, 'none'); // no extra config
  const srv = await startServer({ port: 0 });
  try {
    const u = new URL(srv.url);
    const ws = new WebSocket(`ws://${u.host}/ws?t=${srv.token}`, { origin: `http://${u.host}` });
    let out = '';
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'o') out += m.d; });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    const waitOut = async (re) => { for (let i = 0; i < 100 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 100)); assert.match(out, re); };
    await waitOut(/\$d[0-9a-f]+/);   // first prompt hook arrived
    ws.send(JSON.stringify({ type: 'input', data: 'echo history-probe-123\r' }));
    await waitOut(/history-probe-123/);
    await new Promise((r) => setTimeout(r, 500));
    ws.close();                                    // like a browser hard refresh
    const file = path.join(home, '.zsh_history');
    for (let i = 0; i < 50 && !(fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('history-probe-123')); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(file), 'history file created in the original ZDOTDIR');
    assert.match(fs.readFileSync(file, 'utf8'), /echo history-probe-123/);
  } finally { srv.close(); delete process.env.ZDOTDIR; delete process.env.BRICK_ZSHRC; }
});
