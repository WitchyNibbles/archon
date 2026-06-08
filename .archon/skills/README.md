# Repo-Local Skills

This directory holds repo-specific SKILL.md files that teach the agent how to work
in this codebase. Skills here are created manually or by the archon skill review step
after task completion.

## Structure

  .archon/skills/<category>/<name>/SKILL.md      main skill instructions
  .archon/skills/<category>/<name>/references/   error transcripts, API doc excerpts
  .archon/skills/<category>/<name>/templates/    starter files to copy and modify
  .archon/skills/<category>/<name>/scripts/      re-runnable verification scripts

## Format

See .archon/rules/skill-format.md for the full SKILL.md spec and naming rules.

## Usage

Invoke a skill by asking the agent to load it: "check the typescript-build skill before
diagnosing this error". The agent discovers all skills in this directory automatically.
