# Write Scope Rules

- normal workers do not edit `CLAUDE.md`, `.claude/`, `.claude/agents/`, or `.archon/memory/` unless explicitly assigned
- one active writer is allowed per overlapping write scope
- read-only analysis may run in parallel
- wide write scopes are a planning bug, not a convenience feature
- autonomous continuation must use explicit successor task-packet handoff scope; do not assume the current task can create arbitrary future packets
- release locks only after handoff or explicit rollback
