# `why-redaction.ts` design history

This document is the extracted round-by-round evolution narrative for
`src/admin/why-redaction.ts` (audit F9, `archon why`'s secret-redaction
module). It exists so the module's own header can stay lean — current
contract only — while this history remains available to anyone auditing
*why* the design looks the way it does. Round-9 (LOW finding 1) moved this
content out of the module header, which had grown past its line-count
ratchet purely from accumulated historical prose, not current-contract
complexity.

This file is intentionally co-located under `src/admin/` (not under
`docs/`) so it stays within this task's declared write scope; it is
engineering-history documentation for maintainers of this module, not
user/operator-facing product documentation, so it is not added to
`package.json`'s `files[]` allowlist (consistent with several other
`docs/*.md` files already not shipped, e.g. `docs/archon-analysis.md`).

Read `src/admin/why-redaction.ts`'s module header first for the CURRENT
contract (exemption checklist, boundedness audit, residual disclosure).
Everything below is superseded history, kept for context only — do not
treat any rule described here as authoritative if it conflicts with the
current header or the code.

## Rounds 1-4 (pre-vocabulary-anchoring)

Round 4 inverted the default from "hunt for secret shapes" to "redact by
default, allowlist a few safe SHAPES" (UUID, path, number, flag, bare
identifier). Round 5's gate found the residual bypass in that model: a
generic identifier SHAPE (`[A-Za-z][A-Za-z0-9_-]*`) can never prove safety,
because a real secret often looks EXACTLY like one — `ghp_XXXX`,
`hunter2Aa1`, an API key. "token ghp_XXXX is invalid" and "password is
hunter2Aa1" both shape-matched the round-4 identifier allowlist and
survived untouched. Chasing yet another shape distinction would only
produce a fifth bypass.

## Round 5 — vocabulary anchoring

ROUND-5 FIX — anchor the allowlist to KNOWN VOCABULARY, not shape alone:

The blanket "any identifier-shaped token is safe" rule was removed. In its
place, a free-text token survives only if it is:

1. An EXACT member of a `knownSafeTokens` vocabulary the caller supplies
   — built, at diagnosis time, from the STRUCTURED context the collector
   already holds (task ids, run ids, role names, status/enum/outcome
   tokens, this module's own recommended command words, sidecar paths it
   constructed). See why-diagnosis.ts's `buildKnownVocabulary`.
2. A flag name (`-x`, `--long-flag`) — flags are labels, never secrets.
3. A number or ISO-timestamp shape — machine-generated, not
   attacker-controlled.
4. A path (absolute, `./`/`../`-relative, OR bare relative) containing no
   `@` and no `://` — credential-bearing shapes always carry one of those.
5. A `scheme://host...` URL with NO userinfo component (no `@`) — a URL
   that DOES carry `user:pass@` is caught by stage 1 before tokenization
   ever sees it.

Everything else — including any bare word, identifier, or acronym that
merely LOOKS like a safe token — redacts. `ghp_XXXX`, `hunter2Aa1`, and
ordinary English prose in a caught error message all die unless the caller
explicitly vouches for them via the vocabulary. `sanitizeFreeText`/
`sanitizeForDisplay` default `knownSafeTokens` to an EMPTY set, so any
caller that does not supply a vocabulary gets the strictest possible
behavior — this is deliberate: a missing vocabulary must never silently
fall back to "shape is enough".

