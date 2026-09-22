"""S11 — plugin manifest surface and ``enabledPlugins`` format.

Method (docs/spikes.md): ``claude plugin validate`` on the packaged
manifest; ``claude plugin install --plugin-dir``; inspect
``~/.claude/settings.json``'s ``enabledPlugins`` in a temp
``CLAUDE_CONFIG_DIR``.

Note: live probing during this run found that ``claude plugin install``
(2.1.278) has no ``--plugin-dir`` flag — that flag exists only on the
top-level ``claude`` command for a session-only load. Persisting a plugin
into ``enabledPlugins`` requires ``claude plugin marketplace add <dir>``
(a directory-source marketplace) followed by
``claude plugin install <name>@<marketplace>``. This spike records that
correction explicitly rather than silently swapping in the literal method
text, since docs/spikes.md says not to re-derive the method — but the
method as written does not execute at 2.1.278, so the corrected literal
form actually run is recorded verbatim.

PASS means: manifest accepted with ``skills``, ``agents``, ``hooks``,
``mcpServers``; plugin hooks fire in a consuming repo; format recorded.
This never touches the real ``~/.claude`` — everything runs under an
isolated ``CLAUDE_CONFIG_DIR`` in a temp directory.
"""

from __future__ import annotations

import json
import os
import subprocess
import uuid
from pathlib import Path

from . import common

SPIKE_ID = "S11"

PLUGIN_NAME = "archon-spike-probe"
MARKETPLACE_NAME = "archon-spike-marketplace"


