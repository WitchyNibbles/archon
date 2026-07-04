# Decision Log

Recorded architectural and policy choices: what won, the tradeoff accepted, and what
it superseded. Append newest at the bottom; mark a prior entry superseded when a newer
decision overrides it.

```
role: memory-curator
domain: retrieval
scope: src/store/, migration 014_drop_qdrant_columns.sql
status: active
decision: pgvector is the sole vector search path; Qdrant removed
constraint: all artifact embedding retrieval comes from pgvector cosine search only
pattern: keep one retrieval backend to avoid dual-source drift
```

```
role: solution-architect
domain: runtime
scope: .claude/agents/, roster generator
status: active
decision: the roster catalog is the single source of truth for agents — agent frontmatter and the tools field are generated from it, not hand-edited (PR #160, #161)
constraint: do not hand-edit generated agent frontmatter; change the catalog and regenerate
```

```
role: infra-engineer
domain: workflow
scope: .archon/work/, src state export writer
status: active
decision: live .archon/work/ runtime state is gitignored and written by a single export writer; the package ships templates, not live state (PR #162, user direction 2026-07-04)
constraint: skill/template/memory deliverables go in tracked paths (.claude/skills, .archon/templates, .archon/memory); nothing under .archon/work/ is committed
```

```
role: solution-architect
domain: runtime
scope: src/runtime/, hook scripts, supervisor
status: active
decision: context handoff + session respawn is split by surface — interactive (Stop-hook path) and daemon are wired separately; a component merged for one surface does not imply the other fires (handoffConsumerWiring initiative)
constraint: verify both surfaces end-to-end before claiming handoff works in consumer repos
```

```
role: infra-engineer
domain: install
scope: package.json, installer, doctor preflight
status: active
decision: archon publishes as a dist-only scoped npm package with BYO-DB and a doctor preflight; released v0.2.0 (install-hardening #135-151)
constraint: the dist-producing build is `npm run build:dist`; publishing raw src or a noEmit build ships a broken package (see lessons-learned)
```
