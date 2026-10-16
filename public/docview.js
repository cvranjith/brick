// Read-only document viewer: syntax highlighting, rendered markdown, plain text with or without line numbers, find in file.
// DocView is the component; openWindow() puts one in a floating window that can be moved, resized, minimized to the tray and
// that stays open whatever the Files view does afterwards. Nothing here ever writes to disk.

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const base = (p) => p.slice(p.lastIndexOf('/') + 1) || '/';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const LANG_BY_EXT = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', pyw: 'python',
  yml: 'yaml', yaml: 'yaml', json: 'json', jsonc: 'json', sh: 'bash', bash: 'bash', zsh: 'bash', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', less: 'less', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', java: 'java', kt: 'kotlin',
  rb: 'ruby', php: 'php', swift: 'swift', sql: 'sql', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', lua: 'lua', pl: 'perl', r: 'r', diff: 'diff',
  patch: 'diff', m: 'objectivec', cs: 'csharp', mk: 'makefile', graphql: 'graphql', gql: 'graphql' };
const LANG_BY_NAME = { makefile: 'makefile', dockerfile: 'bash', '.zshrc': 'bash', '.bashrc': 'bash', '.zprofile': 'bash', '.profile': 'bash', '.zshenv': 'bash' };
const MD_EXT = new Set(['md', 'markdown', 'mdown', 'mkd']);
const MAX_FORMAT = 400 * 1024;   // beyond this, highlighting and markdown rendering are skipped (plain is instant)
const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,pre,td,th,dt,dd,blockquote,summary,caption';

export function kindOf(path) {
  const name = base(path).toLowerCase(), ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (MD_EXT.has(ext)) return { md: true, lang: 'markdown' };
  const lang = LANG_BY_NAME[name] || LANG_BY_EXT[ext];
  return { md: false, lang: lang && window.hljs?.getLanguage(lang) ? lang : null };
}

// hljs wraps tokens in <span>; a token (comment, string) can span lines, so close and reopen spans at each line break.
function splitHighlighted(html) {
  const lines = [], open = []; let cur = '', last = 0, m;
  const re = /<span[^>]*>|<\/span>|\n/g;
  while ((m = re.exec(html))) {
    cur += html.slice(last, m.index); last = re.lastIndex;
    if (m[0] === '\n') { cur += '</span>'.repeat(open.length); lines.push(cur); cur = open.join(''); }
    else if (m[0] === '</span>') { open.pop(); cur += m[0]; }
    else { open.push(m[0]); cur += m[0]; }
  }
  lines.push(cur + html.slice(last));
  return lines;
}

// Wrap [start,end) of the concatenated text of `nodes` in <mark class=cls>. Splits text nodes as needed; keeps `nodes` current.
function wrapRange(nodes, start, end, cls, idx) {
  let pos = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i], len = n.data.length, s = Math.max(start, pos), e = Math.min(end, pos + len);
    if (s < e) {
      let mid = n;
      if (s > pos) mid = n.splitText(s - pos);
      const tail = e - s < mid.data.length ? mid.splitText(e - s) : null;
      const mark = el('mark', cls); if (idx !== undefined) mark.dataset.i = idx;
      mid.parentNode.insertBefore(mark, mid); mark.appendChild(mid);
      const repl = []; if (mid !== n) repl.push(n); repl.push(mid); if (tail) repl.push(tail);
      nodes.splice(i, 1, ...repl); i += repl.length - 1;
    }
    pos += len;
  }
}
// Find every match of `re` in each group of text nodes (a group = one line or one block, so matches can cross formatting spans).
function markGroups(groups, re, cls, cap = 5000) {
  const found = [];
  for (const nodes of groups) {
    const text = nodes.map((n) => n.data).join('');
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)) && found.length < cap;) { if (!m[0]) { re.lastIndex++; continue; } found.push({ nodes, start: m.index, end: m.index + m[0].length, i: found.length }); }
    if (found.length >= cap) break;
  }
  for (const f of found.reverse()) wrapRange(f.nodes, f.start, f.end, cls, f.i);   // from the end, so earlier offsets stay valid
  return found.length;
}
function textGroups(root, keyOf) {
  const groups = new Map(), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    if (n.parentElement.closest('.pv-n')) continue;
    const key = keyOf(n.parentElement) || root;
    (groups.get(key) || groups.set(key, []).get(key)).push(n);
  }
  return [...groups.values()];
}
const unmark = (root, sel) => {
  const parents = new Set();
  root.querySelectorAll(sel).forEach((m) => { parents.add(m.parentNode); m.replaceWith(...m.childNodes); });
  parents.forEach((p) => p.normalize());
};

