#!/usr/bin/env python3
"""Minimal PTY bridge using Python 3 stdlib only.

Usage: pty-bridge.py <cwd> -- <cmd...>
Runs <cmd...> inside a 160x50 PTY, proxies PTY output raw to stdout and
stdin raw to the PTY, kills the child process group on SIGTERM, and exits
with the child's exit code.
"""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def parse_args(argv: list[str]) -> tuple[str, list[str]]:
    if len(argv) < 4 or argv[2] != "--":
        sys.stderr.write("Usage: pty-bridge.py <cwd> -- <cmd...>\n")
        sys.exit(2)
    return argv[1], argv[3:]


def set_winsize(fd: int, rows: int, cols: int) -> None:
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    total = 0
    while total < len(view):
        try:
            written = os.write(fd, view[total:])
            if written <= 0:
                break
            total += written
        except OSError as exc:
            if exc.errno == errno.EINTR:
                continue
            break


def main() -> int:
    cwd, cmd = parse_args(sys.argv)

    master_fd, slave_fd = pty.openpty()
    try:
        set_winsize(slave_fd, 50, 160)
    except OSError:
        pass

    pid = os.fork()
    if pid == 0:
        # Child process
        os.close(master_fd)
        try:
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        except OSError:
            pass

        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)

        try:
            os.chdir(cwd)
        except OSError as exc:
            sys.stderr.write(f"pty-bridge: chdir failed: {exc}\n")
            os._exit(126)

        try:
            os.execvp(cmd[0], cmd)
        except OSError as exc:
            sys.stderr.write(f"pty-bridge: exec failed: {exc}\n")
            os._exit(127)

    # Parent process
    os.close(slave_fd)

    terminated = False

    def handle_signal(signum: int, _frame: object) -> None:
        nonlocal terminated
        terminated = True
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except OSError:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stdin_open = True

    try:
        while True:
            read_fds = [master_fd]
            if stdin_open:
                read_fds.append(stdin_fd)

            try:
                rlist, _, _ = select.select(read_fds, [], [], 0.25)
            except InterruptedError:
                if terminated:
                    break
                continue
            except OSError:
                break

            if master_fd in rlist:
                try:
                    chunk = os.read(master_fd, 4096)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    if exc.errno == errno.EINTR:
                        continue
                    break
                if not chunk:
                    break
                write_all(stdout_fd, chunk)

            if stdin_open and stdin_fd in rlist:
                try:
                    data = os.read(stdin_fd, 4096)
                except OSError as exc:
                    if exc.errno == errno.EINTR:
                        continue
                    stdin_open = False
                    data = b""
                if not data:
                    stdin_open = False
                else:
                    try:
                        write_all(master_fd, data)
                    except OSError:
                        break
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

    if terminated:
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            pass

    while True:
        try:
            _, status = os.waitpid(pid, 0)
            break
        except InterruptedError:
            continue
        except ChildProcessError:
            return 0

    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


if __name__ == "__main__":
    sys.exit(main())
