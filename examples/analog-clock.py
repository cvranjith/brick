#!/usr/bin/env python3
"""Analogue clock for any terminal. Braille dots (2x4 per cell) give smooth hands.
Runs on the alternate screen; Ctrl-C quits. `--seconds N` quits after N seconds."""
import math, shutil, signal, sys, time

BRAILLE = ((0x01, 0x08), (0x02, 0x10), (0x04, 0x20), (0x40, 0x80))  # [dot row][dot col] -> bit
DIM, WHITE, RED, GREEN = 90, 97, 91, 92

def line(x0, y0, x1, y1):
    n = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
    for i in range(n + 1):
        t = i / max(n, 1)
        yield round(x0 + (x1 - x0) * t), round(y0 + (y1 - y0) * t)

def frame(cols, rows, now):
    W, H = cols * 2, (rows - 2) * 4            # dot grid; keep two text rows for the caption
    cx, cy, r = W / 2, H / 2, min(W / 2, H / 2) - 3
    cells = {}                                  # (cell_x, cell_y) -> [bits, colour]
    def dot(x, y, colour):
        if 0 <= x < W and 0 <= y < H:
            c = cells.setdefault((x // 2, y // 4), [0, colour])
            c[0] |= BRAILLE[y % 4][x % 2]
            c[1] = colour                       # later layers win the cell's colour
    for a in range(720):                        # face
        t = a * math.pi / 360
        dot(round(cx + r * math.cos(t)), round(cy + r * math.sin(t)), DIM)
    for h in range(12):                         # hour ticks (longer at 12/3/6/9)
        t = h * math.pi / 6
        inner = r * (0.82 if h % 3 == 0 else 0.9)
        for x, y in line(cx + inner * math.sin(t), cy - inner * math.cos(t), cx + (r - 4) * math.sin(t), cy - (r - 4) * math.cos(t)):   # stop short of the rim so the face keeps its colour
            dot(x, y, WHITE)
    lt = time.localtime(now)
    sec = lt.tm_sec + (now % 1)
    minute = lt.tm_min + sec / 60
    hour = lt.tm_hour % 12 + minute / 60
    def hand(angle, length, colour, thick=False):
        t = angle * 2 * math.pi
        for x, y in line(cx, cy, cx + length * r * math.sin(t), cy - length * r * math.cos(t)):
            dot(x, y, colour)
            if thick:
                dot(x + 1, y, colour); dot(x, y + 1, colour)
    hand(hour / 12, 0.5, WHITE, True)
    hand(minute / 60, 0.78, WHITE, True)
    hand(sec / 60, 0.88, RED)
    dot(round(cx), round(cy), RED)
    out = []
    for cy_ in range(rows - 2):
        row = []
        for cx_ in range(cols):
            c = cells.get((cx_, cy_))
            row.append(f"\x1b[{c[1]}m{chr(0x2800 + c[0])}" if c else " ")
        out.append("".join(row) + "\x1b[0m")
    caption = time.strftime("%H:%M:%S  %a %d %b", lt)
    out.append("")
    out.append(f"\x1b[1;{GREEN}m{caption.center(cols)}\x1b[0m")
    return "\x1b[H" + "\x1b[K\n".join(out) + "\x1b[K"

def main():
    limit = float(sys.argv[sys.argv.index("--seconds") + 1]) if "--seconds" in sys.argv else None
    signal.signal(signal.SIGINT, signal.default_int_handler)
    sys.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J")
    start = time.time()
    try:
        while limit is None or time.time() - start < limit:
            size = shutil.get_terminal_size((80, 24))
            sys.stdout.write(frame(max(size.columns, 20), max(size.lines, 8), time.time()))
            sys.stdout.flush()
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write("\x1b[?25h\x1b[?1049l")
        sys.stdout.flush()

if __name__ == "__main__":
    main()
