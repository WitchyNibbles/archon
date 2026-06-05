---
name: archon-design-system
description: Use when frontend work needs reusable visual rules, tokens, component consistency, or stronger systemization so UI quality survives beyond a single screen.
---

# Archon Design System

Use when a UI task needs durable consistency across components or screens.

Goal: turn one-off styling into a small system with explicit tokens and repeatable rules.

1. Define the minimum useful token set:
   - type scale
   - spacing scale
   - radius and border rules
   - color roles
   - elevation or surface rules
2. Put tokens near the implementation surface that owns them.
3. Normalize repeated component patterns instead of restyling each instance independently.
4. Prefer semantic names over raw-value reuse when the token has a role.
5. If the existing system is weak, tighten it with the fewest changes that improve consistency.
6. Verify the system on at least: one dense screen, one empty or sparse state, one mobile layout.

## Anti-patterns

- ad hoc colors per component
- repeated near-identical spacing values
- arbitrary radius or shadow changes
- desktop-only token decisions
- design-system prose with no code-level token surface

## Output

Return token decisions introduced or reused, components or surfaces normalized, and remaining system inconsistencies.
