#!/usr/bin/env python3
"""A fake ``claude`` binary that replays a recorded ``stream-json`` fixture.

It never contacts a model, never reads credentials and never spends anything.
Everything it does is driven by environment variables so a test can choose the
stream, the exit code, a startup delay and whether the process lingers:

``FAKE_CLAUDE_STREAM``  path to a ``.jsonl`` fixture; ``{{session_id}}`` in it is
                        replaced with the session id the caller asked for.
``FAKE_CLAUDE_RECORD``  path to write the observed argv and stdin to, so a test
                        can prove the role prompt and packet stayed off argv.
``FAKE_CLAUDE_EXIT``    exit code (default 0).
``FAKE_CLAUDE_DELAY``   seconds to sleep before emitting anything.
``FAKE_CLAUDE_HOLD``    seconds to linger after the stream, to be cancelled.
``FAKE_CLAUDE_VERSION`` what ``--version`` prints (default ``2.1.278 (Claude Code)``).
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

SESSION_PLACEHOLDER = "{{session_id}}"


def _requested_session(argv: list[str]) -> str:
    return argv[argv.index("--session-id") + 1] if "--session-id" in argv else ""


def _record(argv: list[str], packet: str) -> None:
    target = os.environ.get("FAKE_CLAUDE_RECORD")
    if not target:
        return
    Path(target).write_text(
        json.dumps({"argv": argv, "stdin": packet}, ensure_ascii=False), encoding="utf-8"
    )


def _replay(session_id: str) -> None:
    stream = os.environ.get("FAKE_CLAUDE_STREAM")
    if not stream:
        return
    for line in Path(stream).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        sys.stdout.write(line.replace(SESSION_PLACEHOLDER, session_id) + "\n")
        sys.stdout.flush()


def main() -> int:
    argv = sys.argv[1:]
    if "--version" in argv:
        sys.stdout.write(os.environ.get("FAKE_CLAUDE_VERSION", "2.1.278 (Claude Code)") + "\n")
        return 0
    packet = sys.stdin.read()
    _record(argv, packet)
    delay = float(os.environ.get("FAKE_CLAUDE_DELAY", "0"))
    if delay:
        time.sleep(delay)
    _replay(_requested_session(argv))
    hold = float(os.environ.get("FAKE_CLAUDE_HOLD", "0"))
    if hold:
        time.sleep(hold)
    return int(os.environ.get("FAKE_CLAUDE_EXIT", "0"))


if __name__ == "__main__":
    raise SystemExit(main())
