# Brick

A tiny block-based terminal in the browser. Node backend (a real zsh on a pty via `node-pty`)
+ `xterm.js` frontend. A small personal project, not a product.

```
npm install
npm start          # prints http://127.0.0.1:4477/?t=<token>
npm test           # 34 tests: protocol (real zsh), UI and layout (headless Chrome)
```

Needs Node 22+, zsh, and (for the UI tests) Google Chrome.

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
- `server.js`  HTTP + WebSocket + pty, one shell per connection. Loopback only, random token, Host and Origin checks.
- `shell/brick.zsh`  the hooks.
- `public/`  `splitter.js` (shared with tests), `app.js` (`Session` = one pane/shell with its blocks; tab/split layout), `index.html`, `style.css`.
- `test/`  `protocol.test.js`, `ui.test.js`, `layout.test.js`. `docs/` screenshots from the UI test.

## Security
A web page connected to a shell is remote code execution. The server binds to 127.0.0.1,
requires a random per-run token (in the URL), rejects other `Host`/`Origin` values, and is
single-purpose. Do not expose it on a network interface or behind a proxy.

## Brick-only shell config (e.g. oh-my-zsh)
If `~/.brick/zshrc` exists, Brick sources it after your normal `~/.zshrc` and before its own hooks
(override the path with `BRICK_ZSHRC`). Nothing else reads this file, so plugins such as oh-my-zsh,
autosuggestions and syntax highlighting can be enabled for Brick only.
