# Design And Architecture Council Policy

Use this rule for substantive roadmap, governance, architecture-significant, or user-flow-heavy work that needs stronger design critique before implementation starts.

## Purpose

- prevent shallow design decisions
- reduce yes-man behavior and hidden deference
- force alternatives, dissent, and written reasoning early
- keep governance bounded so delivery continues

## Trigger rules

Require `Design and Architecture Council` review when any of these are true:

- the task changes shared architecture, governance, or reusable framework behavior
- the task introduces a new control-layer pattern, workflow, or operator-visible decision model
- the task changes a broad user-facing flow, interaction, or design surface
- the task crosses product, architecture, UX, and operational boundaries
- the manager judges the work high-ambiguity, high-rework-risk, or likely to attract passive agreement

Bypass the council when all of these are true:

- the task is trivial or mechanical
- the task is a tightly local bug fix with low decision ambiguity
- or the task inherits an approved parent council decision and stays inside its boundary

## Membership

- use a rotating 3-5 role panel
- include `solution_architect`
- include `product_strategist`
- include `frontend_designer` when a human-facing surface exists
- include `infra_engineer` or `security_reviewer` when the main risk is operational or security-heavy
- include a rotating `reviewer` or `qa_engineer` seat when critique quality or verification risk is material
- the manager/root thread acts as shepherd, not sole decider

## Required packet

Before council review, the owner must provide a written decision packet with:

- problem, user, value, and urgency
- proposal summary
- at least two alternatives, including one conservative option
- evidence references
- counter-evidence and uncertainty
- architecture or design consequences
- rollback or reversal path
- explicit council question

Use an ADR-style packet for architecture-significant work. Use a scenario-driven critique packet for user-facing design work.

## Dissent requirement

- every council review must assign one `dissent owner`
- the dissent owner must argue for at least one serious alternative
- the dissent owner must call out the strongest failure mode in the leading proposal
- unresolved objections must be recorded explicitly

## Timeboxes

- async read and comment window: default 24 hours
- synchronous discussion if needed: default 30 to 45 minutes
- rework rounds: maximum 2 before escalation

## Outcomes

Allowed outcomes:

- `approved`
- `approved_with_conditions`
- `rework_required`
- `exception_granted`
- `rejected`

`approved_with_conditions` must name owners and follow-up checks.

`exception_granted` must include:

- reason
- owner
- expiry date
- follow-up path

Exceptions must not be indefinite.

## User-intent rule

- the council may propose a change in direction
- the council must not silently override user intent
- if the recommendation would materially change user intent, bring the tradeoff to the user and wait for acceptance

## Escalation

If the council completes two rework rounds without convergence:

- the shepherd writes a synthesis of the disagreement
- the manager chooses a bounded path when user intent is already clear and the disagreement is implementation-level
- otherwise surface the tradeoff to the user

## Relationship to existing gates

- council review is a pre-implementation quality gate, not a replacement for `reviewer`, `qa_engineer`, or `security_reviewer`
- authenticated completion authority still comes from the runtime workflow contract and required review gates
