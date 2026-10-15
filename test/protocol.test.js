// Phase 3 scenarios at the protocol level: real server, real zsh on a pty, hooks parsed
// with the same splitter the browser uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../server.js';
import { HookSplitter } from '../public/splitter.js';

class Session {
  constructor(srv) {
    this.events = []; this.waiters = []; this.t0 = Date.now();
    const u = new URL(srv.url);
    this.ws = new WebSocket(`ws://${u.host}/ws?t=${srv.token}`, { origin: `http://${u.host}` });
    this.splitter = new HookSplitter({
      onData: (text) => this.add({ kind: 'data', text }),
      onHook: (hook) => this.add({ kind: 'hook', ...hook }),
    });
    this.ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'o') this.splitter.push(m.d); });
    this.opened = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
  }
  add(e) { e.at = performance.now(); this.events.push(e); this.waiters = this.waiters.filter((w) => !w.check()); }
  waitFor(pred, ms = 8000, label = 'event') {
    return new Promise((resolve, reject) => {
      const check = () => { const e = this.events.find(pred); if (e) { resolve(e); return true; } return false; };
      if (check()) return;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}; got ${JSON.stringify(this.events.slice(-6))}`)), ms);
      this.waiters.push({ check: () => (check() ? (clearTimeout(timer), true) : false) });
    });
  }
  send(data) { this.ws.send(JSON.stringify({ type: 'input', data })); }
  // Run a command, return what happened between its Preexec and CommandFinished.
  async run(cmd, { during, ms = 8000 } = {}) {
    await this.waitFor((e) => e.kind === 'hook' && e.hook === 'Precmd' && e.seen !== 'x' && !e.claimed, ms, 'prompt');
    const mark = this.events.length;
    this.events.filter((e) => e.hook === 'Precmd').forEach((e) => { e.claimed = true; });
    this.send(cmd + '\r');
    const pre = await this.waitFor((e) => this.events.indexOf(e) >= mark && e.hook === 'Preexec', ms, 'Preexec');
    if (during) await during();
    const fin = await this.waitFor((e) => this.events.indexOf(e) >= mark && e.hook === 'CommandFinished', ms, 'CommandFinished');
    const from = this.events.indexOf(pre), to = this.events.indexOf(fin);
    const output = this.events.slice(from, to).filter((e) => e.kind === 'data').map((e) => e.text).join('');
    return { pre, fin, output, exit: fin.value.exit_code, ms: fin.at - pre.at };
  }
}

let srv, s;
test.before(async () => { srv = await startServer({ port: 0 }); s = new Session(srv); await s.opened; });
test.after(() => { s.ws.close(); srv.close(); });

test('simple command: hooks fire in order with command text and exit 0', async () => {
  const r = await s.run('echo hello-brick');
  assert.equal(r.pre.value.command, 'echo hello-brick');
  assert.equal(r.exit, 0);
  assert.match(r.output, /hello-brick/);
  assert.match(r.fin.value.next_block_id, /^precmd-1-\d+$/);
});

test('multiline output stays inside one block', async () => {
  const r = await s.run(`printf 'a\\nb\\nc\\n'`);
  assert.equal(r.exit, 0);
  assert.match(r.output.replace(/\r/g, ''), /a\nb\nc\n/);
});

test('failed command reports its exit status', async () => {
  assert.equal((await s.run('false')).exit, 1);
  assert.equal((await s.run('sh -c "exit 7"')).exit, 7);
  assert.equal((await s.run('definitely-not-a-command-xyz')).exit, 127);
});

test('long-running command: duration is measurable from the hooks', async () => {
  const r = await s.run('sleep 1.2');
  assert.equal(r.exit, 0);
  assert.ok(r.ms >= 1100 && r.ms < 3000, `duration ${r.ms}ms`);
});

test('interactive: stdin typed while the command runs reaches it', async () => {
  const r = await s.run('read -r line; echo got:$line', { during: async () => { await new Promise((x) => setTimeout(x, 300)); s.send('xyz\r'); } });
  assert.match(r.output, /got:xyz/);
});

test('interactive: Ctrl-D ends cat, Ctrl-C interrupts sleep (exit 130)', async () => {
  const cat = await s.run('cat', { during: async () => { await new Promise((x) => setTimeout(x, 300)); s.send('hi\r'); await new Promise((x) => setTimeout(x, 200)); s.send('\x04'); } });
  assert.equal(cat.exit, 0);
  assert.match(cat.output, /hi/);
  const slp = await s.run('sleep 30', { during: async () => { await new Promise((x) => setTimeout(x, 300)); s.send('\x03'); } });
  assert.equal(slp.exit, 130);
});

test('interactive: alternate-screen programs are visible in the stream', async () => {
  const r = await s.run(`printf '\\033[?1049h'; sleep 0.2; printf '\\033[?1049l'`);
  assert.ok(r.output.includes('\x1b[?1049h') && r.output.includes('\x1b[?1049l'));
});

test('commands with quotes, backslashes and unicode survive the hook', async () => {
  const cmd = `echo "q\\\\x" 'é☃'`;
  const r = await s.run(cmd);
  assert.equal(r.pre.value.command, cmd);
});

test('security: wrong token, wrong origin and missing token are rejected', async () => {
  const u = new URL(srv.url);
  const attempt = (query, origin) => new Promise((res) => {
    const ws = new WebSocket(`ws://${u.host}/ws${query}`, { origin });
    ws.on('open', () => { ws.close(); res('open'); });
    ws.on('error', () => res('rejected'));
  });
  assert.equal(await attempt('?t=wrong', `http://${u.host}`), 'rejected');
  assert.equal(await attempt('', `http://${u.host}`), 'rejected');
  assert.equal(await attempt(`?t=${srv.token}`, 'http://evil.example'), 'rejected');
  const res = await fetch(`http://${u.host}/`);
  assert.equal(res.status, 403);
});
