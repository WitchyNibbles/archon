---
name: superpowers-using-git-worktrees
description: Repo-local wrapper for safe worktree usage. Use when branching, parallel slices, or isolation concerns make separate worktrees the safer git path.
---

# Superpowers Using Git Worktrees

Use when parallel work, branch isolation, or risky changes justify a separate worktree.

Goal: keep changes isolated without polluting the main working tree.

1. Decide whether the task truly benefits from a separate worktree:
   - parallel implementation
   - risky refactor
   - review isolation
2. Keep one concern per worktree when possible.
3. Make branch names explicit and traceable to the task.
4. Confirm the worktree path and branch before editing or staging.
5. Clean up unused worktrees once the slice is merged or intentionally abandoned.

## Anti-patterns

- multiple unrelated tasks in one worktree
- losing track of which branch owns a directory
- staging from the wrong worktree
- leaving stale worktrees with ambiguous purpose

## Output

Return:
- worktree decision
- branch isolation notes
- cleanup needs
