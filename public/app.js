import { HookSplitter } from './splitter.js';
import { FileBrowser, shq } from './files.js';
const saveLast = (v) => { try { localStorage.setItem('brick.last', JSON.stringify(v)); } catch {} };

const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const THEME = { background: 'rgba(0,0,0,0)', foreground: '#d7dae0', cursor: '#d7dae0', selectionBackground: '#33415c' };
const TERM_OPTS = { fontFamily: '"MesloLGS Nerd Font Mono", "SF Mono", Menlo, Monaco, Consolas, monospace', fontSize: 13, allowTransparency: true, theme: THEME, scrollback: 5000, allowProposedApi: true };
const MAX_ROWS = 2000;   // taller output scrolls inside the block
const INPUT_ROWS = 6;
const token = new URLSearchParams(location.search).get('t');
const $ = (id) => document.getElementById(id);
const api = (name, body, signal) => fetch(`/fs/${name}?t=${token}`, { method: 'POST', body: JSON.stringify(body), signal });

// ---- shortcuts: Alt+Shift+<key>, chosen so zsh's own Alt bindings (Alt+d, Alt+t...) keep working ----
const KEYS = { KeyT: 'newTab', KeyW: 'closePane', KeyD: 'splitRight', KeyS: 'splitDown', BracketLeft: 'prevPane', BracketRight: 'nextPane', KeyG: 'glass', KeyF: 'files' };
function shortcutFor(ev) {
  if (!(ev.altKey && ev.shiftKey) || ev.ctrlKey || ev.metaKey) return null;
  return /^Digit[1-9]$/.test(ev.code) ? ev.code : KEYS[ev.code] || null;
}
function runShortcut(name) {
  if (name.startsWith('Digit')) return app.switchTo(app.tabs[Number(name.slice(5)) - 1]);
  ({ newTab: () => app.newTab(), closePane: () => app.closePane(app.focused), splitRight: () => app.split('h'),
    splitDown: () => app.split('v'), prevPane: () => app.cyclePane(-1), nextPane: () => app.cyclePane(1), glass: () => toggleGlass(), files: () => app.focused?.toggleFiles() })[name]();
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
    this.el.innerHTML = '<div class="pane-bg"></div><div class="pane-tint"></div>' +
      '<div class="pane-head"><span class="pane-cwd"></span><span class="pane-state"></span>' +
      '<button class="pane-files" title="Files view (Alt+Shift+F)">▤</button>' +
      '<button class="pane-pop" title="Move to a new tab">⇱</button>' +
      '<button class="pane-close" title="Close pane (Alt+Shift+W)">×</button></div>' +
      '<div class="files" hidden></div><main class="blocks"></main><footer><div class="input"></div></footer>';
    this.blocksEl = this.el.querySelector('.blocks');
    this.cwd = '';
    this.mode = 'prompt';   // 'prompt' | 'running'
    this.active = null;     // the running block
    this.blocks = [];
    this.cols = 80;
    this.ended = false;
    this.el._session = this;
    this.el.addEventListener('mousedown', () => app.focus(this));
    this.look = null;   // null: follows its tab's look; otherwise this pane's own
    this.view = 'term';   // 'term' (blocks and input) or 'files' (Finder-style browser); the shell keeps running underneath
    this.el.querySelector('.pane-files').addEventListener('click', (e) => { e.stopPropagation(); app.focus(this); this.toggleFiles(); });
    this.el.querySelector('.pane-pop').addEventListener('click', (e) => { e.stopPropagation(); app.popOut(this); });
    this.el.querySelector('.pane-head').addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('button')) dragPane(e, this); });
    this.el.querySelector('.pane-close').addEventListener('click', (e) => { e.stopPropagation(); app.closePane(this); });
  }

  // Call once the pane is in the DOM and visible, so xterm can measure it.
  start() {
    applyLook(this);
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
  focusTerm() { if (this.view === 'files') this.fb?.focus(); else this.target()?.focus(); }
  toggleFiles(startAt) {
    const on = this.view !== 'files';
    saveLast({ files: on, path: on ? (startAt || this.fb?.root || '') : '' });
    this.view = on ? 'files' : 'term';
    this.el.classList.toggle('files-mode', on);
    this.el.querySelector('.files').hidden = !on;
    this.el.querySelector('.pane-files').textContent = on ? '>_' : '▤';
    this.el.querySelector('.pane-files').title = on ? 'Back to the terminal (Alt+Shift+F)' : 'Files view (Alt+Shift+F)';
    if (on) {
      this.fb ??= new FileBrowser(this.el.querySelector('.files'), {
        api, getCwd: () => this.cwd, onNav: (dir) => saveLast({ files: true, path: dir }), close: () => this.toggleFiles(),
        cdHere: (dir) => { if (this.mode !== 'prompt') return; this.send({ type: 'input', data: `\x15cd ${shq(dir)}\r` }); this.toggleFiles(); },
      });
      this.fb.open(startAt || this.cwd || '~');
      this.fb.focus();
    } else { this.layout(); this.focusTerm(); }
  }   // no-op until start() has created the terminal

  dispose() {
    this.ended = true;
    this.observer?.disconnect();
    try { this.ws?.close(); } catch {}
    for (const b of this.blocks) { clearInterval(b.timer); b.term.dispose(); }
    this.inputTerm?.dispose();
    this.fb?.dispose();
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

// ---- drag and drop (mouse events, like the dividers) ----
let suppressClick = false;   // a tab drag ends with a click on the tab; swallow it
// Calls handlers.move while the mouse is down (after a few px), handlers.end(ev, committed) on release or Esc.
function trackDrag(startEv, handlers) {
  const sx = startEv.clientX, sy = startEv.clientY;
  let started = false;
  const finish = (ev, committed) => {
    removeEventListener('mousemove', mm, true); removeEventListener('mouseup', mu, true); removeEventListener('keydown', kd, true);
    document.body.classList.remove('dragging');
    if (started) handlers.end(ev, committed);
  };
  const mm = (ev) => {
    if (!started) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return; started = true; document.body.classList.add('dragging'); handlers.begin?.(ev); }
    handlers.move(ev);
  };
  const mu = (ev) => finish(ev, true);
  const kd = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(ev, false); } };
  addEventListener('mousemove', mm, true); addEventListener('mouseup', mu, true); addEventListener('keydown', kd, true);
}

