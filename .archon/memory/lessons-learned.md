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

## Guard tests need revert-experiment evidence

```
role: qa-engineer
domain: testing
scope: hook and guard tests
status: active
constraint: a guard/hook test must prove BOTH directions — the target case is blocked AND the normal-flow case still passes
pattern: failure — a guard test that never fails proves nothing; cause — the assertion never exercised the blocked path; fix — temporarily revert the guard, show the test goes red, then restore (revert-experiment evidence); prevention rule — for any block/allow contract change, capture the red-on-revert result alongside the green-on-fix result
```
