import { HookSplitter } from './splitter.js';

const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const THEME = { background: '#1b1e25', foreground: '#d7dae0', cursor: '#d7dae0', selectionBackground: '#33415c' };
const TERM_OPTS = { fontFamily: '"MesloLGS Nerd Font Mono", "SF Mono", Menlo, Monaco, Consolas, monospace', fontSize: 13, theme: THEME, scrollback: 5000, allowProposedApi: true };
const MAX_ROWS = 2000;   // taller output scrolls inside the block
const INPUT_ROWS = 6;
const token = new URLSearchParams(location.search).get('t');
const $ = (id) => document.getElementById(id);

// ---- shortcuts: Alt+Shift+<key>, chosen so zsh's own Alt bindings (Alt+d, Alt+t...) keep working ----
const KEYS = { KeyT: 'newTab', KeyW: 'closePane', KeyD: 'splitRight', KeyS: 'splitDown', BracketLeft: 'prevPane', BracketRight: 'nextPane' };
function shortcutFor(ev) {
  if (!(ev.altKey && ev.shiftKey) || ev.ctrlKey || ev.metaKey) return null;
  return /^Digit[1-9]$/.test(ev.code) ? ev.code : KEYS[ev.code] || null;
}
function runShortcut(name) {
  if (name.startsWith('Digit')) return app.switchTo(app.tabs[Number(name.slice(5)) - 1]);
  ({ newTab: () => app.newTab(), closePane: () => app.closePane(app.focused), splitRight: () => app.split('h'),
    splitDown: () => app.split('v'), prevPane: () => app.cyclePane(-1), nextPane: () => app.cyclePane(1) })[name]();
}
function guardKeys(term) {   // keep shortcut keys away from the shell
  term.attachCustomKeyEventHandler((ev) => {
    const name = shortcutFor(ev);
    if (!name) return true;
    if (ev.type === 'keydown') { ev.preventDefault(); runShortcut(name); }
    return false;
  });
}

function updateMeta(block, finished) {
  const secs = ((finished ?? performance.now()) - block.t0) / 1000;
  block.el.querySelector('.meta').textContent = secs < 10 ? `${secs.toFixed(2)}s` : `${secs.toFixed(1)}s`;
}

function lastContentRow(term) {
  const buf = term.buffer.active;
  for (let y = buf.length - 1; y >= 0; y--) {
    const line = buf.getLine(y);
    if (line && line.translateToString(true).trim() !== '') return y;
  }
  return -1;
}
// While running the cursor row must stay visible, otherwise shrinking would scroll text away.
function usedRows(term) {
  const buf = term.buffer.active;
  return Math.max(lastContentRow(term) + 1, buf.baseY + buf.cursorY + 1);
}

