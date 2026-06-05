---
name: archon-release-readiness
description: Shipment gate for package and installer changes.
---

# Archon Release Readiness

Use before calling package or control-layer work ready to ship.

Goal: block releases that are green on paper but unsafe to ship.

1. Restate the shipment surface.
2. Verify tests, typecheck, package contents, migration safety, setup notes, and rollback notes.
3. Ensure no live `.archon/work/` state or reviewed memory content is shipped.
4. Call out breaking changes, env changes, and operator steps explicitly.
5. Block completion if evidence is missing.

## Rules

- do not approve installer or migration work without replayable verification
- do not treat `npm pack --dry-run` as sufficient when runtime or schema behavior changed
- keep the gate concrete: commands, files, rollback, and operational caveats

## Output

Return a concise ship/no-ship checklist with evidence and remaining blockers.
