#!/usr/bin/env python3
"""Run an interactive password command under a PTY without logging its TEST secret."""

import os
import pty
import select
import sys
import time


def main():
    secret = os.environ.get("TEST_TTY_SECRET", "")
    command = sys.argv[1:]
    if not secret or not command:
        raise SystemExit("TEST_TTY_SECRET and a command are required")

    pid, master = pty.fork()
    if pid == 0:
        os.execvp(command[0], command)

    transcript = bytearray()
    sent_new = False
    sent_confirm = False
    secret_bytes = secret.encode()
    while True:
        ready, _, _ = select.select([master], [], [], 30)
        if not ready:
            os.kill(pid, 15)
            raise SystemExit("Timed out waiting for password prompt")
        try:
            chunk = os.read(master, 4096)
        except OSError:
            chunk = b""
        if chunk:
            transcript.extend(chunk)
            visible = bytes(transcript)
            if not sent_new and b"New administrator password:" in visible:
                time.sleep(0.1)
                os.write(master, secret_bytes + b"\n")
                sent_new = True
            elif sent_new and not sent_confirm and b"Confirm new password:" in visible:
                time.sleep(0.1)
                os.write(master, secret_bytes + b"\n")
                sent_confirm = True
            if len(transcript) > 1_000_000:
                os.kill(pid, 15)
                raise SystemExit("Interactive command output exceeded safety limit")
            continue
        break

    _, status = os.waitpid(pid, 0)
    safe_output = bytes(transcript).replace(secret_bytes, b"[REDACTED]")
    sys.stdout.buffer.write(safe_output)
    if os.waitstatus_to_exitcode(status) != 0:
        raise SystemExit(os.waitstatus_to_exitcode(status))
    if not sent_new or not sent_confirm:
        raise SystemExit("Password prompts were not both observed")


if __name__ == "__main__":
    main()
