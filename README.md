# Brick

A tiny block-based terminal in the browser. Node backend (a real zsh on a pty via `node-pty`)
+ `xterm.js` frontend. A small personal project, not a product.

```
npm install
npm start          # prints http://127.0.0.1:4477/?t=<token>
npm test           # 115 tests: protocol (real zsh), UI, layout, drag and drop, appearance, tab bar, Files view and its API, capture endpoint (headless Chrome)
```

Needs Node 22+, zsh, and (for the UI tests) Google Chrome.

Third-party code served to the page: xterm.js (terminal), highlight.js (syntax colours, BSD-3), marked (markdown, MIT) and DOMPurify (sanitising rendered markdown, MPL-2.0 or Apache-2.0), all installed from npm and served locally, never from a CDN.

## Tabs and splits
Every pane is its own shell (own WebSocket, pty, session id, working directory). A tab holds a tree of panes;
drag the divider between panes to resize them. Closing a pane gives its space to its neighbour; `exit` in a pane
closes that pane; closing the last tab (or `exit` in the last pane) opens a fresh one.

| Action | Button | Shortcut |
|---|---|---|
| New tab | `+` | Alt+Shift+T |
| Split right / down | header buttons | Alt+Shift+D / Alt+Shift+S |
| Close pane (or tab if it is the last pane) | `×` on the pane | Alt+Shift+W |
| Previous / next pane | click a pane | Alt+Shift+[ / Alt+Shift+] |
| Go to tab 1-9 | click the tab | Alt+Shift+1..9 |
| Reorder tabs | drag a tab along the bar (left/right, or up/down in a side bar) | |
| Move a pane | drag its title bar onto the edge of another pane (re-splits there) or its middle (swaps) | |
| Pane into a new tab | drag its title bar to the empty part of the tab bar, or the `⇱` button | |
| Pane into another tab | drag its title bar onto that tab (hold over a tab for 0.6 s to open it and pick the exact spot) | |
| Cancel a drag | Esc | |
| Appearance panel (floating, draggable, closes with `×`, Esc or the button) | `Appearance` in the header | |
| What the panel changes | `Whole tab` (every pane in this tab) or `Focused pane` (only that pane; `Follow tab` undoes it) | |
| Background | `Desktop` (your wallpaper, fetched automatically, no hiding needed), `Image` (a file), `Capture` (a screenshot of your screen taken after a 5 s countdown), `Solid` (one colour) or `Blend` (three colours) | Alt+Shift+G flips plain and picture look |
| Opacity and blur | one slider each | |
| Tab bar position | `Tabs` in the panel: `Top`, `Left` or `Right` | |
| Collapse a side tab bar | `«`/`»` button on the bar, or `Collapse` in the panel (shows initials only) | |
| Dock-style magnify | move the pointer along the tab bar | |
| Files view for a pane | `▤` in the pane header (`>_` to return); every pane chooses for itself, the shell keeps running underneath | Alt+Shift+F |
| Browse | folders expand with `▸` (or →/←), double-click or Enter opens a folder, `↑`/Backspace goes up, `⌂` returns to the terminal's folder, the path box takes any path (`~` works) | |
| Sort | click Name, Date Modified, Size or Kind; click again to reverse (folders stay on top) | |
| Search | box under the path (searches as you type after a short pause; `Live` turns that off and then Enter or `Search` runs it; emptying the box shows all files again): `Names` (`*` and `?` work) or `Text` (grep); `Subfolders` for recursive; `Aa` match case; `.*` regex; `Only files: *.js, *.md` filter; `Hidden` includes dot folders and node_modules | Cmd/Ctrl+F |
| Search results | text hits are grouped per file like Notepad++ ("Line 12: ..." with the match highlighted, Collapse/Expand all); click a hit to see the file at that line beside the list | |
| Open a file | double-click it (or Enter): it opens beside the list in a viewer | |
| Viewer | `Formatted` (syntax colours for JavaScript, Python, YAML, JSON, shell, HTML/XML, CSS, Go, Rust, C/C++, Java, SQL and more; Markdown rendered) or `Plain` (exactly the text); `Lines` and `Wrap` toggles; `Find in file` with ▲▼, `Aa` and a match counter; `↻` re-reads the file. Read-only. | Ctrl/Cmd+F finds in the file |
| Detach a file | `⧉` in the viewer: its own window you can drag, resize and keep open while you browse other folders, tabs or panes | |
| Minimize a window | `–` sends it to a tray at the bottom of Brick; click its chip to bring it back where it was, `×` on the chip closes it | |
| `cd here` | runs `cd` in the pane's shell for the folder you are looking at and switches back | |
| Peek at a tab | rest the pointer on another tab for about a second; click the preview to open it, Esc or move away to dismiss | |

Shortcuts use Alt+Shift so zsh's own Alt bindings (Alt+d, Alt+t...) keep working. Full-screen programs
(`vim`, `less`) cover only their own pane.

## How it works

| Piece | Brick |
|---|---|
| Shell to terminal channel | hex-encoded JSON in a DCS: `ESC P $ d <hex> ESC \` |
| Command start | zsh `preexec` sends `Preexec {command, cwd}` |
| Command end + status | zsh `precmd` reads `$?` first, sends `CommandFinished {exit_code, next_block_id}` |
| Block id | shell-generated counter `precmd-<session>-<n>` |
| Splitting output into blocks | `public/splitter.js` strips hooks from the byte stream, then routes bytes to the active block's own xterm instance |
| Duration | measured in the browser between `Preexec` and `CommandFinished` |
| Shell startup | login `zsh -l` with a temp `ZDOTDIR` of proxy dotfiles that source your real ones, then `shell/brick.zsh` |
| Full-screen apps | block switches to alternate screen -> becomes a full-window overlay, pty resized |

Not included: a custom prompt/editor (zsh's own line editor runs in a small input terminal), OSC 133 prompt marks, bash/fish.

## Try an animation
`python3 examples/analog-clock.py` draws an analogue clock with Braille dots on the alternate screen (Ctrl-C quits;
`--seconds N` stops after N seconds). In Brick it opens as a full-pane overlay and the block shows its run time.

## Files
- `fsapi.js`  list/read/search for the Files view (`/fs/*`, same token, Host and Origin checks as the shell).
- `server.js`  HTTP + WebSocket + pty, one shell per connection. Loopback only, random token, Host and Origin checks.
- `shell/brick.zsh`  the hooks.
- `public/`  `splitter.js` (shared with tests), `files.js` (the Files view), `docview.js` (file viewer and its floating windows), `app.js` (`Session` = one pane/shell with its blocks; tab/split layout), `index.html`, `style.css`.
- `test/`  `protocol.test.js`, `ui.test.js`, `layout.test.js`. `docs/` screenshots from the UI test.

## Security
A web page connected to a shell is remote code execution. The server binds to 127.0.0.1,
requires a random per-run token (in the URL), rejects other `Host`/`Origin` values, and is
single-purpose. Do not expose it on a network interface or behind a proxy.

## Brick-only shell config (e.g. oh-my-zsh)
If `~/.brick/zshrc` exists, Brick sources it after your normal `~/.zshrc` and before its own hooks
(override the path with `BRICK_ZSHRC`). Nothing else reads this file, so plugins such as oh-my-zsh,
autosuggestions and syntax highlighting can be enabled for Brick only.
