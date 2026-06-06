---
name: anthropic-mcp-builder
description: Repo-local wrapper for MCP server implementation discipline. Use when agent/runtime work needs tool schema rigor, deterministic contracts, or safer MCP integration changes.
---

# Anthropic MCP Builder

Use when implementing or changing MCP servers, tool wiring, or model-facing MCP contracts.

Goal: keep MCP changes deterministic, reviewable, and small enough to verify.

1. Define the exact MCP surface being changed:
   - server capabilities
   - tool names and schemas
   - input validation
   - output contract
2. Keep deterministic behavior in code and configuration, not in prompt-only instructions.
3. Prefer the smallest schema or routing change that fixes the real problem.
4. Validate failure behavior explicitly:
   - missing inputs
   - invalid inputs
   - unavailable downstream dependency
   - backward-compatibility drift
5. Treat MCP config, capabilities, and timeouts as compatibility surfaces with regression coverage.

## Anti-patterns

- vague tool descriptions with broad side effects
- hidden required fields
- prompt fixes for schema problems
- widening capabilities without proving the need

## Output

Return:
- changed MCP surface
- contract risks
- regression checks
- rollback notes
