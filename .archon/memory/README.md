# archon memory

This directory is the repo-local durable memory system for `archon`.

Why it exists:

- durable context should survive across threads
- memory must be reviewable
- repo policy should stay inspectable in git
- shared backend retrieval must not outrank reviewed project memory

Rules:

- keep secrets out
- store stable facts, not hopeful guesses
- update these files after meaningful work
- prefer small edits over noisy append-only logs
- include provenance from reviewed runs or tasks when relevant
- do not embed screenshots, traces, videos, or Playwright artifact payloads here; keep them under `.archon/work/artifacts/` and summarize them in text if needed