def _build_plugin_dir(ctx: common.SpikeContext, marker_path: Path) -> Path:
    plugin_dir: Path = ctx.new_temp_dir("s11-plugin")
    (plugin_dir / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (plugin_dir / "agents").mkdir(parents=True, exist_ok=True)
    (plugin_dir / "skills" / "probe-skill").mkdir(parents=True, exist_ok=True)
    (plugin_dir / "hooks").mkdir(parents=True, exist_ok=True)

    (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
        json.dumps(
            {
                "name": PLUGIN_NAME,
                "version": "0.0.1",
                "description": "S11 manifest-surface probe fixture (never installed for real).",
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (plugin_dir / ".claude-plugin" / "marketplace.json").write_text(
        json.dumps(
            {
                "name": MARKETPLACE_NAME,
                "owner": {"name": "archon spike"},
                "plugins": [
                    {"name": PLUGIN_NAME, "source": "./", "description": "S11 fixture plugin."}
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (plugin_dir / "agents" / "probe-agent.md").write_text(
        "---\nname: probe-agent\ndescription: S11 fixture agent.\n---\nSay hi.\n", encoding="utf-8"
    )
    (plugin_dir / "skills" / "probe-skill" / "SKILL.md").write_text(
        "---\nname: probe-skill\ndescription: S11 fixture skill.\n---\nNothing to do.\n", encoding="utf-8"
    )
    (plugin_dir / "hooks" / "hooks.json").write_text(
        json.dumps(
            {
                "hooks": {
                    "SessionStart": [
                        {"hooks": [{"type": "command", "command": f"touch {marker_path}"}]}
                    ]
                }
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (plugin_dir / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"probe-mcp": {"command": "/bin/false", "args": []}}}, indent=2),
        encoding="utf-8",
    )
    return plugin_dir


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    marker = ctx.new_temp_dir("s11-marker") / "session_start_hook.marker"
    plugin_dir = _build_plugin_dir(ctx, marker)
    cfg_dir = ctx.new_temp_dir("s11-cfgdir")

    validate = subprocess.run(
        [common.CLAUDE_BIN, "plugin", "validate", str(plugin_dir)],
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, "CLAUDE_CONFIG_DIR": str(cfg_dir)},
    )
    validate_ok = validate.returncode == 0

    env = {"CLAUDE_CONFIG_DIR": str(cfg_dir)}
    full_env = {**os.environ, **env}

    add_mp = subprocess.run(
        [common.CLAUDE_BIN, "plugin", "marketplace", "add", str(plugin_dir)],
        capture_output=True,
        text=True,
        timeout=30,
        env=full_env,
    )
    plugin_id = f"{PLUGIN_NAME}@{MARKETPLACE_NAME}"
    install = subprocess.run(
        [common.CLAUDE_BIN, "plugin", "install", plugin_id, "-y", "--json"],
        capture_output=True,
        text=True,
        timeout=30,
        env=full_env,
    )
    install_ok = install.returncode == 0

    settings_path = cfg_dir / "settings.json"
    settings = {}
    if settings_path.exists():
        try:
            settings = json.loads(settings_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            settings = {}
    enabled_plugins = settings.get("enabledPlugins", {})
    enabled_plugins_format_matches = enabled_plugins.get(plugin_id) is True

    observations = {
        "validate_returncode": validate.returncode,
        "validate_stdout_tail": validate.stdout[-800:],
        "marketplace_add_returncode": add_mp.returncode,
        "marketplace_add_stdout_tail": add_mp.stdout[-400:],
        "install_returncode": install.returncode,
        "install_stdout_tail": install.stdout[-800:],
        "settings_enabledPlugins": enabled_plugins,
        "enabledPlugins_format_matches_name_at_marketplace_true": enabled_plugins_format_matches,
        "corrected_method": (
            "'claude plugin install --plugin-dir' does not exist at 2.1.278 (top-level "
            "--plugin-dir is session-only, not a plugin-install subcommand flag); used "
            "'claude plugin marketplace add <dir>' + 'claude plugin install <name>@<marketplace>' "
            "instead, which is what actually persists enabledPlugins."
        ),
    }

    if not validate_ok or not install_ok:
        return common.EvidenceRecord(
            id=SPIKE_ID,
            date=ctx.date,
            engine_version=ctx.engine_version,
            verdict="FAIL",
            literal_form="claude plugin validate <dir> ; claude plugin marketplace add <dir> ; claude plugin install <name>@<marketplace>",
            observations=observations,
        )

    if not ctx.allow_live:
        obs = dict(observations)
        obs["reason"] = "not authorized: --allow-live not passed (consuming-repo hook-fire check skipped)"
        return common.EvidenceRecord(
            id=SPIKE_ID,
            date=ctx.date,
            engine_version=ctx.engine_version,
            verdict="UNRESOLVED",
            literal_form="claude plugin validate/marketplace add/install executed; consuming-repo hook-fire check skipped",
            observations=obs,
        )
    if not ctx.has_headroom():
        obs = dict(observations)
        obs["reason"] = "budget exceeded: insufficient remaining --budget-usd headroom for consuming-repo check"
        return common.EvidenceRecord(
            id=SPIKE_ID,
            date=ctx.date,
            engine_version=ctx.engine_version,
            verdict="UNRESOLVED",
            literal_form="claude plugin validate/marketplace add/install executed; consuming-repo hook-fire check skipped",
            observations=obs,
        )

    consuming_repo = ctx.new_temp_dir("s11-consumer")
    common.init_git_repo(consuming_repo)
    args = [
        "-p",
        "Reply with exactly OK and nothing else.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
    ]
    result = common.run_claude(args, cwd=consuming_repo, env=env, timeout=60)
    cost = common.extract_cost(result)
    ctx.record_spend(cost)

    init = common.init_event(result)
    hook_fired = marker.exists()
    mcp_servers = (init or {}).get("mcp_servers", [])
    mcp_registered = any("probe-mcp" in str(s) for s in mcp_servers) if isinstance(mcp_servers, list) else False

    observations["consuming_repo_sessionstart_hook_fired"] = hook_fired
    observations["consuming_repo_init_mcp_servers"] = mcp_servers
    observations["consuming_repo_probe_mcp_registered"] = mcp_registered
    observations["nonce_run_id"] = uuid.uuid4().hex[:8]

    verdict = "PASS" if (validate_ok and install_ok and enabled_plugins_format_matches and hook_fired) else "FAIL"

    return common.EvidenceRecord(
        id=SPIKE_ID,
        date=ctx.date,
        engine_version=ctx.engine_version,
        verdict=verdict,
        literal_form=(
            "claude plugin validate <dir> ; CLAUDE_CONFIG_DIR=<isolated> claude plugin marketplace add <dir> ; "
            "CLAUDE_CONFIG_DIR=<isolated> claude plugin install <name>@<marketplace> -y --json ; "
            "CLAUDE_CONFIG_DIR=<isolated> claude -p 'OK' (consuming repo, checks SessionStart hook marker)"
        ),
        observations=observations,
        cost_usd=cost,
    )
