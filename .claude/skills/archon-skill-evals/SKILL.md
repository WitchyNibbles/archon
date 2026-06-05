---
name: archon-skill-evals
description: Evaluate whether a skill triggered correctly, followed the right workflow, and improved behavior measurably.
---

# Archon Skill Evals

Use when adding, changing, or validating a skill, skill trigger, role-to-skill mapping, or control-layer behavior that depends on skills.

Goal: prove the skill is not only present but actually improving behavior in a repeatable way.

1. Define the target behavior the skill should change.
2. Create at least one positive case and one negative or counterexample case.
3. Check: did the right skill trigger, did it produce the expected workflow steps, did it avoid the wrong shortcuts.
4. Prefer traceable evidence such as files read, commands run, artifacts produced, or review structure followed.
5. Separate skill-trigger correctness from overall task success.
6. Record what regression would look like.

## Rules

- do not treat skill existence as proof of skill use
- do not test only happy-path invocations
- the eval should be able to fail for a specific reason

## Output

Return target behavior, cases, pass or fail conditions, evidence source, and rerun command.
