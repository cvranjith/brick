// File browsing for the Files view: list a folder, read a text file, search names or text.
// Same trust level as the shell (anything the user can read there), so the HTTP layer applies the same token/Host/Origin checks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_ENTRIES = 20000;
const MAX_READ = 512 * 1024;          // preview size
const MAX_TEXT_FILE = 2 * 1024 * 1024; // larger files are skipped by text search
const MAX_MATCHES = 5000;
const MAX_NAME_HITS = 5000;
const MAX_LINE = 2000;                 // longer lines are cut before matching and before being sent
const SKIP_DIRS = new Set(['node_modules', '.git']);   // unless "hidden" is on

export class FsError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

const abs = (p) => {
  if (typeof p === 'string' && (p === '~' || p.startsWith('~/'))) p = os.homedir() + p.slice(1);
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw new FsError('path must be absolute');
  return path.resolve(p);
};
const wrap = (e) => new FsError(e.code === 'ENOENT' ? 'No such file or folder' : e.code === 'EACCES' || e.code === 'EPERM' ? 'Permission denied' : e.message, e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 400);

async function entryInfo(dir, dirent) {
  const full = path.join(dir, dirent.name);
  let st, link = dirent.isSymbolicLink(), broken = false;
  try { st = await fs.promises.stat(full); }                      // follows links, so a link to a folder is a folder
  catch { try { st = await fs.promises.lstat(full); broken = link; } catch { return null; } }
  return { name: dirent.name, type: st.isDirectory() ? 'dir' : 'file', link, broken, size: st.size, mtime: st.mtimeMs };
}

export async function list(dir) {
  dir = abs(dir);
  let dirents;
  try { dirents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { throw wrap(e); }
  if (dirents.length > MAX_ENTRIES) dirents = dirents.slice(0, MAX_ENTRIES);
  const entries = [];
  for (let i = 0; i < dirents.length; i += 64) {
    entries.push(...(await Promise.all(dirents.slice(i, i + 64).map((d) => entryInfo(dir, d)))).filter(Boolean));
  }
  return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), entries };
}

export async function read(file) {
  file = abs(file);
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const st = await fh.stat();
    if (st.isDirectory()) throw new FsError('is a folder');
    const buf = Buffer.alloc(Math.min(st.size, MAX_READ));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.subarray(0, 8000).includes(0)) return { path: file, size: st.size, mtime: st.mtimeMs, binary: true };
    return { path: file, size: st.size, mtime: st.mtimeMs, binary: false, truncated: st.size > bytesRead, text: head.toString('utf8') };
  } catch (e) { throw e instanceof FsError ? e : wrap(e); } finally { await fh?.close(); }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const globRe = (g) => new RegExp('^' + g.trim().split('*').map((p) => escapeRe(p).replace(/\\\?/g, '.')).join('.*') + '$', 'i');

// Build the matcher for the query. Name search: a glob if it has * or ?, a regex if asked, else a substring.
function compile({ query, regex, caseSensitive, mode }) {
  if (typeof query !== 'string' || !query || query.length > 500) throw new FsError('empty or too long query');
  const flags = caseSensitive ? '' : 'i';
  try {
    if (regex) return new RegExp(query, flags);
    if (mode === 'name' && /[*?]/.test(query)) return new RegExp('^' + query.split('*').map((p) => escapeRe(p).replace(/\\\?/g, '.')).join('.*') + '$', flags);
    return new RegExp(escapeRe(query), flags);
  } catch (e) { throw new FsError(`bad pattern: ${e.message}`); }
}

// Streams events through emit(): {t:'hit'} (name search), {t:'match'} (text search), {t:'progress'}, then {t:'done'}.
export async function search(opts, emit, signal) {
  const root = abs(opts.root);
  const mode = opts.mode === 'text' ? 'text' : 'name';
  const re = compile({ ...opts, mode });
  const includes = typeof opts.include === 'string' && opts.include.trim() ? opts.include.split(',').filter((g) => g.trim()).map(globRe) : null;
  const hidden = !!opts.hidden, recursive = !!opts.recursive;
  let files = 0, matches = 0, hits = 0, filesWithMatches = 0, skipped = 0, truncated = false;
  const tick = () => new Promise((r) => setImmediate(r));
  try { if (!(await fs.promises.stat(root)).isDirectory()) throw new FsError('not a folder'); } catch (e) { throw e instanceof FsError ? e : wrap(e); }

  const stack = [root];
  outer: while (stack.length) {
    const dir = stack.pop();
    let dirents;
    try { dirents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs = [];
    for (const d of dirents) {
      if (signal.aborted) break outer;
      if (!hidden && (d.name.startsWith('.') || SKIP_DIRS.has(d.name))) continue;
      if (hidden && d.name === '.git' && d.isDirectory()) continue;       // never search inside .git objects
      const full = path.join(dir, d.name);
      const isDir = d.isDirectory();                                       // symbolic links to folders are not followed
      if (isDir) { if (recursive) subdirs.push(full); }
      if (mode === 'name') {
        if (!re.test(d.name)) continue;
        if (includes && !isDir && !includes.some((g) => g.test(d.name))) continue;
        let st; try { st = await fs.promises.stat(full); } catch { continue; }
        emit({ t: 'hit', path: full, name: d.name, type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs });
        if (++hits >= MAX_NAME_HITS) { truncated = true; break outer; }
      } else if (!isDir && (d.isFile() || d.isSymbolicLink())) {
        if (includes && !includes.some((g) => g.test(d.name))) continue;
        let st; try { st = await fs.promises.stat(full); } catch { continue; }
        if (!st.isFile()) continue;                                        // a link to a folder, a socket...
        files++;
        if (st.size > MAX_TEXT_FILE) { skipped++; continue; }
        let buf; try { buf = await fs.promises.readFile(full); } catch { skipped++; continue; }
        if (buf.subarray(0, 8000).includes(0)) { skipped++; continue; }    // binary
        const lines = buf.toString('utf8').split('\n');
        let found = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].replace(/\r$/, '').slice(0, MAX_LINE);
          const m = re.exec(line);
          if (!m) continue;
          found = true;
          emit({ t: 'match', path: full, line: i + 1, col: m.index, len: Math.max(m[0].length, 0), text: line.slice(0, 500) });
          if (++matches >= MAX_MATCHES) { truncated = true; break outer; }
        }
        if (found) filesWithMatches++;
        if (files % 50 === 0) { emit({ t: 'progress', files }); await tick(); }
      }
    }
    stack.push(...subdirs.reverse());
  }
  emit({ t: 'done', mode, files, matches, hits, filesWithMatches, skipped, truncated, aborted: signal.aborted });
}