function dragTab(startEv, tab) {   // live reorder: the button follows the pointer along the tab bar
  trackDrag(startEv, {
    begin: () => tab.btn.classList.add('dragging'),
    move: (ev) => {
      const others = [...$('tabs').children].filter((b) => b !== tab.btn);
      const vert = tabsCfg.pos !== 'top';
      const before = others.find((b) => { const r = b.getBoundingClientRect(); return vert ? ev.clientY < r.top + r.height / 2 : ev.clientX < r.left + r.width / 2; });
      if (before ? tab.btn.nextSibling !== before : tab.btn !== $('tabs').lastChild) $('tabs').insertBefore(tab.btn, before || null);
    },
    end: () => {
      tab.btn.classList.remove('dragging');
      const order = [...$('tabs').children];
      app.tabs.sort((a, b) => order.indexOf(a.btn) - order.indexOf(b.btn));
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
    },
  });
}

// Where would a drop at (x, y) go? Returns { kind: 'pane'|'tab'|'new', ... , rect } or null.
function dropTarget(x, y, source) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const tabBtn = el.closest('.tab');
  if (tabBtn) { const tab = app.tabs.find((t) => t.btn === tabBtn); return tab ? { kind: 'tab', tab, el: tabBtn } : null; }
  if (el.id === 'new-tab' || el.id === 'tabs' || el.id === 'tabbar' || el.tagName === 'HEADER' || el.classList.contains('spacer') || el.closest('#sidebar')) return { kind: 'new', el: el.closest('#sidebar') || document.querySelector('header') };   // empty bar space
  const paneEl = el.closest('.pane');
  const target = paneEl?._session;
  if (!target || target === source) return null;
  const r = paneEl.getBoundingClientRect(), fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
  let edge = 'center';
  if (!(fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7)) {
    const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
    edge = Object.keys(d).reduce((m, k) => (d[k] < d[m] ? k : m));
  }
  const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
  if (edge === 'left') rect.width /= 2;
  else if (edge === 'right') { rect.left += r.width / 2; rect.width /= 2; }
  else if (edge === 'top') rect.height /= 2;
  else if (edge === 'bottom') { rect.top += r.height / 2; rect.height /= 2; }
  return { kind: 'pane', target, edge, rect };
}