Stage 1 (`applySecretMarkerRules`) was kept as defense-in-depth: high-
confidence context markers (credential URLs, AWS key ids, well-known
secret-token prefixes — `ghp_`, `sk_live_`, `sk-ant-`, `npm_` — labeled
`key=value` fields, Authorization/Bearer headers, mysqldump's `-p<value>`)
redact regardless of what stage 2's vocabulary check would have decided,
so an obviously-shaped secret dies even before tokenization.

**HONEST FRICTION** (re-disclosed per the round-5 gate's explicit request):
the real footprint of this design is "any free-text token not in the known
vocabulary redacts." That is broader than round 4's disclosed friction
(colon-containing compound words only). It ALSO includes: ordinary
English prose in a caught error message or recorded shell command (a hook-
blocker's `npm test` becomes two `[redacted]` tokens unless "npm"/"test"
happen to be vocabulary words); acronyms and identifiers that are not task
ids, run ids, role names, or enum tokens (a respawn lease owner like
"daemon-A" redacts unless it happens to equal a known id); and IPv6
addresses and other colon-bearing tokens (unchanged from round 4 — still
redact, since colon is the same shape as a credential fragment). Numbers,
ISO timestamps, and paths were NOT vocabulary-gated at this point — they
survived via their own shape rules regardless of vocabulary, since round 5
specifically fixed their prior over-redaction (this changed again in round
8 — see below). The sidecar-file pointer already present in every cause's
evidence remains the relief valve: the operator can always read the
untouched original there. This was a deliberate, disclosed trade-off, not
an oversight — the alternative (letting shape alone decide) is exactly the
bypass class this redesign exists to close.

## Round 6

An UNBOUNDED digit run is itself a shape that can't prove safety —
`--token 837215098172340192` shape-matched `SAFE_NUMBER` and survived.
`SAFE_NUMBER` was bounded; a space-separated labeled flag (`--token <v>`,
`--password <v>`, etc.) was caught at stage 1 regardless of the value's
shape; and `SAFE_URL_NO_USERINFO`'s `@` exclusion was narrowed to the
URL's authority segment, so a query-string email no longer over-redacted
the whole URL.

## Round 7

The round-6 `SAFE_NUMBER` bound only capped the INTEGER part —
`(?:\.[0-9]+)?` was still unbounded, so `9.87215098172340192` (a decimal
secret) shape-matched and survived whole. The bound was widened to apply
to the ENTIRE numeric token (sign + digits + decimal point together, ≤6
chars), per the gate's own simplest-fix suggestion. The same audit found
`SAFE_ISO_TIMESTAMP`'s fractional-seconds group was ALSO unbounded
(`(?:\.\d+)?`) — closed to 1-9 digits (real ISO timestamps never exceed
nanosecond precision). Separately, the keyword list gained `pin`, `otp`,
`passphrase`, `mfa`, `passcode`, `cvv`; a scoped compound-phrase rule
caught "pin code"/"otp code"/"verification code"/"auth code" WITHOUT
adding bare `code` (which would collide with this codebase's own
`exit-code`/`error-code`/`status-code` vocabulary); and a narrow prose
rule caught "<keyword> is <value>"-style adjacency (a secret keyword
followed within 1-2 filler words by a value token) for phrasings with no
flag and no colon/equals join.

The round-7 gate's own probing then found this keyword-enumeration
approach leaking again: round-6-named reproductions (`2FA: 482913`,
`--code 482913`) still leaked verbatim, plus at least a dozen more
realistic secret-labeling phrasings — recovery/backup/security/activation
code, license key, session id, CVC, card verification value, TOTP-in-
prose, PIN-number-with-colon, `--2fa`. The path/URL residual (bare
path-segment secrets, bare file-path secrets, generically-named URL
query-string secrets surviving intact) was rated HIGH — confirmed
exploitable, not a merely theoretical trade-off. An internal
inconsistency was also found: `PIN number:` (colon) vs `PIN number`
(space) vs `TOTP:` (colon, accidental substring match) vs `your TOTP is`
(prose, `\b`-blocked) behaved differently for the identical keyword,
root-causing several of the specific leaks above.

## Round 8 — terminal design, numeric exemption removed

Seven rounds proved the pattern conclusively: enumerated keyword labeling
CANNOT converge — there is always another synonym, another join form,
another phrasing the list hasn't seen yet. Round 8 removed the load-
bearing enumeration itself rather than adding a 13th/14th/15th keyword:

1. **The free-text numeric shape-exemption was removed entirely.** A bare
   number in free text now survives ONLY as an exact vocabulary member
   (ISO timestamps keep their own bounded shape-safety — they are
   machine-generated, not attacker-supplied, an entirely different case).
   Every number that matters to a diagnosis reaches output through this
   module's STRUCTURED evidence fields (why-diagnosis.ts's `structured()`),
   which never call `sanitizeFreeText` at all — the free-text numeric
   exemption was never load-bearing for legitimate output. With it gone, a
   numeric secret dies in EVERY phrasing, with ZERO keyword dependence.
2. **Paths and URLs are now tokenized, not exempted wholesale.** A URL
   keeps its scheme+authority (WHERE, not WHAT) but its path+query is only
   kept if EVERY token in it independently passes vocabulary/shape checks
   — otherwise the whole path+query collapses to
   `scheme://host/[redacted]`. A free-text path survives only if EVERY
   `/`-separated segment is a vocabulary member or a bounded safe shape —
   otherwise the WHOLE token redacts. Collector-constructed sidecar paths
   are added to the vocabulary as one whole string (no internal
   whitespace), so real evidence paths keep rendering via ordinary
   exact-match membership.
3. **The filler-word regex bug was fixed at root** (a correctness bug,
   independent of finding 1): the prose-adjacency rule required AT LEAST
   ONE filler word between a keyword and its value, so a bare, unprefixed
   "password hunter2Aa1" or "PIN 482913" matched neither that rule (needed
   a filler) nor the space-separated flag rule (needed a leading dash),
   and leaked. The filler count became `{0,2}`, closing that gap
   regardless of whether the value is numeric.
4. **The keyword rules were reframed as explicitly documented pure
   defense-in-depth, non-load-bearing.** They still run (cheap, and they
   still catch alphanumeric secrets like `hunter2Aa1` a beat earlier), but
   the SECURITY BOUNDARY became the vocabulary-anchored default-deny
   applied uniformly to every free-text token, numeric or not.

This closed the entire round-6/7 keyword-enumeration bug CLASS in one
structural move — verified against roughly 15 adversarial phrasings from
the round-7 gate's own probe list, none of which use a recognized
keyword, all of which redact purely because bare numbers no longer
survive by shape.

## Round 9 — the `[redacted]`-substring short-circuit, and stage-1 vocabulary blindness

Round 8's terminal design held for every keyword and shape class it
targeted, but round 9's gate found one CRITICAL mechanical bug and one
HIGH gap in the surrounding machinery, not in the terminal design itself:

1. **CRITICAL — the `"[redacted]"`-substring short-circuit.**
   `classifyToken` had a guard, `if (core.includes("[redacted]")) return
   token;`, meant to skip re-processing a token stage 1 had ALREADY fully
   redacted. But it matched on ANY substring occurrence, not just a whole-
   core exact match. A single whitespace-delimited token that mixed
   already-redacted stage-1 content with UNTOUCHED live secret content
   (glued together with no whitespace — e.g. a URL query string where
   stage 1's labeled-field rule caught one `key=value` pair but left a
   neighboring `&otherKey=value` pair untouched) tripped this guard and
   returned the WHOLE token unexamined, leaking the untouched portion in
   full. Live repro: `https://x.com/callback?state=<secret>&password=
   <secret>` — stage 1 redacts only the `password` value; the old code
   then let `state=<secret>` through completely. The fix narrowed the
   guard to an EXACT match (`core === "[redacted]"`) so only a token stage
   1 fully consumed short-circuits; anything else falls through to the
   existing tokenized analysis (`classifyUrlToken`, path-segment checks,
   the flag-value split, the final catch-all), each of which already
   replaces its entire matched scope rather than leaving fragments — so a
   partially-redacted token gets its untouched remainder correctly
   re-examined and, if unsafe, fully collapsed.
2. **HIGH — stage-1 vocabulary blindness.** `applySecretMarkerRules` (stage
   1) had no visibility into `knownSafeTokens` at all, so its value-
   redacting rules (labeled fields, space-separated flags, code phrases,
   prose keyword-adjacency, mysqldump's `-p<value>`) unconditionally
   redacted any value adjacent to a keyword, even a legitimate vocabulary
   member (`"password task-abc123"` destroyed `task-abc123` even though
   stage 2 alone would have correctly kept it, since it's OUR id, not the
   secret the keyword labels). The fix threaded `knownSafeTokens` through
   to each value-capturing rule via a shared `redactValueUnlessVocabulary`
   helper: a captured value that is an exact vocabulary member (after
   stripping incidental trailing punctuation, mirroring stage 2's own
   tokenization) survives; anything else still redacts exactly as before.
3. **MEDIUM — `classifyUrlToken`'s doc comment vs. observed behavior.**
   The apparent "partial in-place redaction" the round-9 gate observed
   for URLs was never actually `classifyUrlToken`'s own behavior — it was
   the CRITICAL bug above bypassing this function entirely and returning
   raw, partially-redacted stage-1 output unchanged. Once the short-
   circuit was narrowed (finding 1), `classifyUrlToken` is unconditionally
   the one deciding every URL-shaped token's fate again, so its wholesale-
   collapse doc comment and its actual behavior are back in sync with no
   remaining bypass path.
4. **LOW — this document.** The round-by-round narrative above was
   extracted out of the module header into this file, both to relieve
   ratchet pressure that had nothing to do with current-contract
   complexity, and so a future reader doesn't have to wade through eight
   rounds of history to find the two paragraphs describing the CURRENT
   design.

## Round 10 — flag-shape trust and unbounded label capture

Round 9's short-circuit fix held under harder probing (three-secret gluing,
nested URLs, off-by-one boundaries), and vocabulary threading held at all
6 stage-1 sites. Round 10 found one CRITICAL bug via a different angle —
not the substring short-circuit, but the LABEL half of a keyword-adjacent
match, and the flag-name grant that trusted it — plus one MEDIUM test gap:

1. **CRITICAL — flag-shape trust + unbounded label capture.**
   `--firstSecretHere123-password verysecretvalue` glues a live secret to
   the recognized keyword `password` via a hyphen. `LABELED_FIELD_PATTERN`
   and `SPACE_SEPARATED_SECRET_FLAG` captured the text before AND after the
   keyword with an UNBOUNDED `[\w-]*`, so `firstSecretHere123-` landed
   entirely inside the "label" half of the match — which stage 1 always
   re-emits unchanged (only the value half is ever substituted). Then, at
   stage 2, the old `SAFE_FLAG_NAME` trusted ANY dash-prefixed alnum-hyphen
   blob as a flag purely by shape, with no length bound and no awareness
   that its body contained a keyword at all — so the untouched, secret-
   bearing "label" sailed through as an inert, safe-looking flag name. Two
   fixes closed both ends:
   - The compound-keyword capture groups in `LABELED_FIELD_PATTERN` and
     `SPACE_SEPARATED_SECRET_FLAG` are now bounded to `{0,12}` characters
     each side of the keyword — generous enough for the real compound
     identifiers this rule exists to catch (`PG`+`PASSWORD`, `MYSQL_`+`PWD`,
     `AWS_`+`SECRET`+`_ACCESS_KEY`, all well under 12 chars), but too tight
     to reach an actual `:`/`=`/whitespace boundary while also absorbing a
     19-character glued secret fragment — the match simply fails, and the
     token falls through untouched to stage 2's default-deny instead of
     being partially (and wrongly) "handled" by stage 1.
   - `SAFE_FLAG_NAME` became `isSafeFlagName`: a flag body is still safe by
     shape alone if it IS, exactly, one recognized keyword — `--token`,
     `--password`, `--api-key` — the designed labeled-flag case round 6
     built this mechanism for. Any OTHER keyword-substring embedding (a
     prefix or suffix glued to the keyword, however short) is no longer
     blanket-trusted; the token falls through to ordinary default-deny.
     The same check now also gates the flag HALF of a `--flag=value` split,
     which previously echoed back unconditionally with no validation at
     all — a second, independent leak path the gate's live repro exposed.
   Verified against the gate's exact two-secret repro (glued before the
   keyword), a hyphen-glued-AFTER variant (glued after the keyword,
   `--password-secretHere value`), and a battery of legitimate long flags
   (`--experimental-strip-types`, `--max-warnings`, `--preserve-env`) that
   must keep surviving unchanged since they embed no keyword at all.
