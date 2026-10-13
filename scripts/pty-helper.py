#!/usr/bin/env python3
"""Runs a command under a pseudo-terminal for the mock agent.

Node has no pseudo-terminal of its own and the usual npm module needs a compiler, so the mock agent
starts this helper instead and talks to it over pipes:

    stdin   bytes to type into the terminal
    stdout  bytes the terminal printed
    fd 3    one line per resize: "<cols> <rows>\n"

Usage: pty-helper.py <cols> <rows> <command> [args...]
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

CONTROL_FD = 3


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]


def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    command = sys.argv[3:]

    pid, master = pty.fork()
    if pid == 0:
        # The size is set before the program starts, so it never sees the 0 x 0 default.
        set_size(0, cols, rows)
        os.close(CONTROL_FD)
        os.execvp(command[0], command)

    pending = b""
    try:
        while True:
            ready, _, _ = select.select([master, 0, CONTROL_FD], [], [])
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    break
                write_all(1, data)
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:
                    break
                write_all(master, data)
            if CONTROL_FD in ready:
                data = os.read(CONTROL_FD, 4096)
                if not data:
                    break
                pending += data
                *lines, pending = pending.split(b"\n")
                for line in lines:
                    try:
                        new_cols, new_rows = (int(part) for part in line.split())
                        set_size(master, new_cols, new_rows)
                    except ValueError:
                        pass
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    finally:
        # Whatever ended the loop, the shell must not outlive the mock agent.
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        try:
            os.close(master)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    main()