function dragPane(startEv, session) {
  let ghost, ind, current = null, hoverTimer = 0, hoverTab = null;
  const clear = () => {
    document.querySelectorAll('.drop-target').forEach((e) => e.classList.remove('drop-target'));
    if (ind) ind.style.display = 'none';
  };
  trackDrag(startEv, {
    begin: () => {
      ghost = Object.assign(document.createElement('div'), { className: 'drag-ghost', textContent: session.cwd || 'shell' });
      ind = Object.assign(document.createElement('div'), { className: 'drop-ind' });
      document.body.append(ghost, ind);
      session.el.classList.add('dragging');
    },
    move: (ev) => {
      ghost.style.left = `${ev.clientX + 12}px`; ghost.style.top = `${ev.clientY + 12}px`;
      current = dropTarget(ev.clientX, ev.clientY, session);
      clear();
      if (current?.el) current.el.classList.add('drop-target');
      if (current?.rect) {
        Object.assign(ind.style, { display: 'block', left: `${current.rect.left}px`, top: `${current.rect.top}px`, width: `${current.rect.width}px`, height: `${current.rect.height}px` });
      }
      // hovering a tab for a moment opens it, so a pane can be dropped at a precise spot inside it
      const t = current?.kind === 'tab' ? current.tab : null;
      if (t !== hoverTab) { clearTimeout(hoverTimer); hoverTab = t; if (t && t !== app.active) hoverTimer = setTimeout(() => app.switchTo(t), 600); }
    },
    end: (ev, committed) => {
      clearTimeout(hoverTimer); clear();
      ghost.remove(); ind.remove(); session.el.classList.remove('dragging');
      if (!committed || !current) return;
      if (current.kind === 'pane') app.movePane(session, current.target, current.edge);
      else if (current.kind === 'tab') app.movePaneToTab(session, current.tab);
      else app.popOut(session);
    },
  });
}

// ---- tabs and splits ----
// A tab's layout is a tree: { session } leaf, or { dir: 'h'|'v', ratio, a, b } split.
const leaves = (n) => (n.session ? [n.session] : [...leaves(n.a), ...leaves(n.b)]);
// Remove a pane from a layout tree (its sibling takes the parent's place). Returns null if the tree is now empty.
const removeLeaf = (n, s) => {
  if (n.session) return n.session === s ? null : n;
  const a = removeLeaf(n.a, s), b = removeLeaf(n.b, s);
  return !a ? b : !b ? a : { ...n, a, b };
};
// Put pane `s` beside `target` on the given edge of it.
const insertAt = (n, target, s, edge) => {
  if (n.session) {
    if (n.session !== target) return n;
    const fresh = { session: s }, first = edge === 'left' || edge === 'top';
    return { dir: edge === 'left' || edge === 'right' ? 'h' : 'v', ratio: 0.5, a: first ? fresh : n, b: first ? n : fresh };
  }
  return { ...n, a: insertAt(n.a, target, s, edge), b: insertAt(n.b, target, s, edge) };
};
const leafOf = (n, s) => (n.session ? (n.session === s ? n : null) : leafOf(n.a, s) || leafOf(n.b, s));

