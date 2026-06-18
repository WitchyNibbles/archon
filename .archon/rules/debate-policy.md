# Debate Policy

## Purpose

Define when multi-perspective debate is required, how debates are structured,
and how outcomes are recorded.

## Trigger conditions

A debate session is REQUIRED when any of the following apply:

- The task involves an architectural decision affecting two or more modules.
- The proposed approach has been flagged with a security or reliability concern.
- Two or more team members have expressed conflicting implementation preferences.
- The Design and Architecture Council has requested deliberation as a condition
  of `approved_with_conditions`.

A debate is OPTIONAL (but recommended) when:

- Choosing between two implementation strategies with similar effort estimates.
- Selecting a third-party library that will be a long-term dependency.

## Debate structure

### Roles

Every debate must assign:

| Seat             | Responsibility                                                |
|------------------|---------------------------------------------------------------|
| `proposer`       | Presents the preferred approach with rationale                |
| `critic`         | Argues the strongest case AGAINST the proposer's approach     |
| `dissent_owner`  | Must raise at least one serious alternative                   |
| `synthesiser`    | Produces the final outcome summary; breaks ties               |

Roles may be filled by agent sub-threads or by the orchestrator cycling through
each role sequentially. The same agent must NOT fill both `proposer` and `critic`.

### Rounds

1. **Opening** — proposer states the approach, constraints, and success criteria.
2. **Challenge** — critic identifies the top three risks or failure modes.
3. **Alternatives** — dissent_owner presents at least one alternative; proposer
   may rebut.
4. **Synthesis** — synthesiser records the agreed outcome or escalates.

### Time-boxing

Each round is limited to one agent turn. The debate must complete within four
turns total. If no consensus is reached after four turns, the synthesiser MUST
escalate to the user with a summary of the unresolved points.

## Outcomes

| Outcome              | Meaning                                                   |
|----------------------|-----------------------------------------------------------|
| `consensus`          | All parties accept the proposer's approach                |
| `consensus_modified` | Proposer's approach adopted with critic's amendments      |
| `alternative_chosen` | Dissent owner's alternative adopted instead               |
| `escalated`          | No consensus; user input required before proceeding       |

## Recording

The debate outcome must be written to the active task's brief or plan document
under a `## Debate outcome` section before implementation begins. Required fields:

- `outcome` (one of the four values above)
- `chosen_approach` — one-sentence description
- `key_risks_accepted` — list of known risks the team accepts
- `dissent_on_record` — any unresolved objection the critic or dissent_owner
  wishes to record permanently

## Anti-patterns

- Do NOT use debate to delay a trivially correct decision.
- Do NOT record a debate outcome without running all four rounds.
- Do NOT allow the proposer to also write the synthesis.
- Do NOT skip the dissent_owner role — at least one alternative must be voiced.
