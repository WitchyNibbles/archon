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

## Fail-closed ends a bug class; fail-open only patches one instance

```
role: security-reviewer
domain: runtime
scope: hook command-verification gates (auditP3Stewards postmortem, PR #164)
status: active
constraint: when a gate cannot verify its input (unknown wrapper flag, dynamic command word, unparseable segment), block by default — never optimistically guess and proceed
pattern: failure — an earlier optimistic flag-skip let crafted wrapper shapes (docker run --name …, sudo --preserve-env …, xargs --arg-file …) slip the real command past the DB-client guard; cause — the parser guessed instead of admitting it could not verify; fix — fail closed on any ambiguous/unverifiable token; prevention rule — a verification gate that guesses is a bypass; make "cannot verify" resolve to "block" so one fix ends the whole class instead of the one shape you happened to see
```

## A fix can reintroduce the very class it fixes — test the idiomatic form, not just the reported one

```
role: reviewer
domain: runtime
scope: security-fix regression tests (auditP3Stewards postmortem, PR #164)
status: active
constraint: when hardening against a bug class, add a test for the NATURAL/idiomatic form of the input, not only the exact reported instance — the fix itself often re-opens the class through an adjacent shape
pattern: failure — a fix for one command shape left the idiomatic variant of the same construct unguarded, so the class was only half-closed; cause — the regression test pinned the single reported instance; fix — enumerate the idiomatic variants and test each; prevention rule — for every "we fixed X", ask "what is the most natural way someone writes X?" and add that case; a green test on the reported instance is not proof the class is closed
```

## Audit tables that humans maintain need a machine cross-check

```
role: qa-engineer
domain: governance
scope: allowlist/audit tables (auditP3Stewards postmortem, PR #164)
status: active
constraint: any hand-maintained table a gate trusts (managed-path prefixes, required-review roles, approved-outcome sets, command allowlists) must have an automated cross-check against the code that consumes it
pattern: failure — a table drifted from the code reading it and nobody noticed until a gate misfired; cause — the table and its consumer were kept in sync by hand; fix — add a test asserting the table and the consuming logic agree; prevention rule — never let a trusted table and its enforcement live only in two humans' heads; pin their agreement with a test (e.g. `why`'s APPROVED_COUNCIL_OUTCOMES mirrors hook-policy.mjs and should be cross-checked)
```

## Bare-word matching misses path-prefixed and wrapped binaries

```
role: security-reviewer
domain: runtime
scope: command-name detection in hooks (auditP3Stewards postmortem, PR #164)
status: active
constraint: detecting a program by matching a bare word (\bpsql\b) misses /usr/bin/psql, ./psql, wrappers, and computed names — normalize to the effective program word before matching
pattern: failure — a bare-word guard for a sensitive binary was evaded by a path-prefixed invocation; cause — the matcher assumed the binary always appears as a bare token; fix — resolve the effective command word (strip path prefix, peel known wrappers, reject unverifiable dynamic words) before the allow/deny decision; prevention rule — match on the resolved program identity, not the surface token; a path prefix or wrapper must not launder a blocked binary past the gate
```
