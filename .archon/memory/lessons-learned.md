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

## Enumerating unsafe shapes never converges — invert to fail-closed plus a bounded vocabulary

```
role: backend-engineer
domain: security, redaction
scope: src/admin/why-redaction.ts (audit F9, rounds 1-11)
status: active
constraint: when a scrubber/allowlist tries to enumerate every unsafe shape or keyword a secret might take, each round finds a new synonym, join form, or phrasing the list hasn't seen yet — the list never converges
pattern: failure — rounds 1-4 chased shape-hunting/shape-allowlisting patches, each leaving a residual bypass (compound env-vars, JSON-shaped secrets, bare-prose secrets); rounds 6-7 chased keyword-enumeration (13+ synonyms, join-form variants) and still leaked; fix — round 8 inverted the model to redact-by-default with a vocabulary-anchored allowlist (a token survives only as an exact vocabulary member or one of a few bounded, machine-generated shapes — UUID, ISO timestamp, flag name); prevention rule — when tempted to add "one more shape/keyword" to a denylist, stop and ask whether the model should instead default-deny and allowlist narrowly; enumeration-based safety lists are a smell, not a solution
```

## Every structural exemption needs a written why-this-cannot-hide-a-secret rationale

```
role: backend-engineer
domain: security, redaction
scope: src/admin/why-redaction.ts (audit F9, round 11)
status: active
constraint: a shape-based exemption from redaction (a flag name, a path segment, "all-lowercase word segments") must come with an explicit, falsifiable rationale for why that shape cannot carry a secret — not just a shape that "looks safe"
pattern: failure — round 11 considered exempting flags whose hyphen-segments are all bounded lowercase words (e.g. `--auth-timeout`), but found a live counterexample: `--auth-hunterbunny` (a lowercase, no-digit secret glued the same way) is STRUCTURALLY IDENTICAL to the benign case under that rule; fix — rejected the exemption as unfalsifiable and instead documented the resulting over-redaction as an accepted, owned trade-off, locked with tests; prevention rule — before adding a structural exemption, try to construct a live adversarial input the exemption would wrongly admit; if one exists, the exemption is not airtight — accept and document the trade-off instead of shipping it
```

## A fix can reintroduce its own bug class through a different code path — reprobe after every round

```
role: backend-engineer, security-reviewer
domain: security, redaction
scope: src/admin/why-redaction.ts (audit F9, rounds 9-11)
status: active
constraint: fixing one instance of a bug class does not guarantee the class is closed — the same underlying weakness can resurface through a sibling code path the fix didn't touch
pattern: failure — round 10 fixed unbounded label capture around a keyword by bounding it and adding a keyword-substring backstop; round 11's gate found the SAME "recognized keyword" concept was still spelled literally (separator-free) at every consulting site, so splitting a keyword with one hyphen (`pass-word`) defeated the round-10 fix through a different angle than the original bug; fix — moved the keyword source to one shared, separator-tolerant module so every site is fixed at once, not per-site; prevention rule — after fixing a bug class, explicitly probe the idiomatic NEXT-MOST-OBVIOUS variant of the same class (different separator, different join form, different position) before declaring the round closed
```

## Keyword matching must compare against separator-normalized text

```
role: backend-engineer
domain: security, string-matching
scope: src/admin/why-redaction-keywords.ts (audit F9, round 11)
status: active
constraint: a literal, separator-free keyword/substring check is bypassed by inserting a hyphen, underscore, or other filler character between any two characters of the keyword — this applies anywhere a "does this text contain keyword X" check gates a security decision, not just this module
pattern: failure — `pass-word`, `to-ken`, `au-th`, `cred-ential` all defeated a literal `password|token|auth|credential` regex alternation used to disqualify a flag name from blanket trust, letting a glued secret through as an inert label; fix — built the keyword source as a regex alternation tolerating an optional single separator between every letter (`p[-_]?a[-_]?s[-_]?s...`), exported from one shared module; prevention rule — any keyword/substring security check must normalize (or tolerate) common separator-insertion before comparing, and the fix must live in ONE shared source every consulting site imports, not a per-site patch
```

## The trust vocabulary is itself an attack surface — classify and enforce every source at read time

```
role: backend-engineer, security-reviewer
domain: security, redaction
scope: src/admin/why-vocabulary.ts (audit F9, rounds 13-16)
status: active
constraint: in a redact-by-default design, anything folded into the trust vocabulary is a potential laundering path; every source must be classified (static / enum / machine-generated / free-form) and each kept source traced to an ENFORCED validation point in code — a write-side discipline that the read side never checks is not enforcement
pattern: failure — rounds 13-15 each found a new unvalidated fold-in (sibling task ids, sidecar fields read from disk with no enum check, councilOutcome typed as bare string), each one a full verbatim secret leak requiring only ordinary task-creation or file-write access; fix — free-form identifiers dropped from the vocabulary entirely (display via structured paths interpolated after sanitization), disk-sourced fields validated against writer-exported enum sets at read time, and the classification table annotated with a concrete file:function enforcement point per row; prevention rule — when a value's safety claim is "the writer only ever writes bounded values", require the READER to validate against the writer's exported canonical set; audit the vocabulary source list exhaustively after any change, and treat "typed as string in the domain model" as free-form regardless of what writers do today
```