// One Session = one pane = one shell (its own WebSocket and pty).
class Session {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'pane';
    this.el.innerHTML = '<div class="pane-head"><span class="pane-cwd"></span><span class="pane-state"></span>' +
      '<button class="pane-close" title="Close pane (Alt+Shift+W)">×</button></div>' +
      '<main class="blocks"></main><footer><div class="input"></div></footer>';
    this.blocksEl = this.el.querySelector('.blocks');
    this.cwd = '';
    this.mode = 'prompt';   // 'prompt' | 'running'
    this.active = null;     // the running block
    this.blocks = [];
    this.cols = 80;
    this.ended = false;
    this.el.addEventListener('mousedown', () => app.focus(this));
    this.el.querySelector('.pane-close').addEventListener('click', (e) => { e.stopPropagation(); app.closePane(this); });
  }

  // Call once the pane is in the DOM and visible, so xterm can measure it.
  start() {
    this.inputTerm = new Terminal({ ...TERM_OPTS, rows: INPUT_ROWS, cursorBlink: true });
    this.inputFit = new FitAddon();
    this.inputTerm.loadAddon(this.inputFit);
    this.inputTerm.open(this.el.querySelector('.input'));
    guardKeys(this.inputTerm);
    this.fit();
    this.inputTerm.onData((data) => this.send({ type: 'input', data }));

    this.splitter = new HookSplitter({
      onData: (text) => (this.mode === 'running' && this.active ? this.writeToBlock(this.active, text) : this.inputTerm.write(text)),
      onHook: (h) => this.onHook(h),
    });
    this.ws = new WebSocket(`ws://${location.host}/ws?t=${token}`);
    this.ws.onopen = () => this.sendSize();
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'o') this.splitter.push(m.d);
      else if (m.t === 'exit') { this.ended = true; app.paneExited(this); }
    };
    this.ws.onclose = () => { if (!this.ended) { const s = this.el.querySelector('.pane-state'); s.textContent = 'disconnected'; s.className = 'pane-state dead'; } };
    // Any size change (window, divider drag, tab switch) re-fits this pane.
    let raf = 0;
    this.observer = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.layout()); });
    this.observer.observe(this.el);
  }

  send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  sendSize(rows) { this.send({ type: 'resize', cols: this.cols, rows: rows ?? this.inputTerm.rows }); }
  visible() { return this.el.offsetWidth > 0 && this.el.offsetHeight > 0; }
  fit() {
    if (!this.visible()) return false;   // hidden tab: keep last known size
    this.inputFit.fit();
    this.cols = this.inputTerm.cols;
    return true;
  }
  layout() {
    if (!this.fit()) return;
    if (this.active && this.active.alt) { this.active.fit.fit(); this.sendSize(this.active.term.rows); }
    else this.sendSize(this.inputTerm.rows);
  }
  target() { return this.mode === 'running' && this.active ? this.active.term : this.inputTerm; }
  focusTerm() { this.target()?.focus(); }   // no-op until start() has created the terminal

  dispose() {
    this.ended = true;
    this.observer?.disconnect();
    try { this.ws?.close(); } catch {}
    for (const b of this.blocks) { clearInterval(b.timer); b.term.dispose(); }
    this.inputTerm?.dispose();
    this.el.remove();
  }

  // ---- blocks ----
  createBlock(command, cwd) {
    const el = document.createElement('section');
    el.className = 'block running';
    el.innerHTML = '<div class="block-head"><span class="badge">●</span><span class="cmd"></span><span class="meta"></span></div><div class="block-body empty"></div>';
    el.querySelector('.cmd').textContent = command;
    el.querySelector('.meta').title = cwd || '';
    this.blocksEl.appendChild(el);
    const body = el.querySelector('.block-body');
    const term = new Terminal({ ...TERM_OPTS, cols: this.cols, rows: 1, cursorBlink: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(body);
    guardKeys(term);
    term.onData((data) => { if (this.active && this.active.term === term) this.send({ type: 'input', data }); });
    const block = { el, body, term, fit, command, t0: performance.now(), alt: false, timer: null };
    term.buffer.onBufferChange((buf) => this.setAlt(block, buf.type === 'alternate'));
    block.timer = setInterval(() => updateMeta(block), 100);
    updateMeta(block);
    this.blocks.push(block);
    return block;
  }

  // Size a block's terminal to its content so each block looks like a card, not a screen.
  relayout(block) {
    if (block.alt) return;
    const rows = Math.min(MAX_ROWS, Math.max(1, usedRows(block.term)));
    if (rows !== block.term.rows) block.term.resize(this.cols, rows);
    const buf = block.term.buffer.active;
    block.body.classList.toggle('empty', lastContentRow(block.term) < 0 && buf.cursorX === 0 && buf.cursorY === 0);
    this.blocksEl.scrollTop = this.blocksEl.scrollHeight;
  }
  // Once the command has finished the cursor no longer matters: park it on the last text row,
  // then trim the empty rows below it.
  settle(block) {
    const buf = block.term.buffer.active;
    const last = lastContentRow(block.term);
    const up = last >= buf.baseY ? buf.cursorY - (last - buf.baseY) : 0;
    const done = () => {
      const rows = Math.min(MAX_ROWS, Math.max(1, last + 1));
      if (rows !== block.term.rows) block.term.resize(this.cols, rows);
      block.body.classList.toggle('empty', last < 0);
      this.blocksEl.scrollTop = this.blocksEl.scrollHeight;
    };
    if (up > 0) block.term.write(`\x1b[${up}A`, done); else done();
  }
  writeToBlock(block, text) {
    if (!block.alt) {  // pre-grow so nothing scrolls out of the viewport before we measure
      const nl = (text.match(/\n/g) || []).length;
      const want = Math.min(MAX_ROWS, usedRows(block.term) + nl + 1);
      if (want > block.term.rows) block.term.resize(this.cols, want);
    }
    block.term.write(text, () => this.relayout(block));
  }

  // Full-screen programs (vim, top, less) switch to the alternate screen: give them the whole pane.
  setAlt(block, alt) {
    if (block.alt === alt) return;
    block.alt = alt;
    block.el.classList.toggle('overlay', alt);
    requestAnimationFrame(() => {
      if (alt) {
        block.body.classList.remove('empty');
        if (this.visible()) block.fit.fit();
        this.sendSize(block.term.rows);
      } else {
        this.sendSize(this.inputTerm.rows);
        block.finished ? this.settle(block) : this.relayout(block);
      }
      if (this.mode === 'running') block.term.focus();
    });
  }

  // ---- hooks from the shell ----
  onHook({ hook, value }) {
    if (hook === 'Preexec') {
      this.inputTerm.write("\x1bc");   // RIS through the write queue: reset() is immediate and would run before queued echo
      this.active = this.createBlock(value.command, value.cwd);
      this.mode = 'running';
      if (app.focused === this) this.focusTerm();
    } else if (hook === 'CommandFinished' && this.active) {
      const b = this.active;
      b.finished = true;
      const now = performance.now();
      clearInterval(b.timer);
      updateMeta(b, now);
      const ok = value.exit_code === 0;
      b.el.classList.remove('running');
      b.el.classList.add(ok ? 'ok' : 'bad');
      b.el.querySelector('.badge').textContent = ok ? '✓' : `✗ ${value.exit_code}`;
      b.term.options.disableStdin = true;
      if (b.alt) this.setAlt(b, false);
      b.term.write('', () => this.settle(b));
      this.active = null;
      this.mode = 'prompt';
      this.inputTerm.write("\x1bc");   // RIS through the write queue: reset() is immediate and would run before queued echo
      if (app.focused === this) this.focusTerm();
    } else if (hook === 'Precmd') {
      this.cwd = value.cwd;
      this.el.querySelector('.pane-cwd').textContent = value.cwd;
      app.updateTitles();
    }
  }
}

// ---- tabs and splits ----
// A tab's layout is a tree: { session } leaf, or { dir: 'h'|'v', ratio, a, b } split.
const leaves = (n) => (n.session ? [n.session] : [...leaves(n.a), ...leaves(n.b)]);

const app = {
  tabs: [], active: null, focused: null,

  newTab() {
    const tab = { el: document.createElement('div'), btn: document.createElement('button'), root: null, focused: null };
    tab.el.className = 'tab-content hidden';
    $('stage').appendChild(tab.el);
    tab.btn.className = 'tab';
    tab.btn.innerHTML = '<span class="tab-title">shell</span><span class="tab-close" title="Close tab">×</span>';
    tab.btn.addEventListener('click', (e) => (e.target.classList.contains('tab-close') ? this.closeTab(tab) : this.switchTo(tab)));
    $('tabs').appendChild(tab.btn);
    const s = new Session();
    s.tab = tab;
    tab.root = { session: s };
    tab.focused = s;
    this.tabs.push(tab);
    this.render(tab);
    this.switchTo(tab);
    s.start();
    this.focus(s);
    return tab;
  },

  switchTo(tab) {
    if (!tab) return;
    for (const t of this.tabs) { t.el.classList.toggle('hidden', t !== tab); t.btn.classList.toggle('active', t === tab); }
    this.active = tab;
    if (tab.focused) this.focus(tab.focused);
  },

  closeTab(tab) {
    const i = this.tabs.indexOf(tab);
    leaves(tab.root).forEach((s) => s.dispose());
    tab.el.remove(); tab.btn.remove();
    this.tabs.splice(i, 1);
    if (!this.tabs.length) { this.active = this.focused = null; this.newTab(); }
    else this.switchTo(this.tabs[Math.min(i, this.tabs.length - 1)]);
  },

  focus(session) {
    if (!session || !session.tab) return;
    this.focused = session;
    session.tab.focused = session;
    if (session.tab !== this.active) { this.switchTo(session.tab); return; }
    for (const s of leaves(session.tab.root)) s.el.classList.toggle('focused', s === session);
    session.focusTerm();
    this.updateTitles();
  },

  split(dir) {
    const s = this.focused;
    if (!s) return;
    const tab = s.tab, n = new Session();
    n.tab = tab;
    const walk = (node) => (node.session === s ? { dir, ratio: 0.5, a: node, b: { session: n } } : node.a ? { ...node, a: walk(node.a), b: walk(node.b) } : node);
    tab.root = walk(tab.root);
    this.render(tab);
    n.start();
    this.focus(n);
  },

  closePane(session) {
    if (!session) return;
    const tab = session.tab;
    if (leaves(tab.root).length === 1) return this.closeTab(tab);
    let sibling;
    const walk = (node) => {
      if (!node.a) return node;
      if (node.a.session === session) { sibling = leaves(node.b)[0]; return node.b; }
      if (node.b.session === session) { sibling = leaves(node.a).at(-1); return node.a; }
      return { ...node, a: walk(node.a), b: walk(node.b) };
    };
    tab.root = walk(tab.root);
    session.dispose();
    this.render(tab);
    this.focus(sibling);
  },

  panes(tab = this.active) { return leaves(tab.root); },

  paneExited(session) { this.closePane(session); },   // the shell ended (e.g. `exit`)

  cyclePane(d) {
    const list = leaves(this.active.root);
    const i = list.indexOf(this.focused);
    this.focus(list[(i + d + list.length) % list.length]);
  },

  updateTitles() {
    for (const t of this.tabs) {
      const cwd = t.focused?.cwd || '';
      t.btn.querySelector('.tab-title').textContent = cwd ? (cwd.split('/').filter(Boolean).pop() || '/') : 'shell';
    }
  },

  // Rebuild the DOM for a tab's layout tree. Existing pane elements are moved, not recreated.
  render(tab) {
    const build = (node) => {
      if (node.session) return node.session.el;
      const el = document.createElement('div');
      el.className = `split ${node.dir}`;
      const a = build(node.a), b = build(node.b), divider = document.createElement('div');
      divider.className = 'divider';
      a.style.flex = `${node.ratio} 1 0`;
      b.style.flex = `${1 - node.ratio} 1 0`;
      divider.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const move = (ev) => {
          const r = node.dir === 'h' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
          node.ratio = Math.min(0.85, Math.max(0.15, r));
          a.style.flex = `${node.ratio} 1 0`;
          b.style.flex = `${1 - node.ratio} 1 0`;
        };
        const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
        addEventListener('mousemove', move);
        addEventListener('mouseup', up);
      });
      el.append(a, divider, b);
      return el;
    };
    const all = leaves(tab.root);
    const scroll = all.map((s) => s.blocksEl.scrollTop);   // moving a node resets its scroll position
    const root = build(tab.root);
    root.style.flex = '1 1 0';
    tab.el.replaceChildren(root);
    all.forEach((s, i) => { s.blocksEl.scrollTop = scroll[i]; });
    tab.el.classList.toggle('multi', leaves(tab.root).length > 1);
  },
};

$('new-tab').addEventListener('click', () => app.newTab());
$('split-right').addEventListener('click', () => app.split('h'));
$('split-down').addEventListener('click', () => app.split('v'));
document.addEventListener('keydown', (ev) => {   // shortcuts when focus is not inside a terminal
  const name = shortcutFor(ev);
  if (name && !ev.defaultPrevented) { ev.preventDefault(); runShortcut(name); }   // xterm's handler already ran it otherwise
});
app.newTab();
window.__brick = { app, get session() { return app.focused; } };   // for tests
