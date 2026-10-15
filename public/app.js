import { HookSplitter } from './splitter.js';

const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const THEME = { background: 'rgba(0,0,0,0)', foreground: '#d7dae0', cursor: '#d7dae0', selectionBackground: '#33415c' };
const TERM_OPTS = { fontFamily: '"MesloLGS Nerd Font Mono", "SF Mono", Menlo, Monaco, Consolas, monospace', fontSize: 13, allowTransparency: true, theme: THEME, scrollback: 5000, allowProposedApi: true };
const MAX_ROWS = 2000;   // taller output scrolls inside the block
const INPUT_ROWS = 6;
const token = new URLSearchParams(location.search).get('t');
const $ = (id) => document.getElementById(id);

// ---- shortcuts: Alt+Shift+<key>, chosen so zsh's own Alt bindings (Alt+d, Alt+t...) keep working ----
const KEYS = { KeyT: 'newTab', KeyW: 'closePane', KeyD: 'splitRight', KeyS: 'splitDown', BracketLeft: 'prevPane', BracketRight: 'nextPane', KeyG: 'glass' };
function shortcutFor(ev) {
  if (!(ev.altKey && ev.shiftKey) || ev.ctrlKey || ev.metaKey) return null;
  return /^Digit[1-9]$/.test(ev.code) ? ev.code : KEYS[ev.code] || null;
}
function runShortcut(name) {
  if (name.startsWith('Digit')) return app.switchTo(app.tabs[Number(name.slice(5)) - 1]);
  ({ newTab: () => app.newTab(), closePane: () => app.closePane(app.focused), splitRight: () => app.split('h'),
    splitDown: () => app.split('v'), prevPane: () => app.cyclePane(-1), nextPane: () => app.cyclePane(1), glass: () => toggleGlass() })[name]();
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
      '<button class="pane-fx" title="Appearance of this pane">◐</button>' +
      '<button class="pane-pop" title="Move to a new tab">⇱</button>' +
      '<button class="pane-close" title="Close pane (Alt+Shift+W)">×</button></div>' +
      '<main class="blocks"></main><footer><div class="input"></div></footer>';
    this.blocksEl = this.el.querySelector('.blocks');
    this.cwd = '';
    this.mode = 'prompt';   // 'prompt' | 'running'
    this.active = null;     // the running block
    this.blocks = [];
    this.cols = 80;
    this.ended = false;
    this.el._session = this;
    this.el.addEventListener('mousedown', () => app.focus(this));
    this.fx = { mode: 'window', opacity: 0.6, blur: 12 };   // 'window' follows the window setting; 'solid' | 'glass' override it
    this.el.querySelector('.pane-fx').addEventListener('click', (e) => { e.stopPropagation(); app.focus(this); toggleAppearance(); });
    this.el.querySelector('.pane-pop').addEventListener('click', (e) => { e.stopPropagation(); app.popOut(this); });
    this.el.querySelector('.pane-head').addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('button')) dragPane(e, this); });
    this.el.querySelector('.pane-close').addEventListener('click', (e) => { e.stopPropagation(); app.closePane(this); });
  }

  // Translucent or opaque? A pane's own setting wins over the window's.
  applyFx() {
    const f = this.fx, glassy = f.mode === 'window' ? glass.on : f.mode === 'glass';
    this.el.classList.toggle('fx-glass', glassy);
    if (f.mode === 'glass') { this.el.style.setProperty('--op', f.opacity); this.el.style.setProperty('--blur', `${f.blur}px`); }
    else { this.el.style.removeProperty('--op'); this.el.style.removeProperty('--blur'); }
    refreshBackdropClass();
  }

  // Call once the pane is in the DOM and visible, so xterm can measure it.
  start() {
    this.applyFx();   // pick up the window's glass setting
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
      const before = others.find((b) => { const r = b.getBoundingClientRect(); return ev.clientX < r.left + r.width / 2; });
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
  if (el.id === 'new-tab' || el.id === 'tabs' || el.tagName === 'HEADER' || el.classList.contains('spacer')) return { kind: 'new', el: document.querySelector('header') };   // empty bar space
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
    const tab = { el: document.createElement('div'), btn: document.createElement('button'), root: null, focused: null };
    tab.el.className = 'tab-content hidden';
    $('stage').appendChild(tab.el);
    tab.btn.className = 'tab';
    tab.btn.innerHTML = '<span class="tab-title">shell</span><span class="tab-close" title="Close tab">×</span>';
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

// ---- appearance: window glass, per-pane look, backdrop picture (a browser page cannot see through to the desktop) ----
const glass = { on: false, opacity: 0.6, blur: 12 };
try { Object.assign(glass, JSON.parse(localStorage.getItem('brick.glass') || '{}')); } catch {}
const allPanes = () => app.tabs.flatMap((t) => leaves(t.root));
function refreshBackdropClass() {   // the backdrop is visible while window glass is on or any pane is glass
  document.body.classList.toggle('backdrop', glass.on || allPanes().some((s) => s.fx.mode === 'glass'));
}
function applyGlass(save = true) {
  document.body.classList.toggle('glass', glass.on);
  document.body.style.setProperty('--op', glass.opacity);
  document.body.style.setProperty('--blur', `${glass.blur}px`);
  allPanes().forEach((s) => s.applyFx());
  refreshBackdropClass();
  refreshPanel();
  if (save) try { localStorage.setItem('brick.glass', JSON.stringify(glass)); } catch {}
}
function toggleGlass() { glass.on = !glass.on; applyGlass(); }

const panel = $('appearance-panel');
const pct = (v) => `${Math.round(v * 100)}%`;
function refreshPanel() {   // sync the panel with the window settings and the focused pane
  if (panel.hidden) return;
  $('glass').checked = glass.on;
  $('glass-opacity').value = Math.round(glass.opacity * 100); $('glass-opacity-out').textContent = pct(glass.opacity);
  $('glass-blur').value = glass.blur; $('glass-blur-out').textContent = `${glass.blur}px`;
  const s = app.focused;
  if (!s) return;
  $('ap-pane').textContent = s.cwd ? s.cwd.split('/').filter(Boolean).pop() || '/' : 'shell';
  document.querySelectorAll('#pane-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === s.fx.mode));
  $('pane-glass').hidden = s.fx.mode !== 'glass';
  $('pane-opacity').value = Math.round(s.fx.opacity * 100); $('pane-opacity-out').textContent = pct(s.fx.opacity);
  $('pane-blur').value = s.fx.blur; $('pane-blur-out').textContent = `${s.fx.blur}px`;
}
function openAppearance() { panel.hidden = false; $('appearance').classList.add('on'); refreshPanel(); }
function closeAppearance() { panel.hidden = true; $('appearance').classList.remove('on'); app.focused?.focusTerm(); }
function toggleAppearance() { panel.hidden ? openAppearance() : closeAppearance(); }
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
$('glass').addEventListener('change', (e) => { glass.on = e.target.checked; applyGlass(); });
$('glass-opacity').addEventListener('input', (e) => { glass.opacity = Number(e.target.value) / 100; applyGlass(); });
$('glass-blur').addEventListener('input', (e) => { glass.blur = Number(e.target.value); applyGlass(); });
document.querySelectorAll('#pane-mode button').forEach((b) => b.addEventListener('click', () => { if (app.focused) { app.focused.fx.mode = b.dataset.mode; app.focused.applyFx(); refreshPanel(); } }));
$('pane-opacity').addEventListener('input', (e) => { const s = app.focused; if (s) { s.fx.opacity = Number(e.target.value) / 100; s.applyFx(); refreshPanel(); } });
$('pane-blur').addEventListener('input', (e) => { const s = app.focused; if (s) { s.fx.blur = Number(e.target.value); s.applyFx(); refreshPanel(); } });
applyGlass(false);

// Backdrop picture behind the glass: a desktop capture (taken by the server) or a file. Kept in IndexedDB, never sent anywhere.
let backdropUrl = null;
const kv = (mode, op) => new Promise((resolve) => {
  try {
    const open = indexedDB.open('brick', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => { const tx = open.result.transaction('kv', mode), req = op(tx.objectStore('kv')); tx.oncomplete = () => resolve(req?.result); tx.onerror = tx.onabort = () => resolve(undefined); };
  } catch { resolve(undefined); }
});
function setBackdrop(blob, save = true) {
  if (backdropUrl) URL.revokeObjectURL(backdropUrl);
  backdropUrl = blob ? URL.createObjectURL(blob) : null;
  if (backdropUrl) document.body.style.setProperty('--bd', `url("${backdropUrl}") center / cover no-repeat`);
  else document.body.style.removeProperty('--bd');
  $('bd-reset').hidden = !blob;
  if (save) kv('readwrite', (s) => (blob ? s.put(blob, 'backdrop') : s.delete('backdrop')));
}
async function captureBackdrop() {
  const btn = $('bd-capture'), label = btn.textContent;
  btn.disabled = true;
  try {
    for (let n = window.__brick.captureDelay; n > 0; n--) { btn.textContent = `Hide this window… ${n}`; await new Promise((r) => setTimeout(r, 1000)); }
    btn.textContent = 'Capturing…';
    const res = await fetch(`/capture?t=${token}`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    setBackdrop(await res.blob());
  } catch (e) { alert(e.message); }
  btn.textContent = label; btn.disabled = false;
}
$('bd-capture').addEventListener('click', captureBackdrop);
$('bd-file').addEventListener('click', () => $('bd-input').click());
$('bd-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) setBackdrop(f); e.target.value = ''; });
$('bd-reset').addEventListener('click', () => setBackdrop(null));
kv('readonly', (s) => s.get('backdrop')).then((blob) => { if (blob) setBackdrop(blob, false); });

$('new-tab').addEventListener('click', () => app.newTab());
$('split-right').addEventListener('click', () => app.split('h'));
$('split-down').addEventListener('click', () => app.split('v'));
document.addEventListener('keydown', (ev) => {   // shortcuts when focus is not inside a terminal
  const name = shortcutFor(ev);
  if (name && !ev.defaultPrevented) { ev.preventDefault(); runShortcut(name); }   // xterm's handler already ran it otherwise
});
app.newTab();
window.__brick = { app, leaves, captureDelay: 5, get session() { return app.focused; } };   // for tests