2. **MEDIUM — 4 untested vocabulary-threading call sites.** Round 9's fix
   threaded `knownSafeTokens` through all 6 stage-1 value-capturing rules,
   but only 2 of them got dedicated regression tests
   (`PROSE_SECRET_KEYWORD_PATTERN`, `LABELED_FIELD_PATTERN`'s colon form).
   The code was already correct; the remaining 4 sites
   (`SPACE_SEPARATED_SECRET_FLAG`, `LABELED_CODE_PHRASE_PATTERN`,
   `SPACE_SEPARATED_CODE_PHRASE_PATTERN`, `MYSQL_CONCAT_PASSWORD_FLAG`)
   were untested — exactly where the gate warned the next gap would hide
   in this file. Added both-direction tests for each.

## Round 11 — separator-normalized keyword matching, and the over-redaction trade-off finally documented instead of chased

Round 10 closed the "unbounded label capture" bypass by bounding the label
context AND by requiring `isSafeFlagName` to check whether a flag body
contains a recognized keyword SUBSTRING. Round 11's gate found the fix
reintroduced its OWN bug class through a different path — exactly the
pattern this module's history keeps warning about — plus resolved the
over-redaction tension round 10 left open:

1. **CRITICAL — hyphen-split keyword bypass.** Every keyword-consulting site
   (`LABELED_FIELD_PATTERN`, `SPACE_SEPARATED_SECRET_FLAG`,
   `PROSE_SECRET_KEYWORD_PATTERN`'s embedded `SECRET_KEYWORD_ALTERNATION`,
   plus `SECRET_KEYWORD_ANYWHERE` and `BARE_SECRET_KEYWORD` in
   `isSafeFlagName`) tested for a keyword via a LITERAL, separator-free
   spelling (`password`, `token`, `auth`, ...). Splitting a keyword with a
   single internal hyphen or underscore (`pass-word`, `to-ken`, `se-cret`,
   `au-th`, `cred-ential`) defeated the literal match at every one of those
   sites simultaneously, because they all copied the same separator-free
   spelling. The practical exploit: `--pass-word-hunter2Aa1Zz9` shape-matches
   a bare flag; `isSafeFlagName`'s keyword-substring check reported "no
   keyword present" (wrongly, since `password` never appears unsplit in
   `pass-word...`), so the WHOLE flag body — including the glued live
   secret — sailed through as a trusted flag label. Only `api-key`/
   `access-key` were partially immune, since those two had a hand-rolled
   `[_-]?` tolerance the others never got — itself a symptom of "per-site
   copies" rather than one shared rule.

   ROOT-CAUSE FIX: the keyword list moved to a new module,
   `why-redaction-keywords.ts`, and is no longer a literal string — each
   keyword is expanded to a regex-alternation fragment that tolerates an
   optional single `-`/`_` between any two of its letters
   (`looseKeywordSource`). `SECRET_KEYWORD_ALTERNATION`, the ONE exported
   constant, is what every consulting site in `why-redaction.ts` now embeds
   or wraps — `LABELED_FIELD_PATTERN`, `SPACE_SEPARATED_SECRET_FLAG`,
   `PROSE_SECRET_KEYWORD_PATTERN`, `SECRET_KEYWORD_ANYWHERE`, and
   `BARE_SECRET_KEYWORD` all reference the SAME import; there is no
   per-site copy left to independently drift out of sync. `api-key`/
   `access-key`'s special-cased hyphen tolerance was retired — the general
   mechanism already subsumes it. There is no backtracking-complexity cost:
   each letter is followed by at most one optional single-character
   separator, never a nested unbounded quantifier, so the fix stays
   linear-time regardless of input length.

   Verified against the gate's own repro family (`--pass-word-`,
   `--to-ken-`, `--se-cret-`, `--au-th-`, `--cred-ential-`, plus
   `--api-key-`/`--access-key-` for completeness) with a mixed-case glued
   secret, AND against an all-lowercase, no-digit glued secret
   (`--pass-word-hunterbunny`) — the exact residual the gate warned a
   case-only distinction could hide behind.

