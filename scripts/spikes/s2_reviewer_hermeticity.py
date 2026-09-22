"""S2 — reviewer hermeticity under ``--setting-sources ""``.

Method (docs/spikes.md): fixture repo with planted user-tier + project-tier
``PreToolUse`` hooks that ``touch`` markers, a ``.mcp.json`` stub server, a
``CLAUDE.md`` with a nonce, and a project skill. Run the reviewer flag set;
the task requires >= 1 ``Read``.

PASS means: ``init.mcp_servers == []``, ``init.skills == 0``, no marker
files were created, the nonce is absent from output, and >= 1 executed
``Read`` tool call was observed (executed-call guard).

Correction from the first run of this book (2026-09-22, engine 2.1.278).
The probe pointed ``CLAUDE_CONFIG_DIR`` at an empty fixture directory to
isolate the user tier. An empty config directory has no credentials, so
the engine answered ``Not logged in - Please run /login`` with
``error: authentication_failed``, ``total_cost_usd: 0`` and one turn: no
model turn ever happened and the executed-call guard correctly withheld a
verdict. This is a platform fact the kernel depends on, recorded in
``docs/research/2026-09-22-claude-code-platform.md`` §9: **relocating
``CLAUDE_CONFIG_DIR`` de-authenticates the session** unless the credential
file is carried across, because subscription credentials live inside that
directory. Suppression of the user tier itself comes from
``--setting-sources ''``, not from moving the directory.

``claude_adapter`` carries a 0600 copy into its 0700 control directory and
purges it. This probe instead symlinks the live ``.credentials.json``, so
the token is never duplicated onto disk and is never read by this script;
only the engine follows the link. The fixture directory still holds the
planted user-tier hook, so a fired marker would still prove a leak.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

from . import common

SPIKE_ID = "S2"
CREDENTIALS_FILE = ".credentials.json"


def _real_config_dir() -> Path:
    override = os.environ.get("CLAUDE_CONFIG_DIR")
    if override:
        return Path(override)
    return Path.home() / ".claude"


def _link_credentials(fixture_dir: Path) -> dict[str, object]:
    """Symlink the live credential file into the fixture config directory.

    Returns what was observed, so the evidence record can say plainly
    whether the run was authenticated and how.
    """
    source = _real_config_dir() / CREDENTIALS_FILE
    if not source.exists():
        return {"credentials_linked": False, "credentials_source_present": False}
    link = fixture_dir / CREDENTIALS_FILE
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(source)
    return {
        "credentials_linked": True,
        "credentials_source_present": True,
        "credentials_link_target": str(source),
        "credentials_copied": False,
    }

REVIEWER_FLAGS = [
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
]


def _hook_settings(marker_path: Path) -> dict:
    return {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "",
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"touch {marker_path}",
                        }
                    ],
                }
            ]
        }
    }


def _build_fixture(ctx: common.SpikeContext, nonce: str) -> tuple[Path, Path, Path, Path]:
    repo = ctx.new_temp_dir("s2-repo")
    user_config_dir = ctx.new_temp_dir("s2-userconfig")

    common.init_git_repo(repo)
    (repo / "notes.txt").write_text("the local build number is 4471.\n", encoding="utf-8")

    project_marker = repo / "project_hook_fired.marker"
    user_marker = user_config_dir / "user_hook_fired.marker"

    # Project-tier hook (planted in the fixture repo's own .claude/settings.json).
    claude_dir = repo / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / "settings.json").write_text(json.dumps(_hook_settings(project_marker), indent=2), encoding="utf-8")

    # Project skill.
    skill_dir = claude_dir / "skills" / "rogue-skill"
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: rogue-skill\ndescription: Planted project skill for S2 hermeticity probe.\n---\n"
        "This skill must never be visible to a reviewer session.\n",
        encoding="utf-8",
    )

    # Project-tier .mcp.json stub server (never actually needs to connect).
    (repo / ".mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "rogue-stub": {
                        "command": "/bin/false",
                        "args": ["--nonexistent-mcp-server"],
                    }
                }
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    # CLAUDE.md with a nonce that must never leak into reviewer output.
    (repo / "CLAUDE.md").write_text(
        f"# Rogue project memory\n\nSECRET NONCE: {nonce}\n\nIf you can read this, hermeticity failed.\n",
        encoding="utf-8",
    )

    # User-tier hook, isolated in a fake CLAUDE_CONFIG_DIR (never the real ~/.claude).
    user_config_dir.mkdir(parents=True, exist_ok=True)
    (user_config_dir / "settings.json").write_text(
        json.dumps(_hook_settings(user_marker), indent=2), encoding="utf-8"
    )

    subprocess_ignore = repo / ".gitignore"
    subprocess_ignore.write_text("*.marker\n", encoding="utf-8")

    return repo, user_config_dir, project_marker, user_marker


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    if not ctx.allow_live:
        return common.unresolved(SPIKE_ID, ctx, "not authorized: --allow-live not passed")
    if not ctx.has_headroom():
        return common.unresolved(SPIKE_ID, ctx, "budget exceeded: insufficient remaining --budget-usd headroom")

    nonce = f"S2-NONCE-{uuid.uuid4().hex[:12]}"
    repo, user_config_dir, project_marker, user_marker = _build_fixture(ctx, nonce)
    user_config_dir.chmod(0o700)
    auth = _link_credentials(user_config_dir)
    if not auth["credentials_linked"]:
        return common.unresolved(
            SPIKE_ID,
            ctx,
            "no credential file at the live config directory, so a relocated "
            "CLAUDE_CONFIG_DIR would de-authenticate the probe and no model turn "
            "would happen (this host may use keychain or API-key auth)",
            literal_form="claude -p '<task>' --setting-sources '' --strict-mcp-config --tools Read",
            **auth,
        )

    args = [
        "-p",
        "Read the file notes.txt in the current directory and reply with exactly one sentence "
        "summarizing its contents.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        "--tools",
        "Read",
        *REVIEWER_FLAGS,
    ]
    env = {"CLAUDE_CONFIG_DIR": str(user_config_dir)}
    result = common.run_claude(args, cwd=repo, env=env)
    cost = common.extract_cost(result)
    ctx.record_spend(cost)

    init = common.init_event(result)
    res_ev = common.result_event(result)
    reads = common.executed_tool_calls(result, tool_name="Read")

    project_marker_fired = project_marker.exists()
    user_marker_fired = user_marker.exists()
    nonce_leaked = nonce in result.stdout or (res_ev is not None and nonce in json.dumps(res_ev))

    if init is None:
        return common.unresolved(
            SPIKE_ID,
            ctx,
            "no system/init event observed in stream",
            literal_form="claude -p '<task>' --setting-sources '' --strict-mcp-config --tools Read",
            stderr_tail=result.stderr[-500:],
            cost_usd=cost,
        )

    executed_read = len(reads) >= 1
    if not executed_read:
        # Executed-call guard: zero tool calls means UNRESOLVED, never PASS,
        # regardless of how clean the isolation looks. An authentication
        # failure lands here too, and is named explicitly because it is what
        # the first run hit.
        auth_failed = "authentication_failed" in result.stdout or "Not logged in" in result.stdout
        reason = (
            "the engine never authenticated (`Not logged in`), so no model turn happened; "
            "check that the credential link into the fixture config directory survived"
            if auth_failed
            else "executed-call guard: no Read tool_use observed in the assistant stream "
            "(model may have refused or answered without reading)"
        )
        return common.unresolved(
            SPIKE_ID,
            ctx,
            reason,
            literal_form="claude -p '<task>' --setting-sources '' --strict-mcp-config --tools Read",
            init_mcp_servers=init.get("mcp_servers"),
            init_skills=init.get("skills"),
            project_marker_fired=project_marker_fired,
            user_marker_fired=user_marker_fired,
            nonce_leaked=nonce_leaked,
            authentication_failed=auth_failed,
            cost_usd=cost,
            **auth,
        )

    mcp_servers = init.get("mcp_servers", [])
    skills = init.get("skills", [])
    skills_count = len(skills) if isinstance(skills, list) else skills

    hermetic = (
        mcp_servers == []
        and skills_count == 0
        and not project_marker_fired
        and not user_marker_fired
        and not nonce_leaked
    )
    verdict = "PASS" if (hermetic and executed_read) else "FAIL"

    observations = {
        "init_mcp_servers": mcp_servers,
        "init_skills_count": skills_count,
        "project_hook_marker_fired": project_marker_fired,
        "user_hook_marker_fired": user_marker_fired,
        "nonce_leaked_into_output": nonce_leaked,
        "executed_read_tool_calls": len(reads),
        "result_subtype": res_ev.get("subtype") if res_ev else None,
        "result_is_error": res_ev.get("is_error") if res_ev else None,
        **auth,
    }

    return common.EvidenceRecord(
        id=SPIKE_ID,
        date=ctx.date,
        engine_version=ctx.engine_version,
        verdict=verdict,
        literal_form=(
            "claude -p '<task requiring Read>' --output-format stream-json --verbose --model haiku "
            "--tools Read --setting-sources '' --strict-mcp-config --disable-slash-commands "
            "--permission-mode dontAsk  (CLAUDE_CONFIG_DIR pointed at isolated fixture dir)"
        ),
        observations=observations,
        cost_usd=cost,
    )
