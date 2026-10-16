// Files view for a pane: a Finder/Explorer-style tree (expandable folders, sortable columns), a search box
// (file names or text inside files, optionally in subfolders) and grep results laid out like Notepad++'s "Find in Files".
// Talks to the server's /fs/* endpoints through the `api(name, body, signal)` function it is given.

import { DocView, openWindow } from './docview.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const base = (p) => p.slice(p.lastIndexOf('/') + 1) || '/';
const dirOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const join = (d, n) => (d === '/' ? '' : d) + '/' + n;
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`);
const kindOf = (e) => (e.type === 'dir' ? 'Folder' : (() => { const m = /\.([^./]+)$/.exec(e.name); return m ? `${m[1].toUpperCase()} file` : 'File'; })()) + (e.link ? ' (alias)' : '');
const icon = (e) => (e.broken ? '⚠' : e.link && e.type === 'file' ? '🔗' : e.type === 'dir' ? '📁' : '📄');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shq = (p) => `'${p.replace(/'/g, `'\\''`)}'`;

const COLW = { mtime: 170, size: 80, kind: 130 };
const COLS = [['name', 'Name'], ['mtime', 'Date Modified'], ['size', 'Size'], ['kind', 'Kind']];

export class FileBrowser {
  // opts: { api, getCwd(): terminal folder, cdHere(path), close() }
  constructor(host, opts) {
    this.host = host; this.opts = opts;
    this.root = null; this.nodes = [];            // top-level entries of the current folder
    this.sort = { key: 'name', dir: 1 };
    this.widths = { ...COLW };
    try { const w = JSON.parse(localStorage.getItem('brick.cols') || '{}'); for (const k of Object.keys(COLW)) if (w[k] >= 40 && w[k] <= 700) this.widths[k] = w[k]; } catch {}
    this.showHidden = false;
    this.selected = null;                          // path
    this.view = 'tree';                            // 'tree' | 'names' | 'text'
    this.results = null;
    this.ac = null;
    host.innerHTML = `
      <div class="fb-bar">
        <button class="fb-up" title="Parent folder (Backspace)">↑</button>
        <button class="fb-home" title="Go to the folder the terminal is in">⌂</button>
        <input class="fb-path" spellcheck="false" title="Folder path (Enter to go)">
        <button class="fb-refresh" title="Reload">↻</button>
        <label title="Show files and folders starting with a dot"><input type="checkbox" class="fb-hidden"> Hidden</label>
        <button class="fb-cd" title="Run cd in the terminal for this folder and switch back to it">cd here</button>
        <button class="fb-term" title="Back to the terminal (Alt+Shift+F)">Terminal</button>
      </div>
      <div class="fb-search">
        <input class="fb-q" spellcheck="false" placeholder="Search this folder…  (Enter)">
        <span class="seg fb-mode"><button data-m="name" title="Match file and folder names (* and ? work)">Names</button><button data-m="text" title="Look for text inside files">Text</button></span>
        <label title="Also search every folder below this one"><input type="checkbox" class="fb-rec"> Subfolders</label>
        <label title="Match case"><input type="checkbox" class="fb-case"> Aa</label>
        <label title="Regular expression"><input type="checkbox" class="fb-re"> .*</label>
        <input class="fb-inc" spellcheck="false" placeholder="Only files: *.js, *.md" title="Only search files whose names match (comma separated)">
        <label title="Search while you type (after a short pause)"><input type="checkbox" class="fb-live"> Live</label>
        <button class="fb-go">Search</button><button class="fb-stop" hidden>Stop</button><button class="fb-clear" hidden>Clear</button>
      </div>
      <div class="fb-body">
        <div class="fb-main"><div class="fb-head"></div><div class="fb-list" tabindex="0"></div></div>
        <div class="fb-preview" hidden><div class="fb-pv-head"><span class="fb-pv-title"></span><button class="fb-pv-pop" title="Open in its own window: movable, resizable, can be minimized to the bottom and stays open when you browse elsewhere">⧉</button><button class="fb-pv-close" title="Close (Esc)">×</button></div><div class="fb-pv-body"></div></div>
      </div>
      <div class="fb-status"></div>`;
    const q = (s) => host.querySelector(s);
    this.main = q('.fb-main'); this.applyWidths();
    this.$ = { path: q('.fb-path'), list: q('.fb-list'), head: q('.fb-head'), status: q('.fb-status'), q: q('.fb-q'), rec: q('.fb-rec'), cs: q('.fb-case'), re: q('.fb-re'),
      inc: q('.fb-inc'), live: q('.fb-live'), go: q('.fb-go'), stop: q('.fb-stop'), clear: q('.fb-clear'), preview: q('.fb-preview'), pvTitle: q('.fb-pv-title'), pvBody: q('.fb-pv-body') };
    this.doc = new DocView(this.$.pvBody, { api: opts.api });
    this.mode = 'name';
    try { this.live = localStorage.getItem('brick.live') !== '0'; } catch { this.live = true; }
    this.$.live.checked = this.live;
    this.wire();
    this.syncMode();
  }

