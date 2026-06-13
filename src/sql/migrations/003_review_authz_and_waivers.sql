alter table reviews
  add column if not exists actor text;

update reviews
set actor = reviewer_role
where actor is null;

alter table reviews
  alter column actor set not null;

alter table reviews
  add column if not exists actor_role text;

update reviews
set actor_role = reviewer_role
where actor_role is null;

alter table reviews
  alter column actor_role set not null;

alter table approvals
  add column if not exists actor_role text;

update approvals
set actor_role = actor
where actor_role is null;

alter table approvals
  alter column actor_role set not null;
