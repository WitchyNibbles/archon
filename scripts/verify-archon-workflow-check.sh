#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
task_id="task-DG-001-fixture"
tmp_root="$(mktemp -d)"
fixture_root="$tmp_root/repo"

cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

mkdir -p \
  "$fixture_root/.codex" \
  "$fixture_root/.archon/templates" \
  "$fixture_root/.archon/work/briefs" \
  "$fixture_root/.archon/work/plans" \
  "$fixture_root/.archon/work/tasks" \
  "$fixture_root/.archon/work/reviews" \
  "$fixture_root/scripts"

git -C "$fixture_root" init -q

cat > "$fixture_root/.gitignore" <<'EOF'
.archon/postgres/
.codex/skills/
EOF

cp "$repo_root/AGENTS.md" "$fixture_root/AGENTS.md"
cp "$repo_root/.codex/config.toml" "$fixture_root/.codex/config.toml"

cat > "$fixture_root/.codex/hooks.json" <<'EOF'
{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"bash scripts/archon-session-start.sh"}]}]}}
EOF

cat > "$fixture_root/package.json" <<'EOF'
{"scripts":{"archon:check-workflow":"node --experimental-strip-types scripts/check-archon-workflow.ts"}}
EOF

cat > "$fixture_root/.archon/ACTIVE" <<EOF
task_id=$task_id
workflow=archon
state=active
EOF

cp "$repo_root/.archon/templates/intake-brief.md" "$fixture_root/.archon/templates/intake-brief.md"
cp "$repo_root/.archon/templates/task-packet.md" "$fixture_root/.archon/templates/task-packet.md"
cp "$repo_root/.archon/templates/review-gate.md" "$fixture_root/.archon/templates/review-gate.md"
cp "$repo_root/.archon/templates/coverage-manifest.json" "$fixture_root/.archon/templates/coverage-manifest.json"
cp "$repo_root/.archon/templates/checkpoint-summary.md" "$fixture_root/.archon/templates/checkpoint-summary.md"
cp "$repo_root/.archon/templates/progress-proof.json" "$fixture_root/.archon/templates/progress-proof.json"

cat > "$fixture_root/.archon/work/briefs/brief-$task_id.md" <<EOF
# Intake Brief

## Task ID

