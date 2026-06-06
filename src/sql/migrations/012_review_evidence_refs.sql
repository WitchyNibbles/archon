alter table reviews
  add column if not exists evidence_refs text[] not null default '{}';
