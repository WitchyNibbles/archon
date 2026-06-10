alter table reviews
  drop constraint if exists reviews_identity_assurance_check;

alter table reviews
  add constraint reviews_identity_assurance_check
  check (identity_assurance in ('authenticated', 'legacy_backfill', 'seeded'));

alter table approvals
  drop constraint if exists approvals_identity_assurance_check;

alter table approvals
  add constraint approvals_identity_assurance_check
  check (identity_assurance in ('authenticated', 'legacy_backfill', 'seeded'));
