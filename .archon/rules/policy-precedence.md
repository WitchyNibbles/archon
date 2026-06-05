# Policy Precedence

Use this order when rules conflict:

1. `CLAUDE.md`
2. `.archon/rules/`
3. approved `.archon/memory/`
4. shared backend retrieval hints
5. current run notes and handoffs

If a lower-precedence source conflicts with a higher one, follow the higher-precedence source and record the conflict in the active work artifacts.
