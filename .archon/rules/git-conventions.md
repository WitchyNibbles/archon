# Git Conventions

These are the shared `archon` defaults for branch names, commit subjects, and PR metadata.

## Branch workflow

- fetch and branch from updated `origin/main` before task or plan work
- preferred command shape: `git fetch origin main && git switch -c feature/my-slice origin/main`
- avoid doing substantive task work directly on `main`

## Default branch prefixes

- `feature/`: new functionality
- `bugfix/`: non-production bug fixes
- `hotfix/`: urgent production fixes
- `release/`: release preparation
- `chore/`: maintenance work
- `refactor/`: code restructuring
- `docs/`: documentation changes
- `test/`: test-related work
- `ci/`: CI or automation changes
- `perf/`: performance improvements

This default takes priority over GitHub MCP branch suggestions.

## Consuming repo override

Consuming repos may override the default branch prefixes by adding a higher-precedence repo guideline.

For deterministic local branch-hook overrides, add a line to the consuming repo `CLAUDE.md`:

`branch_naming_override_prefixes=feature/,bugfix/,hotfix/,release/,chore/,refactor/,docs/,test/,ci/,perf/`

Replace the list with the consuming repo's approved prefixes.

## Commit subjects

- use brief Conventional Commits subjects
- keep the subject at 72 characters or fewer
- omit the trailing period
- describe the slice being committed, not the whole project
- do not use `claude` or `archon` as the sole subject

## Pull requests

- keep PR titles brief, specific, and user-reviewable
- summarize what changed and why in the body
- include verification evidence and notable risks
- avoid filler or tool-branded wording