let mdReady = false;
function renderMarkdown(text) {
  const { marked, DOMPurify } = window;
  if (!marked || !DOMPurify) return null;
  if (!mdReady) {
    mdReady = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => { if (node.tagName === 'A') { node.setAttribute('rel', 'noopener noreferrer'); node.setAttribute('target', '_blank'); } });
  }
  const html = marked.parse(text, { gfm: true, async: false });
  // File contents are untrusted and this page can reach a shell: sanitize, and no images (no network fetches, no tracking pixels)
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['img', 'picture', 'style', 'form', 'input', 'button', 'iframe', 'svg', 'math', 'video', 'audio', 'source', 'link', 'meta', 'base', 'object', 'embed'], FORBID_ATTR: ['style', 'src', 'srcset'] });
}

const SETTINGS_KEY = 'brick.doc';
const loadSettings = () => { try { return { view: 'formatted', numbers: true, wrap: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { view: 'formatted', numbers: true, wrap: false }; } };

export class DocView {
  constructor(host, { api }) {
    this.api = api; this.settings = loadSettings(); this.cs = false; this.cur = 0; this.total = 0;
    host.classList.add('doc');
    host.innerHTML = `
      <div class="doc-bar">
        <span class="seg doc-mode"><button data-v="formatted" title="Highlighted code or rendered markdown">Formatted</button><button data-v="plain" title="The text as it is, without formatting">Plain</button></span>
        <label title="Line numbers"><input type="checkbox" class="doc-num"> Lines</label>
        <label title="Wrap long lines"><input type="checkbox" class="doc-wrap"> Wrap</label>
        <span class="doc-find"><input class="doc-q" spellcheck="false" placeholder="Find in file…"><span class="doc-count"></span>
          <button class="doc-prev" title="Previous (Shift+Enter)">▲</button><button class="doc-next" title="Next (Enter)">▼</button><button class="doc-cs" title="Match case">Aa</button></span>
        <button class="doc-reload" title="Read the file again">↻</button>
      </div>
      <div class="doc-body" tabindex="0"></div>
      <div class="doc-foot"></div>`;
    const q = (s) => host.querySelector(s);
    this.host = host;
    this.$ = { body: q('.doc-body'), foot: q('.doc-foot'), q: q('.doc-q'), count: q('.doc-count'), num: q('.doc-num'), wrap: q('.doc-wrap') };
    this.$.num.checked = this.settings.numbers; this.$.wrap.checked = this.settings.wrap;
    host.querySelectorAll('.doc-mode button').forEach((b) => { b.onclick = () => { this.save({ view: b.dataset.v }); this.render(); }; });
    this.$.num.onchange = () => { this.save({ numbers: this.$.num.checked }); this.syncClasses(); };
    this.$.wrap.onchange = () => { this.save({ wrap: this.$.wrap.checked }); this.syncClasses(); };
    q('.doc-reload').onclick = () => this.path && this.load(this.path, this.target);
    q('.doc-next').onclick = () => this.step(1);
    q('.doc-prev').onclick = () => this.step(-1);
    q('.doc-cs').onclick = (e) => { this.cs = !this.cs; e.currentTarget.classList.toggle('on', this.cs); this.applyFind(); };
    this.$.q.oninput = () => { clearTimeout(this.typing); this.dirty = true; this.typing = setTimeout(() => this.applyFind(), 120); };
    this.$.q.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (this.dirty) this.applyFind(); else this.step(e.shiftKey ? -1 : 1); }   // Enter straight after typing shows the first match
      else if (e.key === 'Escape') { if (this.$.q.value) { this.$.q.value = ''; this.applyFind(); e.stopPropagation(); } else this.$.body.focus(); }
      if (e.key !== 'Escape' || !this.$.q.value) e.stopPropagation();
    };
    host.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); e.stopPropagation(); this.focusFind(); } else if (e.key === 'F3' || ((e.metaKey || e.ctrlKey) && e.key === 'g')) { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); } });
    this.$.body.addEventListener('click', (e) => {   // links in rendered markdown never navigate this page; web links open in a new tab
      const a = e.target.closest('a'); if (!a) return;
      e.preventDefault();
      if (/^https?:\/\//i.test(a.getAttribute('href') || '')) window.open(a.href, '_blank', 'noopener,noreferrer');
    });
    this.syncClasses();
  }
  save(patch) { Object.assign(this.settings, patch); try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch {} }
  focusFind() { this.$.q.focus(); this.$.q.select(); }
  clear() { this.tok = null; this.path = null; this.file = null; this.$.body.replaceChildren(); this.$.foot.textContent = ''; this.total = 0; this.$.count.textContent = ''; }
  msg(text) { this.$.body.replaceChildren(el('div', 'pv-msg', text)); this.$.foot.textContent = ''; }

  async load(path, target = {}) {
    this.path = path; this.target = target;
    const tok = this.tok = {};
    this.msg('Loading…');
    try {
      const res = await this.api('read', { path });
      if (!res.ok) throw new Error(await res.text());
      const f = await res.json();
      if (this.tok !== tok) return;
      this.file = f;
      this.render();
    } catch (e) { if (this.tok === tok) this.msg(e.message); }
  }

  syncClasses() {
    const { body } = this.$, s = this.settings;
    body.classList.toggle('nonum', !s.numbers); body.classList.toggle('wrap', s.wrap);
    this.host.querySelectorAll('.doc-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.view));
    this.$.num.disabled = !!this.rendered;
  }

  render() {
    const f = this.file; if (!f) return;
    const { body } = this.$;
    if (f.binary) { this.msg(`Binary file (${fmtSize(f.size)}), no preview.`); return; }
    const { md, lang } = kindOf(this.path), text = f.text.replace(/\r\n?/g, '\n');
    const formatted = this.settings.view === 'formatted' && text.length <= MAX_FORMAT;
    this.rendered = false; let note = '';
    if (formatted && md) {
      const html = renderMarkdown(text);
      if (html !== null) {
        const div = el('div', 'md'); div.innerHTML = html;
        if (window.hljs) div.querySelectorAll('pre code').forEach((c) => { const l = /language-([\w+-]+)/.exec(c.className)?.[1]; if (l && window.hljs.getLanguage(l)) window.hljs.highlightElement(c); });
        body.replaceChildren(div); this.rendered = true; note = 'Markdown, rendered';
      }
    }
    if (!this.rendered) {
      const lines = formatted && lang ? splitHighlighted(window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value) : null;
      const raw = text.split('\n'), frag = document.createDocumentFragment();
      const count = Math.min(raw.length, 20000);
      for (let i = 0; i < count; i++) {
        const row = el('div', 'pv-l'), no = el('span', 'pv-n', String(i + 1)), t = el('span', 'pv-t');
        if (lines) t.innerHTML = lines[i] ?? ''; else t.textContent = raw[i];
        row.append(no, t); frag.append(row);
      }
      if (raw.length > count || f.truncated) frag.append(el('div', 'pv-msg', `Showing the first ${raw.length > count ? `${count} lines` : fmtSize(512 * 1024)} of ${fmtSize(f.size)}.`));
      body.replaceChildren(frag);
      note = lines ? (window.hljs.getLanguage(lang)?.name || lang) : this.settings.view === 'plain' ? 'Plain text' : text.length > MAX_FORMAT ? 'Plain text (too large to format)' : 'Plain text';
      this.applyTarget();
    }
    this.$.foot.textContent = `${note} · ${fmtSize(f.size)} · ${text.split('\n').length} lines`;
    this.syncClasses();
    this.applyFind(true);
  }

  // jump to a grep hit: mark its line and the matches on it
  applyTarget() {
    const { line, re } = this.target || {};
    const row = line && this.$.body.querySelectorAll('.pv-l')[line - 1];
    if (!row) { this.$.body.scrollTop = 0; return; }
    row.classList.add('hit');
    if (re) markGroups(textGroups(row, () => row), re, 'gm');
    row.scrollIntoView({ block: 'center' });
  }

  // ---- find in file ----
  applyFind(keepScroll) {
    const body = this.$.body; clearTimeout(this.typing); this.dirty = false;
    unmark(body, 'mark.find');
    const q = this.$.q.value;
    this.total = 0; this.cur = 0;
    if (q && this.file && !this.file.binary) {
      const re = new RegExp(escapeRe(q), this.cs ? 'g' : 'gi');
      const keyOf = this.rendered ? (e) => e.closest(BLOCKS) : (e) => e.closest('.pv-l');
      this.total = markGroups(textGroups(body, keyOf), re, 'find');
    }
    this.showCurrent(!keepScroll);
  }
  step(d) { if (!this.total) return; this.cur = (this.cur + d + this.total) % this.total; this.showCurrent(true); }
  showCurrent(scroll) {
    this.$.body.querySelectorAll('mark.find.cur').forEach((m) => m.classList.remove('cur'));
    const marks = this.total ? [...this.$.body.querySelectorAll(`mark.find[data-i="${this.cur}"]`)] : [];
    marks.forEach((m) => m.classList.add('cur'));
    if (scroll && marks[0]) marks[0].scrollIntoView({ block: 'center', inline: 'nearest' });
    this.$.count.textContent = this.$.q.value ? (this.total ? `${this.cur + 1} / ${this.total}` : 'no match') : '';
    this.$.count.classList.toggle('none', !!this.$.q.value && !this.total);
  }
}

