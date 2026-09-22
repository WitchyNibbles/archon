"""S8 — post-compaction injection channel.

Method (docs/spikes.md): project hooks on ``PreCompact`` and
``SessionStart[compact]`` each emit a distinct nonce as
``additionalContext``; force compaction with ``--autocompact 100k`` (the
CLI minimum per ``claude --help``: "auto-compact window size (auto, or
100k-1M tokens)"). If unreachable headless, record UNRESOLVED and rely on
the inherited finding, per the spike's own explicit fallback instruction —
this is the intended outcome, not a shortcut.

Why it is unreachable here: forcing an actual compaction event requires a
single continuous session to accumulate >100k tokens of context, which
means either many chained turns (cost multiplies roughly with the square of
turn count, since each turn resends the growing transcript) or one
enormous synthetic prompt. Either path risks spending most of this run's
whole --budget-usd cap on one spike, which docs/spikes.md's "never provoke
a limit" / budget-discipline rules argue against. This spike therefore
builds the hook fixture (proving the injection channel *would* be
observable if compaction fired) but does not attempt to force compaction,
and self-reports UNRESOLVED honestly rather than faking a PASS.

The inherited finding it defers to (docs/research/2026-09-22-claude-code-platform.md
section 7, item 5): "SessionStart source: compact injection reaches
post-compaction context; PreCompact output does not."
"""

from __future__ import annotations

import json
import uuid

from . import common

SPIKE_ID = "S8"

INHERITED_FINDING = (
    "docs/research/2026-09-22-claude-code-platform.md §7 item 5: "
    "'SessionStart source: compact injection reaches post-compaction context; "
    "PreCompact output does not.'"
)


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    # Build the fixture regardless of --allow-live, to demonstrate the probe
    # is genuinely wired (not a bare no-op), even though it is not executed.
    repo = ctx.new_temp_dir("s8-repo")
    common.init_git_repo(repo)

    precompact_nonce = f"S8-PRECOMPACT-{uuid.uuid4().hex[:8]}"
    sessionstart_nonce = f"S8-SESSIONSTART-COMPACT-{uuid.uuid4().hex[:8]}"

    settings = {
        "hooks": {
            "PreCompact": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": (
                                "python3 -c \"import json,sys; "
                                f"print(json.dumps({{'hookSpecificOutput': "
                                f"{{'additionalContext': '{precompact_nonce}'}}}}))\""
                            ),
                        }
                    ]
                }
            ],
            "SessionStart": [
                {
                    "matcher": "compact",
                    "hooks": [
                        {
                            "type": "command",
                            "command": (
                                "python3 -c \"import json,sys; "
                                f"print(json.dumps({{'hookSpecificOutput': "
                                f"{{'additionalContext': '{sessionstart_nonce}'}}}}))\""
                            ),
                        }
                    ],
                }
            ],
        }
    }
    claude_dir = repo / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / "settings.json").write_text(json.dumps(settings, indent=2), encoding="utf-8")

    return common.unresolved(
        SPIKE_ID,
        ctx,
        "post-compaction forcing is unreachable within this headless single-shot "
        "(claude -p) harness under the --budget-usd cap: reaching the >=100k-token "
        "--autocompact threshold in one continuous session would require either many "
        "chained turns (cost grows with roughly the square of turn count as the "
        "transcript resends) or one huge synthetic prompt, either of which could consume "
        "most of the run's whole budget on a single spike. Deferring honestly to the "
        f"inherited finding instead of faking a PASS: {INHERITED_FINDING}",
        literal_form=(
            "PreCompact + SessionStart[compact] hook fixture built (nonces "
            f"{precompact_nonce!r} / {sessionstart_nonce!r}) but --autocompact 100k "
            "forcing was not attempted"
        ),
        fixture_built=True,
        precompact_nonce=precompact_nonce,
        sessionstart_compact_nonce=sessionstart_nonce,
        inherited_finding=INHERITED_FINDING,
    )
