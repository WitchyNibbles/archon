alter table handoffs
  add column if not exists owner_role text not null default 'planner',
  add column if not exists completion_standard text not null default 'artifact_complete',
  add column if not exists execution_evidence text[] not null default '{}',
  add column if not exists quality_gate_evidence text[] not null default '{}';
