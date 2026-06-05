# Memory Promotion Rules

Promote durable memory only when:

- the work was reviewed
- the entry has a source run or task
- the entry is stable enough to matter later
- the entry does not contain secrets
- the entry does not describe future behavior as if already true
- the entry is useful beyond one thread
- the entry can be traced back to a reviewed artifact or decision

Promotion notes:

- mark when newer guidance supersedes older guidance
- call out contradictions instead of silently flattening them
- add freshness caveats when a statement may age poorly
- keep retrieval-derived hints out of durable memory unless they were re-anchored in reviewed repo evidence

Store working memory in the shared backend. Store reviewed durable memory in repo markdown.