  wire() {
    const { $ } = this, h = this.host;
    h.querySelector('.fb-up').onclick = () => this.up();
    h.querySelector('.fb-home').onclick = () => this.go(this.opts.getCwd() || this.root);
    h.querySelector('.fb-refresh').onclick = () => this.reload();
    h.querySelector('.fb-term').onclick = () => this.opts.close();
    h.querySelector('.fb-cd').onclick = () => this.root && this.opts.cdHere(this.root);
    h.querySelector('.fb-hidden').onchange = (e) => { this.showHidden = e.target.checked; this.render(); };
    $.path.onkeydown = (e) => { if (e.key === 'Enter') this.go($.path.value.trim()); else if (e.key === 'Escape') { $.path.value = this.root || ''; $.list.focus(); } e.stopPropagation(); };
    h.querySelectorAll('.fb-mode button').forEach((b) => { b.onclick = () => { this.mode = b.dataset.m; this.syncMode(); this.optionChanged(); }; });
    $.live.onchange = () => { this.live = $.live.checked; try { localStorage.setItem('brick.live', this.live ? '1' : '0'); } catch {} if (this.live) this.typed(); };
    $.q.oninput = () => this.typed();
    for (const c of [$.rec, $.cs, $.re]) c.onchange = () => this.optionChanged();
    $.inc.oninput = () => this.optionChanged();
    $.q.onkeydown = (e) => { if (e.key === 'Enter') this.runSearch(); else if (e.key === 'Escape') { this.clearSearch(); $.list.focus(); } e.stopPropagation(); };
    $.inc.onkeydown = (e) => { if (e.key === 'Enter') this.runSearch(); e.stopPropagation(); };
    $.go.onclick = () => this.runSearch();
    $.stop.onclick = () => this.ac?.abort();
    $.clear.onclick = () => this.clearSearch();
    h.querySelector('.fb-pv-close').onclick = () => this.closePreview();
    h.querySelector('.fb-pv-pop').onclick = () => { if (this.pv) { const { path, target } = this.pv; this.closePreview(); openWindow(this.opts.api, path, target); } };
    $.list.onkeydown = (e) => this.key(e);
    // Cmd/Ctrl+F anywhere in the view focuses the search box
    h.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $.q.focus(); $.q.select(); } });
  }

  syncMode() {
    this.host.querySelectorAll('.fb-mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === this.mode));
    this.$.inc.hidden = this.mode !== 'text';
    this.$.q.placeholder = this.mode === 'text' ? 'Find text in files…  (Enter)' : 'Find file and folder names…  (Enter, * and ? allowed)';
  }

  // ---- folder listing and the tree ----
  async fetchDir(path) {
    const res = await this.opts.api('list', { path });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  mk(entry, parent, dirPath) {
    return { ...entry, path: join(dirPath, entry.name), parent, expanded: false, children: null, loading: false };
  }
  async go(path) {
    if (!path) return;
    this.setStatus('Loading…');
    try {
      const data = await this.fetchDir(path);
      this.root = data.path; this.parentPath = data.parent;
      this.nodes = data.entries.map((e) => this.mk(e, null, data.path));
      this.$.path.value = this.root;
      this.selected = null;
      if (this.view !== 'tree') this.clearSearch(true);
      this.closePreview();
      this.render();
      this.opts.onNav?.(this.root);
    } catch (e) { this.setStatus(`${path}: ${e.message}`, true); }
  }
  open(path) { return this.go(this.root || path); }
  up() { if (this.parentPath) this.go(this.parentPath); }
  async reload() {
    if (!this.root) return;
    const expanded = new Set(); const walk = (list) => list.forEach((n) => { if (n.expanded) { expanded.add(n.path); if (n.children) walk(n.children); } });
    walk(this.nodes);
    try {
      const data = await this.fetchDir(this.root);
      this.nodes = data.entries.map((e) => this.mk(e, null, data.path));
      const restore = async (list) => { for (const n of list) if (n.type === 'dir' && expanded.has(n.path)) { try { n.children = (await this.fetchDir(n.path)).entries.map((e) => this.mk(e, n, n.path)); n.expanded = true; await restore(n.children); } catch {} } };
      await restore(this.nodes);
      this.render();
    } catch (e) { this.setStatus(e.message, true); }
  }
  async toggle(node, open = !node.expanded) {
    if (node.type !== 'dir') return;
    if (open && !node.children) {
      node.loading = true; this.render();
      try { node.children = (await this.fetchDir(node.path)).entries.map((e) => this.mk(e, node, node.path)); }
      catch (e) { node.loading = false; this.setStatus(`${node.path}: ${e.message}`, true); this.render(); return; }
      node.loading = false;
    }
    node.expanded = open;
    this.render();
  }

  compare() {
    const { key, dir } = this.sort;
    const val = (n) => (key === 'name' ? n.name.toLowerCase() : key === 'kind' ? kindOf(n).toLowerCase() : n[key] ?? 0);
    return (a, b) => {
      if (this.view === 'tree' && a.type !== b.type) return a.type === 'dir' ? -1 : 1;   // folders first in the tree
      const x = val(a), y = val(b);
      const c = typeof x === 'string' ? x.localeCompare(y, undefined, { numeric: true }) : x - y;
      return (c || a.name.localeCompare(b.name, undefined, { numeric: true })) * dir;
    };
  }
  visibleRows() {
    const rows = [], cmp = this.compare();
    const walk = (list, depth) => {
      for (const n of [...list].sort(cmp)) {
        if (!this.showHidden && n.name.startsWith('.')) continue;
        rows.push({ n, depth });
        if (n.expanded && n.children) walk(n.children, depth + 1);
      }
    };
    walk(this.nodes, 0);
    return rows;
  }

  // ---- drawing ----
  renderHead() {
    const head = this.$.head; head.replaceChildren();
    head.className = `fb-head cols ${this.view}`;
    for (const [key, label] of COLS) {
      const b = el('button', `fb-h fb-h-${key}`, label);
      if (this.sort.key === key) b.append(el('span', 'fb-arrow', this.sort.dir > 0 ? ' ▲' : ' ▼'));
      b.onclick = () => { this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : 1 }; this.render(); };
      head.append(b);
      this.addGrip(b, key);
    }
  }
  // Column widths live in CSS variables on .fb-main (shared by header and rows); Name takes the rest.
  // The grip on a column's right edge widens that column (Name's edge narrows Date instead).
  applyWidths() {
    for (const k of Object.keys(COLW)) this.main.style.setProperty(`--cw-${k}`, `${this.widths[k]}px`);
  }
  addGrip(b, key) {
    const grip = el('span', 'fb-grip'); grip.title = 'Drag to resize · double-click to reset';
    const target = key === 'name' ? 'mtime' : key, sign = key === 'name' ? -1 : 1;
    grip.onclick = (e) => e.stopPropagation();
    grip.ondblclick = (e) => { e.stopPropagation(); this.widths[target] = COLW[target]; this.saveWidths(); this.applyWidths(); };
    grip.onpointerdown = (e) => {
      e.preventDefault(); e.stopPropagation();
      const x0 = e.clientX, w0 = this.widths[target];
      grip.setPointerCapture(e.pointerId); grip.classList.add('drag');
      grip.onpointermove = (m) => { this.widths[target] = Math.max(40, Math.min(700, Math.round(w0 + sign * (m.clientX - x0)))); this.applyWidths(); };
      grip.onpointerup = grip.onpointercancel = () => { grip.classList.remove('drag'); grip.onpointermove = grip.onpointerup = grip.onpointercancel = null; this.saveWidths(); };
    };
    b.append(grip);
  }
  saveWidths() { try { localStorage.setItem('brick.cols', JSON.stringify(this.widths)); } catch {} }
  render() {
    if (this.view === 'text') return this.renderGrep();
    this.renderHead();
    const list = this.$.list; list.replaceChildren();
    list.className = `fb-list ${this.view}`;
    const frag = document.createDocumentFragment();
    const items = this.view === 'names' ? [...this.results.hits].sort(this.compare()).map((n) => ({ n, depth: 0 })) : this.visibleRows();
    for (const { n, depth } of items) {
      const row = el('div', `fb-row${n.path === this.selected ? ' sel' : ''}${n.name.startsWith('.') ? ' dotted' : ''}`);
      row.dataset.path = n.path; row.dataset.type = n.type;
      const name = el('div', 'fb-name');
      name.style.paddingLeft = `${8 + depth * 18}px`;
      if (this.view === 'tree') {
        const tw = el('span', `fb-tw${n.type === 'dir' ? '' : ' none'}`, n.loading ? '…' : n.expanded ? '▾' : '▸');
        tw.onclick = (e) => { e.stopPropagation(); this.toggle(n); };
        name.append(tw);
      }
      name.append(el('span', 'fb-ic', icon(n)), el('span', 'fb-label', this.view === 'names' ? this.rel(n.path) : n.name));
      row.append(name, el('div', 'fb-date', fmtDate(n.mtime)), el('div', 'fb-size', n.type === 'dir' ? '—' : fmtSize(n.size)), el('div', 'fb-kind', kindOf(n)));
      row.onclick = () => { this.select(n.path); this.$.list.focus(); };
      row.ondblclick = () => (n.type === 'dir' ? this.go(n.path) : this.preview(n.path));
      frag.append(row);
    }
    list.append(frag);
    if (this.view === 'tree') this.setStatus(`${items.length} item${items.length === 1 ? '' : 's'}${this.showHidden ? '' : ' (hidden items not shown)'}`);
    else if (this.results) this.setStatus(this.results.summary);
  }
  rel(p) { return this.root && p.startsWith(this.root + '/') ? p.slice(this.root.length + 1) : p; }
  select(path) {
    this.selected = path;
    this.$.list.querySelectorAll('.fb-row').forEach((r) => r.classList.toggle('sel', r.dataset.path === path));
    this.$.list.querySelector('.fb-row.sel')?.scrollIntoView({ block: 'nearest' });
  }
  setStatus(text, bad = false) { this.$.status.textContent = text; this.$.status.classList.toggle('bad', bad); }

  key(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = this.visibleRows();
    const i = rows.findIndex((r) => r.n.path === this.selected), cur = rows[i]?.n;
    const move = (j) => { if (rows[j]) this.select(rows[j].n.path); };
    if (e.key === 'ArrowDown') { e.preventDefault(); move(i < 0 ? 0 : i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(i < 0 ? 0 : i - 1); }
    else if (e.key === 'ArrowRight' && cur?.type === 'dir') { e.preventDefault(); this.toggle(cur, true); }
    else if (e.key === 'ArrowLeft' && cur) { e.preventDefault(); if (cur.type === 'dir' && cur.expanded) this.toggle(cur, false); else if (cur.parent) this.select(cur.parent.path); }
    else if (e.key === 'Enter' && cur) { e.preventDefault(); cur.type === 'dir' ? this.go(cur.path) : this.preview(cur.path); }
    else if (e.key === 'Backspace') { e.preventDefault(); this.up(); }
    else if (e.key === 'Escape') { e.preventDefault(); if (!this.$.preview.hidden) this.closePreview(); else if (this.view !== 'tree') this.clearSearch(); }
    e.stopPropagation();
  }

  // ---- search ----
  // Live search: wait for a pause in typing, then search (or, if the box was emptied, go back to the full listing).
  typed() {
    clearTimeout(this.typing);
    if (!this.live) return;
    this.typing = setTimeout(() => {
      const q = this.$.q.value;
      if (!q) { if (this.view !== 'tree') this.clearSearch(); }
      else if (this.mode === 'name' || q.length >= 2) this.runSearch();   // one letter would match nearly every line of text
    }, window.__brick?.liveDelay ?? 350);
  }
  optionChanged() { if (this.live && this.$.q.value && this.view !== 'tree') this.typed(); }
  options() {
    return { root: this.root, query: this.$.q.value, mode: this.mode, recursive: this.$.rec.checked, caseSensitive: this.$.cs.checked, regex: this.$.re.checked,
      include: this.mode === 'text' ? this.$.inc.value : '', hidden: this.showHidden };
  }
  regexFor(o) {   // for highlighting; mirrors what the server matched
    try { return new RegExp(o.regex ? o.query : escapeRe(o.query), o.caseSensitive ? 'g' : 'gi'); } catch { return null; }
  }
  async runSearch() {
    clearTimeout(this.typing);
    if (!this.root) return;
    if (!this.$.q.value) { if (this.view !== 'tree') this.clearSearch(); return; }   // an empty box means "everything": back to the listing
    this.ac?.abort();
    const ac = this.ac = new AbortController(), o = this.options();
    this.view = o.mode === 'text' ? 'text' : 'names';
    this.closePreview();
    const r = this.results = { o, re: this.regexFor(o), hits: [], files: new Map(), matches: 0, summary: '', running: true, scanned: 0 };
    this.$.stop.hidden = false; this.$.clear.hidden = false; this.$.go.hidden = true;
    this.schedule(); this.setStatus('Searching…');
    try {
      const res = await this.opts.api('search', o, ac.signal);
      if (!res.ok) throw new Error(await res.text());
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i; (i = buf.indexOf('\n')) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) this.onEvent(r, JSON.parse(line)); }
      }
    } catch (e) { if (e.name !== 'AbortError') { r.error = e.message; } else r.aborted = true; }
    r.running = false;
    if (this.results === r) {
      if (r.error) r.summary = `Search failed: ${r.error}`;
      else if (!r.done) r.summary = `Stopped. ${this.counts(r)}`;
      this.$.stop.hidden = true; this.$.go.hidden = false;
      this.render();
      if (r.error) this.setStatus(r.summary, true);
    }
  }
  counts(r) { return r.o.mode === 'text' ? `${r.matches} hit${r.matches === 1 ? '' : 's'} in ${r.files.size} file${r.files.size === 1 ? '' : 's'} of ${r.scanned} searched` : `${r.hits.length} result${r.hits.length === 1 ? '' : 's'}`; }
  onEvent(r, ev) {
    if (ev.t === 'hit') r.hits.push({ path: ev.path, name: ev.name, type: ev.type, size: ev.size, mtime: ev.mtime });
    else if (ev.t === 'match') {
      let f = r.files.get(ev.path); if (!f) r.files.set(ev.path, f = { path: ev.path, matches: [], open: true });
      f.matches.push(ev); r.matches++;
    } else if (ev.t === 'progress') r.scanned = ev.files;
    else if (ev.t === 'done') {
      r.done = true; r.scanned = ev.files; r.truncated = ev.truncated;
      r.summary = `${r.o.mode === 'text' ? 'Search' : 'Names matching'} "${r.o.query}" (${this.counts(r)}${ev.skipped ? `, ${ev.skipped} skipped: binary or large` : ''}${ev.truncated ? ', stopped at the limit' : ''})`;
    }
    this.schedule();
  }
  schedule() { if (this.pending) return; this.pending = setTimeout(() => { this.pending = 0; if (this.results) { this.render(); if (this.results.running) this.setStatus(`Searching… ${this.results.scanned || this.results.hits.length} ${this.results.o.mode === 'text' ? 'files' : 'found'}, ${this.counts(this.results)}`); } }, 120); }
  clearSearch(silent) {
    this.ac?.abort(); this.results = null; this.view = 'tree';
    this.$.q.value = ''; this.$.stop.hidden = true; this.$.clear.hidden = true; this.$.go.hidden = false;
    this.closePreview();
    if (!silent) this.render();
  }

  // Notepad++-style results: one block per file, one line per hit, the hit highlighted.
  renderGrep() {
    const { $ } = this, r = this.results;
    $.head.className = 'fb-head grep'; $.head.replaceChildren();
    const title = el('span', 'gr-title', r.summary || `Search "${r.o.query}" …`);
    const collapse = el('button', 'gr-btn', 'Collapse all'), expand = el('button', 'gr-btn', 'Expand all');
    collapse.onclick = () => { r.files.forEach((f) => { f.open = false; }); this.render(); };
    expand.onclick = () => { r.files.forEach((f) => { f.open = true; }); this.render(); };
    $.head.append(title, collapse, expand);
    const list = $.list; list.replaceChildren(); list.className = 'fb-list text';
    const frag = document.createDocumentFragment();
    for (const f of [...r.files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const h = el('div', 'gr-file');
      h.title = f.path;
      h.append(el('span', 'fb-tw', f.open ? '▾' : '▸'), el('span', 'gr-path', this.rel(f.path)), el('span', 'gr-count', ` (${f.matches.length} hit${f.matches.length === 1 ? '' : 's'})`));
      h.onclick = () => { f.open = !f.open; this.render(); };
      frag.append(h);
      if (!f.open) continue;
      for (const m of f.matches) {
        const row = el('div', 'gr-line'); row.dataset.path = m.path; row.dataset.line = m.line;
        row.append(el('span', 'gr-no', `Line ${m.line}:`), this.highlight(m.text, r.re));
        row.onclick = () => { list.querySelectorAll('.gr-line.sel').forEach((x) => x.classList.remove('sel')); row.classList.add('sel'); this.preview(m.path, m.line, m.col, m.len); };
        frag.append(row);
      }
    }
    if (!r.files.size && !r.running) frag.append(el('div', 'gr-none', r.error ? r.error : 'No matches.'));
    list.append(frag);
    if (!r.running) this.setStatus(r.summary, !!r.error);
  }
  highlight(text, re) {
    const span = el('span', 'gr-text'), lead = text.length - text.trimStart().length, t = text.slice(lead);
    let last = 0;
    if (re) { re.lastIndex = 0; for (const m of t.matchAll(re)) { if (!m[0]) continue; span.append(t.slice(last, m.index), el('mark', '', m[0])); last = m.index + m[0].length; } }
    span.append(t.slice(last));
    return span;
  }

  // ---- preview of a file beside the list (a DocView); the pop-out button turns it into a floating window ----
  preview(path, line, col, len) {
    const target = line ? { line, re: this.results?.re } : {};
    this.pv = { path, target };
    this.$.preview.hidden = false; this.$.pvTitle.textContent = path;
    this.doc.load(path, target);
  }
  closePreview() { this.pv = null; this.doc.clear(); this.$.preview.hidden = true; }
  focus() { this.$.list.focus(); }
  dispose() { this.ac?.abort(); clearTimeout(this.pending); clearTimeout(this.typing); }
}

export { shq };
