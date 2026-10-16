# Brick verification

Run: `npm test` (Node 22.19, macOS, zsh 5.9, Chrome headless). 71 tests, all passing at time of writing (10 protocol, 11 UI, 13 splits, 9 drag and drop, 15 appearance, 4 capture endpoint, 9 tab bar).

| Scenario | Protocol test (real zsh, no browser) | UI test (headless Chrome) |
|---|---|---|
| Simple command | hooks in order, command text, exit 0, `precmd-1-n` id | block with command, output, ✓, duration |
| Multiline output | 3 lines inside one Preexec..CommandFinished span | one block, exactly 3 rows |
| Failed command | `false`=1, `sh -c "exit 7"`=7, unknown command=127 | red block, `✗ 3`, stderr shown |
| Long-running | measured 1100-3000 ms for `sleep 1.2` | running state visible, then 1.4-4 s final duration |
| Interactive stdin | `read` receives typed text; `cat` ends on Ctrl-D; Ctrl-C gives 130 | typed text reaches the running block, not the prompt; Ctrl-C gives `✗ 130` |
| Full-screen programs | `?1049h/l` visible in stream | overlay appears for `printf` alt-screen and for real `less`, keys work, `q` restores |
| Odd command text | quotes, backslash, unicode survive the JSON/hex hook | |
| Security | wrong/missing token, bad Origin, no-token page all rejected | |

Bugs found by testing (and fixed): quick commands showed blank output (shrinking a block
scrolled its text into scrollback); the first version collapsed tall blocks once many existed
(flex shrink, found by an ad hoc probe, now a regression test); node-pty's prebuilt
`spawn-helper` lacks the exec bit (fixed by a `postinstall` chmod).

## Tabs and splits (layout.test.js)
New tab (independent shell, own session id and cwd, tab title follows cwd, switching back keeps blocks);
closing tabs (last tab is replaced by a fresh one); split right and down (equal halves, narrower pty,
independent output, keystrokes go to the focused pane while another pane runs); full-screen programs confined to their
pane; divider drag resizes panes and the shell's pty width; closing a pane returns its space; `exit` closes only
that pane, and in the last pane starts a fresh session; keyboard shortcuts work and no shortcut bytes reach zsh.

Another bug found this way (fixed, regression test added): `reset()` on the input terminal ran immediately, while
the shell's echo of the typed command was still queued, so the command text sometimes reappeared above the new
prompt. Resetting through the write queue (`ESC c`) fixed it. This bug existed before tabs and splits.

## Limitations (known, not fixed)
- Tabs/splits: no zoom/maximize-pane, dragging a whole tab into another tab is not supported (drag its panes), layout and blocks are not
  restored after a page reload (reload starts new shells). Shortcut keys were checked only with Playwright's synthetic
  key events, not a physical macOS keyboard.
- Resizing a pane or the window re-fits the prompt and new blocks; existing blocks keep their old width and get a
  horizontal scrollbar when the pane becomes narrower.
- Each pane is one WebSocket and one zsh; many panes means many shells (no limit enforced).
- zsh only. No bash/fish. Needs a normal `zsh -l`; prompt frameworks that rewrite
  `precmd_functions` after ours are fine. oh-my-zsh and powerlevel10k work (instant prompt must be off).
- Input is zsh's own editor inside a 6-row terminal; no custom editor, no completions UI.
- Hooks are sent only around commands zsh runs through `preexec`/`precmd`. Not tested: output from background
  jobs that print between commands (it would land in the input terminal), Ctrl-C at an empty prompt, and
  commands that `exec` over the shell (the shell ends, so no `CommandFinished`).
- Blocks hold at most 2000 visible rows plus 5000 lines of scrollback; `seq 1 200000` keeps only the tail.
- Block width is fixed at creation; after resizing the window old blocks keep their old width.
- Interactive programs are only detected if they use the alternate screen. Curses-less REPLs work as normal
  block I/O; programs that need the real window size before entering the alternate screen see a 6-row pty
  until the overlay resizes it (apps handle SIGWINCH, but a few redraw late).
- Blocks on screen are not saved: a reload or server restart starts with an empty pane (zsh history, i.e. the up-arrow, is saved).
- Pty size is global: while a block runs, `stty size` reports the input terminal's rows (6).
- Two browser windows on the same URL are two independent sets of tabs (not shared). No persistence across reloads.
- Duration is measured in the browser, so it includes WebSocket latency. Not tested with a backgrounded tab.
- ConPTY/Windows, SSH and subshells: out of scope.

## Appearance
- One floating Appearance panel (no permanent controls in the header; draggable by its title, closes with `×`, Esc or the header button). It edits either the whole tab or the focused pane (`Follow tab` hands a pane back). Each tab has its own look; new tabs start with the look last chosen for a tab (saved in the browser). A pane's own look is not saved across reloads (panes are new shells then).
- Backgrounds: `Desktop`, `Image`, `Capture`, `Solid` (colour), `Blend` (three colours). One opacity slider (15-100%) and one blur slider. Each pane is painted as a background layer (blurred, fixed to the window so neighbouring panes show one picture) under a tint at the chosen opacity; opacity over a picture lets it show through, and choosing a picture while opaque drops opacity to 60%. Blur does nothing for `Solid`, so it is disabled there.
- A browser page cannot see through to the desktop live, so everything is a still picture. `Desktop` is the wallpaper only, fetched by a small ScreenCaptureKit helper (`tools/wallpaper.swift`, compiled once into `~/.brick/bin` with `swiftc`, needs the Xcode command line tools) that captures only the layers below app windows, so nothing has to be hidden. It is refreshed each time Brick starts, so it follows wallpaper changes. `Capture` is `screencapture` of everything visible, only on a button press, after a 5 s countdown; Brick itself will be in the picture unless you hide it.
- Both need Screen Recording permission for the app running the server (restart it after allowing). Privacy: `POST /capture?kind=wallpaper|screen` needs the session token and a same-origin request (checked, with tests; unknown kinds get 400); the image is returned in the response and the server never keeps it (temp file deleted). The page keeps the three pictures in the browser's IndexedDB so they survive reloads.
- Tested by computed styles and layer variables, a check that no terminal element paints an opaque background, the capture endpoint's access rules, and a real run of the wallpaper helper (valid JPEG without any windows in it; checked on this Mac only). The browser flow uses an injected stand-in image so tests never photograph the real screen.

## Tab bar
- Top, left or right (`Tabs` in the panel); a side bar collapses to a rail of initials; position and collapse are remembered. Terminals refit when the bar moves. Reordering and "drop a pane on empty bar space" work along either axis.
- Dock-style magnify: tabs grow with a cosine falloff by distance from the pointer (up to 1.25x on top, 1.12x in a side bar, 1.5x collapsed) and reset when the pointer leaves or a drag starts.
- Peek: resting on an inactive tab for about 1.2 s (250 ms when moving to the next tab while one is open) shows a scaled copy of that tab next to the bar, refreshed every second, scrolled to the latest output. It is a snapshot copy of the DOM, not a second live terminal, and is inert; click it to open the tab, Esc or moving away dismisses it. Not shown for the active tab or during a drag.
