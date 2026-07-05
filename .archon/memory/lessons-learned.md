# Lessons Learned

failure -> cause -> fix -> prevention rule. One lesson per block; keep the prevention
rule concrete enough to act on next time.

## build:dist is the real build; `build` is a noEmit no-op

```
role: build-resolver
domain: install
scope: package.json scripts
status: active
constraint: the dist-producing script is `npm run build:dist` (node scripts/build-dist.mjs); `npm run build` is `tsc` with noEmit and produces nothing
pattern: failure — a stale/empty dist ships and dist MCP servers never start; cause — running `npm run build` expecting emit; fix — run `npm run build:dist`; prevention rule — build dist with build:dist and never treat `build` as an emit step (a prior agent burned a review round on this)
```

## Verify the artifact a finding names, not a proxy

```
role: qa-engineer
domain: review
scope: verification evidence
status: active
constraint: when a finding names a specific artifact (a built server, a generated file, a version string), verify THAT artifact — not a stand-in that merely correlates
pattern: failure — "dist MCP servers never started" shipped because verification checked a src-path proxy, not the dist entrypoint (fixed via src-path entrypoint guards, #149); prevention rule — reproduce against the exact named artifact before recording a gate pass
```

## A ghost union-member kind must be caught by real test fixtures, not comments

```
role: reviewer
domain: runtime
scope: src/daemon/dispatch-owner-turn.ts, tests (PR #49)
status: active
constraint: a directive "kind" referenced in comments or test fixtures must be a real member of the discriminated union it claims to belong to — never invent a plausible-looking one
pattern: failure — the daemon.ts split's loop-tail extraction (PR #49, dispatch-owner-turn work) carried a stale `dispatch_analysis` kind in comments and a test fixture that was never a real DaemonDirective union member; cause — the fixture used an `as unknown as never` cast to force a non-existent kind through the type system instead of a genuine directive; fix — review caught it pre-merge and the test was rewritten to use the real `continue_analysis` directive with no unsafe cast; prevention rule — grep test fixtures for `as unknown as never`/similar casts near directive kinds and confirm every referenced kind resolves in the actual union before merging
```
