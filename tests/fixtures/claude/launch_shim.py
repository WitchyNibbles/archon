#!/usr/bin/env python3
"""The contracted ``archon-launch`` argv, wired to the real supervisor primitive.

``archon-launch <control_dir> <nonce> check|review -- <argv...>`` is the launcher
entry point the adapter builds.  Tests drive that exact shape through this shim
so every test exercises real subreaper supervision, real PID handles and real
termination receipts while ``launcher.main()`` itself is owned by another change.
It also forwards the ``bwrap`` status pipe exactly as ``main()`` does, so the
confinement-fault discriminator is exercised rather than stubbed.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "src"))

from archon.launcher import status_fds, supervise  # noqa: E402

KINDS = ("check", "review")


def main() -> int:
    arguments = sys.argv[1:]
    if len(arguments) < 5 or arguments[3] != "--" or arguments[2] not in KINDS:
        raise SystemExit("usage: launch_shim <control_dir> <nonce> check|review -- <argv...>")
    return supervise(arguments[4:], Path(arguments[0]), arguments[1], status_fds(os.environ))


if __name__ == "__main__":
    raise SystemExit(main())
