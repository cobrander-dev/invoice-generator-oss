#!/usr/bin/env python3
"""Drive an interactive command under a PTY, answering prompts in order.

usage: drive-tty.py SCRIPT.json -- COMMAND...
SCRIPT.json is a list of [prompt_substring, answer] pairs; an answer of the form
"env:NAME" is read from the environment and masked in the printed transcript.
Exits with the command's exit status.
"""

import json
import os
import pty
import select
import sys


def main():
    separator = sys.argv.index("--")
    with open(sys.argv[1], encoding="utf-8") as handle:
        steps = json.load(handle)
    command = sys.argv[separator + 1 :]
    secrets = []
    answers = []
    for prompt, answer in steps:
        if answer.startswith("env:"):
            answer = os.environ[answer[4:]]
            secrets.append(answer)
        answers.append((prompt.encode(), answer.encode()))

    pid, master = pty.fork()
    if pid == 0:
        os.execvp(command[0], command)

    transcript = bytearray()
    searched_from = 0
    while True:
        ready, _, _ = select.select([master], [], [], 600)
        if not ready:
            os.kill(pid, 15)
            raise SystemExit("timed out waiting for output")
        try:
            chunk = os.read(master, 4096)
        except OSError:
            chunk = b""
        if not chunk:
            break
        transcript.extend(chunk)
        if answers:
            prompt, answer = answers[0]
            position = transcript.find(prompt, searched_from)
            if position >= 0:
                os.write(master, answer + b"\n")
                searched_from = position + len(prompt)
                answers.pop(0)

    _, status = os.waitpid(pid, 0)
    text = transcript.decode("utf-8", "replace")
    for secret in secrets:
        text = text.replace(secret, "[MASKED]")
    sys.stdout.write(text)
    if answers:
        sys.stdout.write(f"\nunanswered prompt: {answers[0][0].decode()}\n")
        raise SystemExit(1)
    raise SystemExit(os.waitstatus_to_exitcode(status))


if __name__ == "__main__":
    main()