const app = {
  tabs: [], active: null, focused: null,

  makeTab() {
    const tab = { el: document.createElement('div'), btn: document.createElement('button'), root: null, focused: null, look: cloneLook(lastLook) };
    tab.el.className = 'tab-content hidden';
    $('stage').appendChild(tab.el);
    tab.btn.className = 'tab';
    tab.btn.innerHTML = '<span class="tab-ini">s</span><span class="tab-name">shell</span><span class="tab-title">shell</span><span class="tab-close" title="Close tab">×</span>';
    tab.btn.addEventListener('click', (e) => {
      if (suppressClick) return;
      e.target.classList.contains('tab-close') ? this.closeTab(tab) : this.switchTo(tab);
    });
    tab.btn.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.classList.contains('tab-close')) dragTab(e, tab); });
    $('tabs').appendChild(tab.btn);
    this.tabs.push(tab);
    return tab;
  },

  newTab() {
    const tab = this.makeTab();
    const s = new Session();
    s.tab = tab;
    tab.root = { session: s };
    tab.focused = s;
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

  // Take a tab out of the UI without touching its panes (callers dispose or move them first).
  dropTab(tab) {
    const i = this.tabs.indexOf(tab);
    tab.el.remove(); tab.btn.remove();
    this.tabs.splice(i, 1);
    if (this.active === tab) this.active = null;
    return i;
  },

  closeTab(tab) {
    leaves(tab.root).forEach((s) => s.dispose());
    const i = this.dropTab(tab);
    if (!this.tabs.length) { this.active = this.focused = null; this.newTab(); }
    else this.switchTo(this.tabs[Math.min(i, this.tabs.length - 1)]);
  },

  focus(session) {
    if (!session || !session.tab) return;
    this.focused = session;
    if (typeof refreshPanel === 'function') refreshPanel();
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

  // ---- moving panes. The pane element (and its shell) is moved, never recreated. ----
  // Remove `s` from its tab's tree; returns that tab (its root is null if `s` was the only pane).
  detach(s) {
    const tab = s.tab;
    tab.root = removeLeaf(tab.root, s);
    if (tab.focused === s) tab.focused = tab.root ? leaves(tab.root)[0] : null;
    return tab;
  },

  // Drop pane `s` on `target`: an edge puts it beside `target`; 'center' swaps the two.
  movePane(s, target, edge) {
    if (!s || !target || s === target) return;
    const scroll = s.blocksEl.scrollTop, src = s.tab, dst = target.tab;
    if (edge === 'center') {
      const a = leafOf(src.root, s), b = leafOf(dst.root, target);
      a.session = target; b.session = s;
      target.tab = src; s.tab = dst;
      if (src.focused === s) src.focused = target;
      if (dst.focused === target) dst.focused = s;
      this.render(src);
      if (dst !== src) this.render(dst);
    } else {
      this.detach(s);
      dst.root = insertAt(dst.root, target, s, edge);
      s.tab = dst;
      if (src.root) this.render(src); else this.dropTab(src);
      this.render(dst);
    }
    this.switchTo(dst);
    this.focus(s);
    s.blocksEl.scrollTop = scroll;
  },

  // Dropped on a tab button: join that tab, next to the pane that was last focused there.
  movePaneToTab(s, tab) {
    if (!s || s.tab === tab) return;
    this.movePane(s, tab.focused || leaves(tab.root).at(-1), 'right');
  },

  // Make the pane a tab of its own. A tab that only holds this pane is already standalone.
  popOut(s) {
    if (!s || leaves(s.tab.root).length === 1) return;
    const scroll = s.blocksEl.scrollTop, src = this.detach(s), tab = this.makeTab();
    this.render(src);
    tab.root = { session: s };
    tab.focused = s;
    s.tab = tab;
    this.render(tab);
    this.switchTo(tab);
    this.focus(s);
    s.blocksEl.scrollTop = scroll;
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
      const title = cwd ? (cwd.split('/').filter(Boolean).pop() || '/') : 'shell';
      t.btn.querySelector('.tab-title').textContent = title;
      t.btn.querySelector('.tab-ini').textContent = title[0];
      t.btn.querySelector('.tab-name').textContent = title;   // the floating label shown on hover when the bar is collapsed
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
    all.forEach(applyLook);   // a pane that changed tab takes on the new tab's look
  },
};

// ---- appearance: one panel; the look applies to every pane of the tab or only to the focused pane ----
// look = { bg: 'desktop' | 'image' | 'capture' | 'solid' | 'blend', solid: colour, blend: [3 colours], opacity 0..1, blur px }
// A pane is painted in layers: its background (picture, gradient or colour; blurred) and a tint at the chosen opacity.
const DEFAULT_LOOK = { bg: 'solid', solid: '#14161b', blend: ['#3b4fd8', '#b13fa6', '#0e9aa7'], opacity: 1, blur: 12 };
const cloneLook = (l) => JSON.parse(JSON.stringify(l));
const PICTURES = ['desktop', 'image', 'capture'];
let lastLook = cloneLook(DEFAULT_LOOK);   // new tabs start with the look you last chose for a tab
try { const saved = JSON.parse(localStorage.getItem('brick.look') || 'null'); if (saved && typeof saved === 'object') lastLook = { ...DEFAULT_LOOK, ...saved }; } catch {}
const pics = { desktop: null, image: null, capture: null };   // object URLs of the three picture slots
const allPanes = () => app.tabs.flatMap((t) => leaves(t.root));
const lookOf = (s) => s.look ?? s.tab.look;
const mix = (c, op) => `color-mix(in srgb, ${c} ${Math.round(op * 100)}%, transparent)`;

function applyLook(s) {
  const l = lookOf(s), el = s.el, set = (k, v) => el.style.setProperty(k, v);
  const solid = l.bg === 'solid', picture = PICTURES.includes(l.bg);
  const [c1, c2, c3] = l.blend;
  set('--layer', solid ? 'none' : picture ? (pics[l.bg] ? `url("${pics[l.bg]}")` : 'none')
    : `radial-gradient(ellipse at 15% 10%, ${c1} 0, transparent 50%), radial-gradient(ellipse at 85% 25%, ${c2} 0, transparent 45%), radial-gradient(ellipse at 60% 95%, ${c3} 0, transparent 50%)`);
  set('--layer-base', solid ? l.solid : '#0b0d14');
  set('--blur', solid ? '0px' : `${l.blur}px`);
  const fill = solid ? l.solid : 'var(--bg)', panel = solid ? `color-mix(in srgb, ${l.solid} 92%, white)` : 'var(--panel)';
  set('--pane-bg', mix(fill, l.opacity));
  set('--panel-bg', mix(panel, l.opacity));
  el.classList.toggle('layered', !solid);
  el.classList.toggle('see-through', l.opacity < 1);
}
const applyAll = () => allPanes().forEach(applyLook);

const panel = $('appearance-panel');
let scope = 'tab';   // what the panel edits: 'tab' (every pane of the active tab) or 'pane' (the focused pane only)
const pct = (v) => `${Math.round(v * 100)}%`;
const editing = () => (scope === 'pane' && app.focused ? app.focused.look ?? app.focused.tab.look : app.active?.look ?? lastLook);
// Change the look being edited. For 'tab' every pane of the tab follows; for 'pane' only the focused one gets its own copy.
function edit(change) {
  if (scope === 'pane' && app.focused) {
    const s = app.focused; s.look ??= cloneLook(s.tab.look); change(s.look); applyLook(s);
  } else if (app.active) {
    const tab = app.active; change(tab.look); leaves(tab.root).forEach((s) => { s.look = null; applyLook(s); });
    lastLook = cloneLook(tab.look);
    try { localStorage.setItem('brick.look', JSON.stringify(lastLook)); } catch {}
  }
  refreshPanel();
}
const BG_LABEL = { desktop: 'Wallpaper', image: 'Image', capture: 'Screenshot' };
let message = '';
function refreshPanel() {
  if (panel.hidden) return;
  const l = editing(), s = app.focused, own = scope === 'pane' && s?.look;
  document.querySelectorAll('#scope button').forEach((b) => b.classList.toggle('on', b.dataset.scope === scope));
  $('ap-pane').textContent = scope === 'pane' && s ? (own ? `${s.cwd.split('/').filter(Boolean).pop() || '/'} · own look` : 'same as the tab') : '';
  $('ap-pane-reset').hidden = !own;
  document.querySelectorAll('#bg-kind button').forEach((b) => b.classList.toggle('on', b.dataset.bg === l.bg));
  document.querySelectorAll('#tab-pos button').forEach((b) => b.classList.toggle('on', b.dataset.pos === tabsCfg.pos));
  $('tab-collapse-row').hidden = tabsCfg.pos === 'top';
  $('tab-collapse').checked = tabsCfg.collapsed;
  const picture = PICTURES.includes(l.bg);
  $('bg-picture').hidden = !picture;
  if (picture) {
    $('bd-status').textContent = pics[l.bg] ? `${BG_LABEL[l.bg]} loaded` : `No ${BG_LABEL[l.bg].toLowerCase()} yet`;
    $('bd-action').textContent = { desktop: 'Refresh', image: 'Choose file…', capture: 'Take screenshot' }[l.bg];
  }
  $('bg-colors').hidden = picture;
  const cols = l.bg === 'solid' ? [l.solid] : l.blend;
  $('colors').replaceChildren(...cols.map((c, i) => {
    const input = Object.assign(document.createElement('input'), { type: 'color', value: c, title: l.bg === 'solid' ? 'Colour' : `Colour ${i + 1}` });
    input.addEventListener('input', () => edit((x) => { if (x.bg === 'solid') x.solid = input.value; else x.blend[i] = input.value; }));
    return input;
  }));
  $('opacity').value = Math.round(l.opacity * 100); $('opacity-out').textContent = pct(l.opacity);
  $('blur').value = l.blur; $('blur-out').textContent = `${l.blur}px`;
  $('blur').disabled = l.bg === 'solid';
  $('bd-msg').hidden = !message; $('bd-msg').textContent = message;
}
function openAppearance() { panel.hidden = false; $('appearance').classList.add('on'); refreshPanel(); }
function closeAppearance() { panel.hidden = true; $('appearance').classList.remove('on'); app.focused?.focusTerm(); }
function toggleAppearance() { panel.hidden ? openAppearance() : closeAppearance(); }
// Alt+Shift+G: flip the active tab between a plain look and its last picture look
function toggleGlass() {
  const tab = app.active; if (!tab) return;
  const prev = scope; scope = 'tab';
  if (tab.look.bg === 'solid') { const back = tab.prevLook || { bg: 'blend', opacity: 0.6 }; edit((x) => Object.assign(x, back)); }
  else { tab.prevLook = { bg: tab.look.bg, opacity: tab.look.opacity }; edit((x) => { x.bg = 'solid'; x.opacity = 1; }); }
  scope = prev;
}
// drag the panel by its title so it never has to cover the pane being edited
panel.querySelector('.ap-head').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
  trackDrag(e, { move: (ev) => {
    panel.style.right = 'auto';
    panel.style.left = `${Math.min(innerWidth - 60, Math.max(-r.width + 60, ev.clientX - dx))}px`;
    panel.style.top = `${Math.min(innerHeight - 40, Math.max(0, ev.clientY - dy))}px`;
  }, end: () => {} });
});
$('appearance').addEventListener('click', toggleAppearance);
$('ap-close').addEventListener('click', closeAppearance);
addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !panel.hidden) { ev.preventDefault(); ev.stopPropagation(); closeAppearance(); } }, true);   // Esc closes the panel and is not sent to the shell
document.querySelectorAll('#scope button').forEach((b) => b.addEventListener('click', () => { scope = b.dataset.scope; refreshPanel(); }));
$('ap-pane-reset').addEventListener('click', () => { const s = app.focused; if (s) { s.look = null; applyLook(s); refreshPanel(); } });
$('opacity').addEventListener('input', (e) => edit((x) => { x.opacity = Number(e.target.value) / 100; }));
$('blur').addEventListener('input', (e) => edit((x) => { x.blur = Number(e.target.value); }));
$('ap-reset').addEventListener('click', () => edit((x) => Object.assign(x, cloneLook(DEFAULT_LOOK))));
document.querySelectorAll('#bg-kind button').forEach((b) => b.addEventListener('click', () => {
  const bg = b.dataset.bg; message = '';
  edit((x) => { x.bg = bg; if (bg !== 'solid' && x.opacity > 0.85) x.opacity = 0.6; });   // a picture is not visible behind a fully opaque pane
  if (bg === 'desktop' && !pics.desktop) loadPicture('desktop');   // the wallpaper needs no hiding or waiting, so fetch it right away
  if (bg === 'image' && !pics.image) $('bd-input').click();
}));

