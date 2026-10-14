#!/usr/bin/env python3
"""A full-screen program that takes the mouse, for trying taps in the mock agent's real shell.

It turns mouse tracking on, draws a grid with numbered columns and rows and a list of "agents" to
open and close, and says where every press and release landed. q quits.

Usage: mouse-test [--legacy | --x10]
    (default)  mode 1000 with SGR reports (1006), as Claude Code asks for
    --legacy   mode 1000 with the old CSI M reports
    --x10      mode 9: presses only, old reports
"""

import os
import re
import select
import sys
import termios
import tty

ESC = "\x1b"
SGR = re.compile(rb"\x1b\[<(\d+);(\d+);(\d+)([Mm])")
AGENTS = [
    ("Explore", "Searching the code for path detection", "Read 14 files, found 3 matches"),
    ("Plan", "Drafting the steps for merging", "Wrote a plan of 6 steps"),
    ("Review", "Checking the diff of the key bar", "No problems found"),
]


def write(text):
    os.write(sys.stdout.fileno(), text.encode())


def size():
    try:
        columns, rows = os.get_terminal_size(sys.stdout.fileno())
    except OSError:
        columns, rows = 80, 24
    return columns, rows


class Screen:
    def __init__(self, mode):
        self.mode = mode
        self.marks = set()
        self.opened = set()
        self.log = []

    def agent_rows(self):
        """The row of each agent's line, counting from 1, below the grid."""
        rows = []
        row = 9
        for index in range(len(AGENTS)):
            rows.append(row)
            row += 2 if index in self.opened else 1
        return rows

    def draw(self):
        columns, rows = size()
        out = [f"{ESC}[H{ESC}[2J"]
        out.append(f"{ESC}[1mmouse-test{ESC}[0m  mode: {self.mode}  {columns}x{rows}  q quits\r\n")
        tens = "".join(str((c // 10) % 10) if c % 10 == 0 else " " for c in range(1, columns + 1))
        ones = "".join(str(c % 10) for c in range(1, columns + 1))
        out.append(f"{ESC}[2m{tens}\r\n{ones}{ESC}[0m\r\n")
        for row in range(4, 8):
            line = ""
            for column in range(1, columns + 1):
                line += f"{ESC}[7mX{ESC}[0m" if (column, row) in self.marks else "."
            out.append(line + "\r\n")
        out.append("\r\n")
        for index, (name, doing, done) in enumerate(AGENTS):
            arrow = "▾" if index in self.opened else "▸"
            out.append(f"  {arrow} {ESC}[36m{name}{ESC}[0m agent  {doing}\r\n")
            if index in self.opened:
                out.append(f"      {ESC}[2m⎿  {done}{ESC}[0m\r\n")
        out.append("\r\n")
        for entry in self.log[-max(1, rows - 16):]:
            out.append(entry + "\r\n")
        write("".join(out))

    def click(self, button, column, row, pressed):
        kind = "press" if pressed else "release"
        self.log.append(f"{kind} of button {button} at column {column}, row {row}")
        if not pressed or button != 0:
            return
        if 4 <= row <= 7:
            self.marks ^= {(column, row)}
        for index, agent_row in enumerate(self.agent_rows()):
            if row == agent_row:
                self.opened ^= {index}
                self.log.append(f"toggled the {AGENTS[index][0]} agent")


def main():
    mode = "sgr"
    if "--legacy" in sys.argv:
        mode = "legacy"
    elif "--x10" in sys.argv:
        mode = "x10"
    on = {"sgr": "?1000h\x1b[?1006h", "legacy": "?1000h", "x10": "?9h"}[mode]
    off = {"sgr": "?1006l\x1b[?1000l", "legacy": "?1000l", "x10": "?9l"}[mode]
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    screen = Screen(mode)
    write(f"{ESC}[?1049h{ESC}[?25l{ESC}[{on}")
    try:
        tty.setraw(fd)
        screen.draw()
        pending = b""
        drawn_at = size()
        while True:
            ready, _, _ = select.select([fd], [], [], 0.3)
            if not ready:
                if size() != drawn_at:
                    drawn_at = size()
                    screen.draw()
                continue
            pending += os.read(fd, 1024)
            while pending:
                if pending.startswith(b"q") or pending.startswith(b"\x03"):
                    return
                match = SGR.match(pending)
                if match:
                    code = int(match.group(1))
                    screen.click(code & 3 if code < 64 else code, int(match.group(2)),
                                 int(match.group(3)), match.group(4) == b"M")
                    pending = pending[match.end():]
                    continue
                if pending.startswith(b"\x1b[M") and len(pending) >= 6:
                    code, column, row = pending[3] - 32, pending[4] - 32, pending[5] - 32
                    released = code & 3 == 3
                    screen.click(0 if released else code & 3, column, row, not released)
                    pending = pending[6:]
                    continue
                if pending.startswith(b"\x1b[<") and not re.search(rb"[Mm]", pending):
                    break
                if pending.startswith(b"\x1b[M") and len(pending) < 6:
                    break
                if pending in (b"\x1b", b"\x1b["):
                    break
                pending = pending[1:]
            screen.draw()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        write(f"{ESC}[{off}{ESC}[?25h{ESC}[?1049l")


if __name__ == "__main__":
    main()