\`$task_id\`
EOF

cat > "$fixture_root/.archon/work/plans/plan-$task_id.md" <<EOF
# Plan

## Task ID

\`$task_id\`
EOF

for pair in "reviewer reviewer" "qa qa_engineer" "security security_reviewer"; do
  set -- $pair
  short_role="$1"
  full_role="$2"
  cat > "$fixture_root/.archon/work/reviews/review-$task_id-$short_role.md" <<EOF
# Review Gate

## Task ID

\`$task_id\`

## Reviewer role

\`$full_role\`

## Actor

\`${full_role}-actor\`

## Actor role

\`$full_role\`

## Provenance status

\`summary_only\`

## Review state

\`passed\`

## Severity

\`low\`

## Findings

Synthetic ${full_role} findings.

## Residual risk

Synthetic ${full_role} residual risk.

## Verification evidence

Synthetic ${full_role} verification evidence.

## Waiver authority

\`none\`

## Waiver reason

None.

## Decision

\`approved\`

## Source handoff

Synthetic ${full_role} output.
EOF
done

cp "$repo_root/scripts/check-archon-workflow.ts" "$fixture_root/scripts/check-archon-workflow.ts"

positive_output="$(node --experimental-strip-types "$fixture_root/scripts/check-archon-workflow.ts" --repo-root "$fixture_root" --task-id "$task_id")"
printf '%s\n' "$positive_output" | grep -Fq "archon workflow artifact check passed" || {
  printf 'positive fixture did not pass as expected\n' >&2
  exit 1
}

cat > "$fixture_root/.archon/work/reviews/review-$task_id-qa_engineer.md" <<EOF
# Review Gate

## Task ID

\`$task_id\`

## Reviewer role

\`qa_engineer\`

## Actor

\`release-manager\`

## Actor role

\`planner\`

## Provenance status

\`summary_only\`

## Review state

\`waived\`

## Severity

\`high\`

## Findings

Synthetic waived qa findings.

## Residual risk

Synthetic waived qa residual risk.

## Verification evidence

Synthetic waived qa verification evidence.

## Waiver authority

\`manager\`

## Waiver reason

Approved manager waiver for synthetic fixture.

## Decision

\`waived\`

## Source handoff

Synthetic waived qa output.
EOF
rm "$fixture_root/.archon/work/reviews/review-$task_id-qa.md"

waived_output="$(node --experimental-strip-types "$fixture_root/scripts/check-archon-workflow.ts" --repo-root "$fixture_root" --task-id "$task_id")"
printf '%s\n' "$waived_output" | grep -Fq "archon workflow artifact check passed" || {
  printf 'waived fixture did not pass as expected\n' >&2
  exit 1
}

cat > "$fixture_root/.archon/work/reviews/review-$task_id-security_reviewer.md" <<EOF
# Review Gate

## Task ID

\`$task_id\`

## Reviewer role

\`security_reviewer\`

## Actor

\`security-lead\`

## Actor role

\`security_reviewer\`

## Provenance status

\`runtime_verified\`

## Review state

\`waived\`

## Severity

\`critical\`

## Findings

Synthetic waived security findings.

## Residual risk

Critical risk accepted through documented security exception.

## Verification evidence

Synthetic waived security verification evidence.

## Waiver authority

\`security_exception\`

## Waiver reason

Approved security exception for synthetic fixture.

## Decision

\`waived\`

## Source handoff

Synthetic waived security output with runtime review citation.
EOF
rm "$fixture_root/.archon/work/reviews/review-$task_id-security.md"

security_waiver_output="$(node --experimental-strip-types "$fixture_root/scripts/check-archon-workflow.ts" --repo-root "$fixture_root" --task-id "$task_id")"
printf '%s\n' "$security_waiver_output" | grep -Fq "archon workflow artifact check passed" || {
  printf 'security waiver fixture did not pass as expected\n' >&2
  exit 1
}

cat > "$fixture_root/.archon/work/reviews/review-$task_id-security_reviewer.md" <<EOF
# Review Gate

## Task ID

\`$task_id\`

## Reviewer role

\`security_reviewer\`

## Actor

\`security-lead\`

## Actor role

\`security_reviewer\`

## Provenance status

\`summary_only\`

## Review state

\`passed\`

## Severity

\`high\`

## Findings

Synthetic high severity security findings.

## Residual risk

High severity passed security reviews must be rejected.

## Verification evidence

Synthetic high severity security verification evidence.

## Waiver authority

\`none\`

## Waiver reason

None.

## Decision

\`approved\`

## Source handoff

Synthetic high severity security output.
EOF

if node --experimental-strip-types "$fixture_root/scripts/check-archon-workflow.ts" --repo-root "$fixture_root" --task-id "$task_id" >/dev/null 2>&1; then
  printf 'high severity security review fixture unexpectedly passed\n' >&2
  exit 1
fi

cat > "$fixture_root/.archon/work/reviews/review-$task_id-security_reviewer.md" <<EOF
# Review Gate

## Task ID

\`$task_id\`

## Reviewer role

\`security_reviewer\`

## Actor

\`security-lead\`

## Actor role

\`security_reviewer\`

## Provenance status

\`summary_only\`

## Review state

\`passed\`

## Severity

\`critical\`

## Findings

Synthetic critical severity security findings.

## Residual risk

Critical severity passed security reviews must be rejected.

## Verification evidence

Synthetic critical severity security verification evidence.

## Waiver authority

\`none\`

## Waiver reason

None.

## Decision

\`approved\`

## Source handoff

Synthetic critical severity security output.
EOF

if node --experimental-strip-types "$fixture_root/scripts/check-archon-workflow.ts" --repo-root "$fixture_root" --task-id "$task_id" >/dev/null 2>&1; then
  printf 'critical severity security review fixture unexpectedly passed\n' >&2
  exit 1
fi

cat > "$fixture_root/.archon/work/reviews/review-$task_id-security_reviewer.md" <<EOF
# Review Gate

## Task ID

\`$task_id\`

## Reviewer role

\`security_reviewer\`

## Actor

\`security-lead\`

## Actor role

\`security_reviewer\`

## Provenance status

\`runtime_verified\`

## Review state

\`waived\`

## Severity

\`critical\`

## Findings

Synthetic waived security findings.

## Residual risk

Critical risk accepted through documented security exception.

## Verification evidence

Synthetic waived security verification evidence.

## Waiver authority

\`security_exception\`

## Waiver reason

Approved security exception for synthetic fixture.

## Decision

\`waived\`

## Source handoff

Synthetic waived security output with runtime review citation.
EOF

cat > "$fixture_root/.archon/work/reviews/review-$task_id-reviewer.md" <<EOF
# Review Gate

## Task ID

\`$task_id\`

## Reviewer role

\`reviewer\`

## Actor

\`reviewer-actor\`

## Actor role

\`reviewer\`

## Provenance status

\`summary_only\`

## Review state

\`waived\`

## Severity

\`low\`

## Findings

Synthetic invalid reviewer waiver.

## Residual risk

Reviewer waiver should require manager authority.

## Verification evidence

Synthetic invalid waiver evidence.

## Waiver authority

\`manager\`

## Waiver reason

Synthetic invalid reviewer waiver reason.

## Decision

\`waived\`

## Source handoff

Synthetic invalid reviewer waiver output.
EOF

if node --experimental-strip-types "$fixture_root/scripts/check-archon-workflow.ts" --repo-root "$fixture_root" --task-id "$task_id" >/dev/null 2>&1; then
  printf 'invalid reviewer waiver fixture unexpectedly passed\n' >&2
  exit 1
fi

cat > "$fixture_root/.archon/work/reviews/review-$task_id-reviewer.md" <<EOF
# Review Gate

## Task ID

\`$task_id\`

## Reviewer role

\`reviewer\`

## Actor

\`reviewer-actor\`

## Actor role

\`reviewer\`

## Provenance status

\`forged_authenticated\`

## Review state

\`passed\`

## Severity

\`critical\`

## Findings

Invalid provenance summary.

## Residual risk

Invalid provenance must fail contract validation.

## Verification evidence

Synthetic invalid provenance evidence.

## Waiver authority

\`none\`

## Waiver reason

None.

## Decision

\`approved\`

## Source handoff

Invalid provenance summary output.
EOF

if node --experimental-strip-types "$fixture_root/scripts/check-archon-workflow.ts" --repo-root "$fixture_root" --task-id "$task_id" >/dev/null 2>&1; then
  printf 'invalid provenance fixture unexpectedly passed\n' >&2
  exit 1
fi

cat > "$fixture_root/.archon/work/reviews/review-$task_id-reviewer.md" <<EOF
# Review Gate

## Task ID

\`$task_id\`

## Reviewer role

\`reviewer\`

## Actor

\`reviewer-actor\`

## Actor role

\`reviewer\`

## Provenance status

\`summary_only\`

## Review state

\`passed\`

## Severity

\`low\`

## Findings

Synthetic reviewer findings.

## Residual risk

Synthetic reviewer residual risk.

## Verification evidence

Synthetic reviewer verification evidence.

## Waiver authority

\`none\`

## Waiver reason

None.

## Decision

\`approved\`

## Source handoff

Synthetic reviewer output.
EOF

cat > "$fixture_root/.archon/work/briefs/brief-unrelated-task.md" <<'EOF'
# Intake Brief

## Task ID

`task-unrelated`
EOF

pass_with_unrelated="$(node --experimental-strip-types "$fixture_root/scripts/check-archon-workflow.ts" --repo-root "$fixture_root" --task-id "$task_id")"
printf '%s\n' "$pass_with_unrelated" | grep -Fq "archon workflow artifact check passed" || {
  printf 'unrelated-newer-artifact fixture did not pass as expected\n' >&2
  exit 1
}

rm "$fixture_root/.archon/work/reviews/review-$task_id-security_reviewer.md"
if node --experimental-strip-types "$fixture_root/scripts/check-archon-workflow.ts" --repo-root "$fixture_root" --task-id "$task_id" >/dev/null 2>&1; then
  printf 'negative fixture unexpectedly passed\n' >&2
  exit 1
fi

printf 'artifact-contract fixture verification passed for %s\n' "$task_id"