2. **MEDIUM — over-redaction of benign compound flags: accepted, not
   chased.** Round 10's keyword-substring backstop already wholesale-
   redacted legitimate flags like `--auth-timeout`, `--tokenizer`,
   `--secretless-mode`, and `--credential-source` (any flag containing a
   keyword substring, benign or not) — round 11 does not loosen or tighten
   this, it only makes the underlying keyword check harder to evade. A
   bounded structural exemption ("a flag body is safe if every hyphen-
   segment is a purely lowercase alphabetic word of bounded length") was
   designed and then REJECTED as not airtight: `--auth-timeout` (benign) and
   `--auth-hunterbunny` (a lowercase, no-digit secret glued the same way,
   this round's own gate scenario) are STRUCTURALLY IDENTICAL under that
   rule — both are a keyword segment followed by a bounded lowercase-word
   segment. Any exemption permissive enough to spare the former necessarily
   also spares the latter, which is exactly the "enumerating unsafe shapes
   never converges" trap round 8 already named and rejected once for numeric
   shapes. Per that same doctrine, this round chooses the DOCUMENTED
   trade-off (design choice (b)) over an unfalsifiable exemption (choice
   (a)): the over-redaction is explicitly disclosed in the module header's
   EXEMPTION CHECKLIST entry for `isSafeFlagName`, owned by
   `backend-engineer`, with a stated follow-up condition (revisit only if a
   real workflow needs these specific flags back, backed by a live
   counterexample the way this entry's own analysis was), and LOCKED with a
   dedicated regression test asserting the current (over-redacting) output
   for all 7 of the gate's named benign flags, plus a control test proving
   flags with NO embedded keyword substring at all remain unaffected.

3. **MEDIUM — test gap for both new bug classes.** Added: (i) both-direction
   redaction tests for every hyphen-split keyword repro, mixed-case and
   all-lowercase; (ii) a locked-trade-off test asserting the 7 named benign
   compound flags still redact wholesale (choice (b), not a regression); a
   control test for legitimate long flags with no embedded keyword; (iii) a
   dedicated `why-redaction-keywords.ts` unit-test file exercising
   `SECRET_KEYWORD_ALTERNATION` directly (every canonical keyword matches
   itself unsplit; every keyword tolerates one hyphen/underscore split; the
   alternation is a substring search, not a shape grant, so an ordinary
   secret-shaped value doesn't itself look like a keyword; no accidental
   duplicate entries in the canonical list).

4. **Task-packet hygiene (qa_engineer finding).** The task packet's cause
   count ("13 ranked causes") was stale — `why-diagnosis.ts` defines 15
   distinct cause ids. Corrected, and an explicit `## Acceptance criteria`
   section was added reflecting what the shipped code actually delivers.

## Round 12 — the fail-closed inversion (manager-directed; mirrors round 4)

Round 11's fix held for exactly one gate round before round 12's own probing
defeated it through a different angle — the THIRD recurrence of the same bug
class across rounds 10, 11, 12. The manager directed a structural inversion
rather than a fourth recognition patch, explicitly mirroring the round-4
inversion recorded above ("redact by default, allowlist a few safe shapes")
and the lessons this module's own postmortem had just promoted to
`lessons-learned.md`: enumerating unsafe shapes never converges, and a fix
can reintroduce its own bug class through a different code path.

### Root cause (not the regex — the trust direction)

`isSafeFlagName` had always been structured as: trust a flag body UNLESS a
keyword is recognized inside it. Every round (10: unbounded label capture:
11: single-separator splits; 12: double-plus separators AND digit-
interposed splits — `--pass--word-X`, `--p4ssword-X`, `--to9ken-X`) found a
new way to make recognition MISS, and every miss converted DIRECTLY into a
trust grant, because "not recognized" and "safe" were the same code path.
Widening `looseKeywordSource` (round 11) could never converge — this is
LITERALLY the first lesson this module's own postmortem promoted
("enumerating unsafe shapes never converges — invert to fail-closed").

### The inversion

`isSafeFlagName` no longer asks "do I recognize a keyword in this body?" at
all. It asks "does this body POSITIVELY match one of exactly two bounded
safe things?":

  (a) an EXACT, case-sensitive member of the caller's `knownSafeTokens`
      vocabulary — the SAME mechanism every other structured value in this
      module already uses (task ids, run ids, sidecar paths). This also
      closes round-11's own gate finding 4 (reviewer): `isSafeFlagName` had
      never consulted `knownSafeTokens` at all, an unexplored alternative.
  (b) the body IS, EXACTLY, one canonical secret-keyword flag spelling
      (`why-redaction-keywords.ts`'s `CANONICAL_BARE_SECRET_KEYWORD_FLAGS`
      — `token`, `password`, `api-key`, `access-key`, …) — the designed
      `--token <value>` labeled-flag case, deliberately EXACT and NOT
      separator-tolerant, because recognition looseness has no place in a
      POSITIVE trust grant (looseness only ever WIDENS what survives).

Everything else in flag position redacts. Under this inversion, a
separator/digit/case/unicode mutation of a keyword can only ever make
recognition WORSE, which — because recognition is no longer how trust is
granted — can only ever produce MORE redaction, never a leak. The bug class
ends by construction, not by enumeration: verified against the full
round-10/11/12 repro families AND unprompted next-idiom probes (triple
separators, mixed dash/underscore runs, Cyrillic/fullwidth Unicode
lookalike letters) — all redact, none require a new pattern to catch them.

`SECRET_KEYWORD_ALTERNATION` (stage-1's keyword-adjacent VALUE redaction)
is kept and even widened (bounded run `[-_]{0,3}`, up from a single optional
separator) — but it is now explicitly BEST-EFFORT coverage, not a security
boundary: a recognition miss there can only affect which value stage 1
redacts a beat earlier, never whether an unrecognized flag NAME survives.

### The allowlist decision (finding 2 in the directive)

Two options were on the table for the now-larger set of previously-surviving
benign flags (`--experimental-strip-types`, `--max-warnings`, `--pass-word`
bare, mysqldump's `-p`/`-u` conventions, and now every OTHER non-canonical
flag too, since the inversion is total): (a) add a small, individually-
justified allowlist of well-known benign CLI flag names to a default
vocabulary, or (b) accept and document the wider redaction, relying on the
existing `knownSafeTokens` threading mechanism as the escape hatch.

CHOSE (b). A hardcoded "well-known benign flag name" allowlist is itself an
enumerated list that would need the SAME forever-widening maintenance this
whole redesign exists to escape — every new CLI tool `archon why` might ever
wrap introduces new flag spellings, and the list would chase them
indefinitely, exactly the failure mode round 8 already closed for numeric
shapes. The existing vocabulary mechanism already solves this correctly: a
caller (why-diagnosis.ts's `buildKnownVocabulary`) that needs a specific
flag to survive threads it through `knownSafeTokens` the same way it already
threads task ids, run ids, and its own `RECOMMENDED_COMMANDS` vocabulary
(which, notably, already includes `--task-id` and similar flags literally,
via `tokenizeToVocabulary` over the command templates — so the common case
is unaffected in real usage). This is documented in the module header's
EXEMPTION CHECKLIST entry, owned by `backend-engineer`.

One concrete, previously-load-bearing case changed as a direct consequence:
mysqldump's `-p<value>` concatenated flag (`MYSQL_CONCAT_PASSWORD_FLAG`)
still threads `knownSafeTokens` correctly AT STAGE 1 (round-9 fix,
unchanged), but the resulting glued `-p<value>` token is now a flag-shaped
token stage 2 re-evaluates under the positive-match-only rule — since it is
neither an exact vocabulary member nor a canonical spelling, it now redacts
WHOLESALE even when the bare value (without the glued `-p`) is
vocabulary-known. This is the same accepted trade-off as any other
non-canonical flag, not a separate decision; the stage-1 fix remains
structurally correct at its own layer, it is simply no longer the deciding
factor for the final rendered output.

### HIGH ReDoS fix (finding 2 in the "Also required" list)

The gate measured polynomial blowup (~O(n^1.5-2)) in the FULL pipeline
against adversarial near-miss input (`"cr-ed-en-tial-X".repeat(n)`; 120KB
took 5.2s, 380KB ~23s) — a real DoS on the diagnostic path, since input
sources (recorded commands, hook summaries, caught errors) can carry
attacker-shaped text. No amount of regex micro-tuning closes this class for
arbitrary-length input, so `sanitizeFreeText` now caps its input to
`MAX_SANITIZE_INPUT_LENGTH` (8192 chars) BEFORE the pipeline runs — the cap
is what actually bounds runtime, not any one regex's own linear-time-ness
(every regex here already was individually linear-time; that alone never
bounded the FULL multi-pass pipeline against unbounded input). The
`[truncated]` marker is appended AFTER classification as a hardcoded
literal, not fed through `classifyToken` — an earlier draft glued it into
the pre-pipeline text and it got redacted along with everything else,
losing the user-visible signal that truncation occurred. Verified: the
above-cap adversarial shape now completes in ~13ms (was reported at 5.2s+
for smaller input); the exact 120KB repro now completes in ~12ms.

### Probes run

Full round-10/11/12 repro families (mixed-case and all-lowercase glued
secrets, double/triple separators, digit-interposed splits, mixed
dash/underscore runs) plus unprompted next-idiom probes (Cyrillic `а` and
fullwidth `ａ` lookalike letters in place of `a`) — every one redacts by
construction. Canonical bare-keyword flags (`--token`, `--api-key`, …)
still survive with zero vocabulary, matching the designed labeled-flag case.
An unrecognized flag survives only as an exact `knownSafeTokens` member.
Perf: adversarial input above the cap and the exact 120KB gate repro both
complete in ~10-15ms. An end-to-end test (`runWhyDiagnosis` →
`formatStallDiagnosis`) proves a synthetic secret glued into a recorded
hook-blocker command never reaches rendered output or the raw `--json`
diagnosis, closing finding 7 (qa, no prior e2e coverage).

### Residual disclosure

A labeled bare-word form (`pass-word: value`) now redacts the LABEL too —
`pass-word:` is not a recognized safe shape at stage 2 either (finding 6,
qa, LOW) — a safe-direction over-redaction, not a bug, documented in the
module header. The round-8 path/URL-segment residual and the new
round-12 input-cap residual (an attacker who controls both content and the
exact 8192-char cutoff could in principle craft a secret whose prefix
collides with a bounded safe shape at the cut point) remain narrow,
already-accepted trade-offs per this module's own doctrine — not worth
chasing further, since at most a bounded fixed-width fragment is ever at
risk and everything past the cut is unconditionally dropped.

## Round 13 — vocabulary source classification (round 12's inversion made the vocabulary load-bearing)

Round 12's fail-closed inversion held — three independent roles verified
every round-9..12 repro class closed, and the ReDoS fix measured 12-26ms.
Security found the NEXT layer down: round 12 made `knownSafeTokens`
(why-vocabulary.ts) the load-bearing trust boundary for flag/value survival,
but nothing had yet audited what actually FEEDS that vocabulary.

### 1. CRITICAL — vocabulary laundering via task ids

`buildKnownVocabulary` folded EVERY task id in the entire run
(blocked/review-blocked/duplicate/council-gated/seal-ready/respawn/owner-work/
sidecar) into `knownSafeTokens` unconditionally, BEFORE any per-cause scope
filtering. Task ids are agent/attacker-choosable, unbounded strings — the
gate live-verified that creating any unrelated task with a secret-shaped id
(e.g. `hunter2Aa1SuperSecret9`) makes that exact string a trusted vocabulary
member for the WHOLE diagnosis, surviving verbatim inside a COMPLETELY
UNRELATED task's free text (a hook-blocker command, a daemon reason, etc.).
Full verbatim leak through the primary output.

ROOT-CAUSE PRINCIPLE (same doctrine as round 12): the vocabulary may contain
ONLY code-authored/enum/machine-generated strings, plus exactly ONE bounded
exception — never a free-form, externally-choosable identifier. Every source
`buildKnownVocabulary` folds in is now classified (STATIC / MACHINE-GENERATED
/ the BOUNDED EXCEPTION `signals.scope.taskId` / FREE-FORM never added) — the
full table lives in `why-vocabulary.ts`'s own header and `buildKnownVocabulary`
doc comment. Every "sibling" task id/key (any task OTHER than the one the
operator explicitly asked about) is now excluded, including — deliberately,
per the manager's explicit instruction NOT to extend the exception to
siblings — a sidecar's own `taskId` (`hookBlocker.taskId`, `contextGuard.taskId`)
even though that sidecar's cause is itself scope-filtered before rendering:
the vocabulary is built ONCE, before any per-cause filtering, so granting it
trust there would reopen the exact same class through a narrower door.

Excluded task ids still APPEAR in the diagnosis: why-diagnosis.ts interpolates
every task id via `structured()`, which resolves evidence values AFTER
free-text sanitization and never consults `knownSafeTokens` — dropping a
sibling id from the vocabulary only stops it from ALSO rescuing an unrelated
free-text token elsewhere in the SAME diagnosis; it does not remove the id
from its own evidence.

Verified with the gate's exact repro (an unrelated blocked task's
secret-shaped id, a hook-blocker command for a DIFFERENT scoped task
mentioning that string) at both the pure `diagnoseStall` level and the full
`runWhyDiagnosis` → `formatStallDiagnosis`/`--json` entrypoint level — the
string no longer appears anywhere in either rendered form.

### 2. MEDIUM — static nextActions text rendered as all-redacted noise

`daemon_handoff_blocked`/`daemon_supervisor_blocked`'s recommended-fix
message is entirely code-authored (runtime.ts's execution-preflight
guidance, supervisor.ts's missing-review-actor hint) but was never tokenized
into the static vocabulary, so it rendered as near-total `[redacted]` noise
even though nothing in it is externally influenced. Fixed by extracting both
literal texts into a new, tiny, dependency-free module,
`src/daemon-guidance-text.ts` — deliberately NOT importing `runtime.ts` or
`daemon/supervisor.ts` directly into `why-vocabulary.ts` (a small, hot-path
diagnostic module), which would have pulled in their much heavier
db-preflight/doctor/supervisor-orchestration dependency graphs just for two
strings. `runtime.ts` and `daemon/supervisor.ts` now import their own
literal text FROM this shared module (single-sourced, never retyped);
`why-vocabulary.ts` tokenizes it the same way it already threads
`RECOMMENDED_COMMANDS`. The `daemon_handoff_blocked` case (single, static,
2-step array) now renders fully readable end to end. The `daemon_supervisor_
blocked` missing-review-actor hint renders its two fixed words ("provide",
"--review-actor") but the compound `<role>=<actor>` segment (role name
joined to a placeholder via "=", no independent whitespace boundary) still
redacts — an honest partial improvement, not a full fix, since that segment
is a genuinely dynamic, non-atomic token; changing the underlying message
FORMAT to give it its own token boundary was judged out of scope for a
vocabulary fix and would need its own review.

### 3. MEDIUM — unbounded task-id length (contributing cause)

Added `domain/contracts.ts`'s `MAX_TASK_ID_LENGTH = 64` (verified: the
longest real task key in this repo's history is 33 chars), enforced at both
creation-time validation sites: `validateTaskPacket` (used by
`createTaskGraph`) and `admin/init-task.ts`'s `buildInitiativeRecords`
(`VALID_TASK_ID` check), sharing the one constant. Deliberately minimal and
additive — no other behavior changed. Explicitly NOT extended to
`appendTasks` (`core/task-lifecycle.ts`): that function's own doc comment
enumerates exactly what it validates (duplicate task_key, missing dependency
edges, run existence) and does not call `validateTaskPacket` at all today —
a pre-existing gap, not introduced by this round, and out of scope for a
"small, additive" length-bound fix since closing it would be a real behavior
change (new rejection paths for existing callers) needing its own review.
Flagged here for a follow-up round, not silently carried.

### 4. LOWs

- Added a frozen max-lines ratchet entry for `why-redaction-keywords.ts`
  (150, at its current 143 lines) and the new `daemon-guidance-text.ts` (50)
  via `node scripts/generate-max-lines-ratchet.mjs` — regenerated cleanly,
  a 2-line pure addition with no unintended bumps to any other file's frozen
  entry (verified via `git diff --stat`).
- Case-sensitivity: `CANONICAL_BARE_SECRET_KEYWORD` (the round-12 bare-flag
  positive match) is case-INSENSITIVE; `knownSafeTokens` membership is
  case-SENSITIVE. Both are deliberate, now stated explicitly in
  `isSafeFlagName`'s doc comment: case-insensitivity for the canonical
  spelling is safe because `--TOKEN`/`--Password` are the SAME known keyword
  NAME in a different case, never a secret — unlike the vocabulary path, a
  fixed spelling carries no caller-supplied data for case to narrow.
- Fixed a stale `CODE_ADJACENT_KEYWORDS` comment reference (renamed to
  `CODE_ADJACENT_KEYWORD_ALTERNATION` in round 12) in
  `tests/admin-why-redaction.test.ts`.

### Probes run

The gate's exact CRITICAL repro (unrelated blocked task, secret-shaped id,
hook-blocker command for a different scoped task) at both the `diagnoseStall`
and `runWhyDiagnosis`/`--json` levels — the string no longer appears in
either. `daemon_handoff_blocked`'s recommended text renders fully readable
(no `[redacted]` at all). Round-9 through round-12's own repro suites all
still pass unchanged (this round touched vocabulary SOURCES, not the
redaction pipeline itself). Full suite: 3521 tests green, tsc clean, lint 0,
build:dist clean (208 files). `why-redaction.ts` holds its frozen 625-line
ratchet entry exactly.
