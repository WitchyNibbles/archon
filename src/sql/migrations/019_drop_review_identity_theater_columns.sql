-- Remove identity-theater provenance columns (P9 trust-model honesty).
--
-- The runtime records review/approval provenance in the `source` column
-- ("orchestrator" | "seed" | "self"). The legacy identity_assurance and
-- waiver_authority columns implied an authentication layer that never
-- existed; this migration backfills `source` from the legacy values and then
-- drops the legacy columns. Idempotent and safe on both fresh databases
-- (where the legacy columns never existed) and legacy databases.

alter table approvals
  add column if not exists source text;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'reviews'
      and column_name = 'identity_assurance'
  ) then
    update reviews set source = 'orchestrator'
    where source = 'self' and identity_assurance = 'authenticated';

    update reviews set source = 'seed'
    where source = 'self' and identity_assurance = 'seeded';

    alter table reviews drop constraint if exists reviews_identity_assurance_check;
    alter table reviews drop column identity_assurance;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'reviews'
      and column_name = 'waiver_authority'
  ) then
    alter table reviews drop constraint if exists reviews_waiver_authority_check;
    alter table reviews drop column waiver_authority;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'approvals'
      and column_name = 'identity_assurance'
  ) then
    update approvals
    set source = case identity_assurance
      when 'authenticated' then 'orchestrator'
      when 'seeded' then 'seed'
      else 'self'
    end
    where source is null;

    alter table approvals drop constraint if exists approvals_identity_assurance_check;
    alter table approvals drop column identity_assurance;
  end if;
end $$;

update approvals
set source = 'self'
where source is null;

alter table approvals
  alter column source set default 'self';

alter table approvals
  alter column source set not null;