// Pictures: the wallpaper and screenshots come from the server (macOS), an image from a file. Kept in IndexedDB in this browser only.
const kv = (mode, op) => new Promise((resolve) => {
  try {
    const open = indexedDB.open('brick', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => { const tx = open.result.transaction('kv', mode), req = op(tx.objectStore('kv')); tx.oncomplete = () => resolve(req?.result); tx.onerror = tx.onabort = () => resolve(undefined); };
  } catch { resolve(undefined); }
});
function setPicture(slot, blob, save = true) {
  if (pics[slot]) URL.revokeObjectURL(pics[slot]);
  pics[slot] = blob ? URL.createObjectURL(blob) : null;
  if (save && blob) kv('readwrite', (st) => st.put(blob, `pic-${slot}`));
  applyAll(); refreshPanel();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = false;
// slot 'desktop': just the wallpaper, no windows, instantly. slot 'capture': everything on screen, after a countdown so you can arrange it.
async function loadPicture(slot) {
  if (busy) return; busy = true;
  const btn = $('bd-action'), label = btn.textContent; message = '';
  btn.disabled = true;
  try {
    if (slot === 'capture') for (let n = window.__brick.captureDelay; n > 0; n--) { btn.textContent = `Capturing in ${n}…`; await sleep(1000); }
    btn.textContent = 'Working…';
    const res = await fetch(`/capture?t=${token}&kind=${slot === 'desktop' ? 'wallpaper' : 'screen'}`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    setPicture(slot, await res.blob());
  } catch (e) { message = e.message; }
  busy = false; btn.disabled = false; btn.textContent = label; refreshPanel();
}
$('bd-action').addEventListener('click', () => {
  const bg = editing().bg;
  if (bg === 'image') $('bd-input').click(); else if (PICTURES.includes(bg)) loadPicture(bg);
});
$('bd-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) { setPicture('image', f); } e.target.value = ''; });
Promise.all(PICTURES.map((slot) => kv('readonly', (st) => st.get(`pic-${slot}`)).then((blob) => blob && setPicture(slot, blob, false)))).then(() => {
  kv('readwrite', (st) => st.delete('backdrop'));   // an older version's single backdrop slot
  if (allPanes().some((s) => lookOf(s).bg === 'desktop')) loadPicture('desktop');   // follow wallpaper changes
});


// ---- tab bar: top, left or right (collapsible when vertical), Dock-style magnify, and a peek at a tab on hover ----
const tabsCfg = { pos: 'top', collapsed: false };
try { Object.assign(tabsCfg, JSON.parse(localStorage.getItem('brick.tabs') || '{}')); } catch {}
if (!['top', 'left', 'right'].includes(tabsCfg.pos)) tabsCfg.pos = 'top';
function applyTabs() {
  const vert = tabsCfg.pos !== 'top', side = $('sidebar'), bar = $('tabbar');
  document.body.classList.toggle('tabs-right', tabsCfg.pos === 'right');
  side.hidden = !vert;
  if (vert) side.append(bar); else document.querySelector('header').insertBefore(bar, document.querySelector('header .spacer'));
  side.classList.toggle('collapsed', vert && tabsCfg.collapsed);
  $('tabs-collapse').hidden = !vert;
  const folded = vert && tabsCfg.collapsed, towardsStage = tabsCfg.pos === 'left';   // arrow points where the bar will move
  $('tabs-collapse').textContent = folded === towardsStage ? '»' : '«';
  resetDock(); hidePeek();
  refreshPanel();
  try { localStorage.setItem('brick.tabs', JSON.stringify(tabsCfg)); } catch {}
}
document.querySelectorAll('#tab-pos button').forEach((b) => b.addEventListener('click', () => { tabsCfg.pos = b.dataset.pos; applyTabs(); }));
$('tab-collapse').addEventListener('change', (e) => { tabsCfg.collapsed = e.target.checked; applyTabs(); });
$('tabs-collapse').addEventListener('click', () => { tabsCfg.collapsed = !tabsCfg.collapsed; applyTabs(); });

// Dock effect: tabs near the pointer grow, falling off smoothly with distance along the bar.
function resetDock() { for (const b of $('tabs').children) { b.style.transform = ''; b.style.removeProperty('--s'); b.classList.remove('hot'); } }
$('tabs').addEventListener('pointermove', (ev) => {
  if (document.body.classList.contains('dragging')) return;
  const vert = tabsCfg.pos !== 'top', max = vert ? (tabsCfg.collapsed ? 1.7 : 1.2) : 1.25, reach = vert ? 85 : 150;
  let near = null, nearD = Infinity;
  for (const b of $('tabs').children) {
    const r = b.getBoundingClientRect();   // scaling about the centre leaves the centre where it was
    const d = Math.abs(vert ? ev.clientY - (r.top + r.height / 2) : ev.clientX - (r.left + r.width / 2));
    const s = 1 + (max - 1) * Math.cos(Math.min(1, d / reach) * Math.PI / 2) ** 1.5;   // the nearest grows most, neighbours less, then none
    b.style.transformOrigin = vert && !tabsCfg.collapsed ? (tabsCfg.pos === 'left' ? 'left center' : 'right center') : 'center';
    b.style.transform = s > 1.001 ? `scale(${s.toFixed(3)})` : '';
    b.style.setProperty('--s', s.toFixed(3));
    b.classList.remove('hot');
    if (d < nearD) { nearD = d; near = b; }
  }
  near?.classList.add('hot');
});
$('tabs').addEventListener('pointerleave', resetDock);

// Peek: rest the pointer on a tab for a moment and a scaled copy of that tab appears, with no click needed. Click the copy to go there.
const peekEl = $('peek');
let peekTab = null, peekDwell = 0, peekHide = 0, peekLive = 0;
function drawPeek() {
  const tab = peekTab; if (!tab) return;
  const st = $('stage').getBoundingClientRect(), width = Math.min(560, innerWidth - 24), k = width / st.width;
  const view = peekEl.querySelector('.peek-view'), scale = peekEl.querySelector('.peek-scale');
  peekEl.style.width = `${width}px`;
  view.style.height = `${st.height * k}px`;
  Object.assign(scale.style, { width: `${st.width}px`, height: `${st.height}px`, transform: `scale(${k})` });
  const copy = tab.el.cloneNode(true);
  copy.classList.remove('hidden'); copy.inert = true;
  scale.replaceChildren(copy);
  copy.querySelectorAll('.blocks').forEach((m) => { m.scrollTop = m.scrollHeight; });   // the latest output is what you want to see
}
function showPeek(tab) {
  peekTab = tab;
  peekEl.querySelector('.peek-title').innerHTML = '<span></span><span>click to open</span>';
  peekEl.querySelector('.peek-title span').textContent = tab.btn.title || 'shell';
  peekEl.hidden = false;
  drawPeek();
  const r = tab.btn.getBoundingClientRect(), box = peekEl.getBoundingClientRect(), pos = tabsCfg.pos;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const left = pos === 'left' ? r.right + 8 : pos === 'right' ? r.left - box.width - 8 : clamp(r.left, 8, innerWidth - box.width - 8);
  const top = pos === 'top' ? r.bottom + 8 : clamp(r.top, 8, innerHeight - box.height - 8);
  Object.assign(peekEl.style, { left: `${Math.max(8, left)}px`, top: `${top}px` });
  clearInterval(peekLive); peekLive = setInterval(drawPeek, 1000);   // keeps up with output while you look
}
function hidePeek() {
  clearTimeout(peekDwell); clearTimeout(peekHide); clearInterval(peekLive);
  peekTab = null; peekEl.hidden = true; peekEl.querySelector('.peek-scale').replaceChildren();
}
$('tabs').addEventListener('pointerover', (ev) => {
  const btn = ev.target.closest('.tab'); if (!btn || document.body.classList.contains('dragging')) return;
  const tab = app.tabs.find((t) => t.btn === btn); if (!tab) return;
  clearTimeout(peekHide); clearTimeout(peekDwell);
  if (tab === app.active) { hidePeek(); return; }
  // while one peek is open, moving to the next tab shows it quickly, so you can scan along the bar
  peekDwell = setTimeout(() => showPeek(tab), peekEl.hidden ? window.__brick.peekDelay : 250);
});
$('tabs').addEventListener('pointerout', (ev) => {
  if (ev.relatedTarget?.closest?.('.tab') || ev.relatedTarget === peekEl || peekEl.contains(ev.relatedTarget)) return;
  clearTimeout(peekDwell); clearTimeout(peekHide); peekHide = setTimeout(hidePeek, 250);
});
peekEl.addEventListener('pointerenter', () => clearTimeout(peekHide));
peekEl.addEventListener('pointerleave', () => { clearTimeout(peekHide); peekHide = setTimeout(hidePeek, 150); });
peekEl.addEventListener('click', () => { const t = peekTab; hidePeek(); if (t) app.switchTo(t); });
$('tabs').addEventListener('mousedown', hidePeek);
addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !peekEl.hidden) hidePeek(); }, true);

$('new-tab').addEventListener('click', () => app.newTab());
$('split-right').addEventListener('click', () => app.split('h'));
$('split-down').addEventListener('click', () => app.split('v'));
document.addEventListener('keydown', (ev) => {   // shortcuts when focus is not inside a terminal
  const name = shortcutFor(ev);
  if (name && !ev.defaultPrevented) { ev.preventDefault(); runShortcut(name); }   // xterm's handler already ran it otherwise
});
window.__brick = { app, leaves, captureDelay: 5, peekDelay: 1200, get session() { return app.focused; } };   // for tests
applyTabs();
app.newTab();
// reopen the view we left: Files view on the folder it showed (the shell itself starts fresh)
try { const last = JSON.parse(localStorage.getItem('brick.last') || 'null'); if (last?.files && typeof last.path === 'string' && last.path.startsWith('/')) app.focused?.toggleFiles(last.path); } catch {}
