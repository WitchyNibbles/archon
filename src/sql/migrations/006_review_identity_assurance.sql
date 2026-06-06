alter table reviews
  add column if not exists identity_assurance text;

update reviews
set identity_assurance = 'legacy_backfill'
where identity_assurance is null;

alter table reviews
  alter column identity_assurance set not null;

alter table reviews
  drop constraint if exists reviews_identity_assurance_check;

alter table reviews
  add constraint reviews_identity_assurance_check
  check (identity_assurance in ('authenticated', 'legacy_backfill'));

alter table approvals
  add column if not exists identity_assurance text;

update approvals
set identity_assurance = 'legacy_backfill'
where identity_assurance is null;

alter table approvals
  alter column identity_assurance set not null;

alter table approvals
  drop constraint if exists approvals_identity_assurance_check;

alter table approvals
  add constraint approvals_identity_assurance_check
  check (identity_assurance in ('authenticated', 'legacy_backfill'));