// ---- floating windows ----
export const viewers = new Map();   // path -> window controller
let order = [];                      // back to front
const place = () => order.forEach((w, i) => { w.el.style.zIndex = Math.min(39, 30 + i); });
function raise(w) { order = order.filter((x) => x !== w).concat(w); place(); }

export function openWindow(api, path, target = {}) {
  const existing = viewers.get(path);
  if (existing) { existing.restore(); if (target.line) existing.doc.load(path, target); return existing; }
  const n = viewers.size, tray = document.getElementById('tray');
  const win = el('div', 'vwin');
  win.innerHTML = `<div class="vwin-bar"><span class="vwin-title"></span><span class="vwin-dir"></span><button class="vwin-min" title="Minimize to the bottom">–</button><button class="vwin-x" title="Close">×</button></div><div class="vwin-body"></div>`;
  win.querySelector('.vwin-title').textContent = base(path);
  win.querySelector('.vwin-dir').textContent = path.slice(0, path.lastIndexOf('/')) || '/';
  win.title = path;
  const w = Math.min(720, innerWidth - 60), h = Math.min(520, innerHeight - 100);
  Object.assign(win.style, { width: `${w}px`, height: `${h}px`, left: `${Math.max(10, innerWidth - w - 24 - 28 * (n % 8))}px`, top: `${Math.min(innerHeight - h - 40, 60 + 28 * (n % 8))}px` });
  document.body.appendChild(win);
  const doc = new DocView(win.querySelector('.vwin-body'), { api });
  const chip = el('button', 'chip'); chip.title = path;
  chip.innerHTML = '<span class="chip-name"></span><span class="chip-x" title="Close">×</span>';
  chip.querySelector('.chip-name').textContent = base(path);
  const ctl = {
    el: win, chip, doc, path,
    minimize() { win.hidden = true; tray.append(chip); tray.hidden = false; },
    restore() { win.hidden = false; chip.remove(); tray.hidden = !tray.children.length; raise(ctl); },
    close() { doc.clear(); win.remove(); chip.remove(); viewers.delete(path); order = order.filter((x) => x !== ctl); tray.hidden = !tray.children.length; },
  };
  win.querySelector('.vwin-min').onclick = () => ctl.minimize();
  win.querySelector('.vwin-x').onclick = () => ctl.close();
  chip.onclick = (e) => (e.target.closest('.chip-x') ? ctl.close() : ctl.restore());
  win.addEventListener('pointerdown', () => raise(ctl));
  win.querySelector('.vwin-bar').addEventListener('pointerdown', (e) => {   // drag by the title bar
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = win.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      win.style.left = `${Math.min(innerWidth - 80, Math.max(80 - r.width, ev.clientX - dx))}px`;
      win.style.top = `${Math.min(innerHeight - 40, Math.max(0, ev.clientY - dy))}px`;
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.classList.remove('dragging'); };
    document.body.classList.add('dragging');
    addEventListener('pointermove', move); addEventListener('pointerup', up);
    e.preventDefault();
  });
  viewers.set(path, ctl); order.push(ctl); place();
  doc.load(path, target);
  return ctl;
}
