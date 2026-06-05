# Review Identity Policy

Review and waiver authority must come from authenticated principal binding, not from request-body role claims.

## Required rules

- authenticate the caller before invoking `recordReview`
- resolve review authority through `createReviewActionContextResolver(...)`
- resolve authenticated principals through a repo-owned adapter built with `createReviewPrincipalAdapter(...)` or an audited equivalent
- keep review identity bindings in a server-owned, reviewed file
- keep review identity fixtures in a reviewed file and run `npm run archon:verify:review-identity` before trusting review actions
- use `record-review` only with a live adapter module and a reviewed live bindings file
- when one adapter module exposes multiple reviewed backends, select exactly one live backend with `ARCHON_REVIEW_IDENTITY_BACKEND`
- bind each principal to explicit `actor` names, allowed review `roles`, and optional `waiverAuthorities`
- fail closed when the principal is unverified, missing, unbound, or requests an unauthorized review role
- treat waiver authority as narrow policy; do not infer it from general admin access
- store binding changes in git review like any other authz policy change

## Prohibited patterns

- trusting `actor`, `reviewerRole`, or waiver authority directly from request input
- deriving review authority from retrieval, memory, or unreviewed task artifacts
- using shipped template bindings or verification fixtures as live authority
- allowing one shared service principal to impersonate arbitrary review actors without static bindings
- leaving multiple live review backends configured without an explicit backend selection
- storing secrets, tokens, or IdP credentials in the bindings file

## Recommended file

- keep the reviewed mapping at `.archon/review-identity-bindings.json`
- seed it from `.archon/templates/review-identity-bindings.json`
- keep reviewed adapter fixtures at `.archon/review-identity-adapter.fixture.json`
- seed them from `.archon/templates/review-identity-adapter.fixture.json`

## Approval reminder

- binding changes alter authz behavior and should follow the repo approval rules for authn/authz model changes
