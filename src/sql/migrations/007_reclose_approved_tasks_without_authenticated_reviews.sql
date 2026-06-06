with satisfied_reviews as (
  select
    r.run_id,
    r.task_id,
    r.reviewer_role,
    bool_or(
      r.identity_assurance = 'authenticated'
      and (
        r.state = 'passed'
        or (
          r.state = 'waived'
          and r.waiver_reason is not null
          and (
            (r.waiver_authority = 'manager' and r.actor_role in ('planner', 'solution_architect') and r.reviewer_role in ('reviewer', 'qa_engineer'))
            or (r.waiver_authority = 'security_exception' and r.actor_role = 'security_reviewer' and r.reviewer_role = 'security_reviewer')
          )
        )
      )
    ) as satisfied
  from reviews r
  group by r.run_id, r.task_id, r.reviewer_role
),
tasks_missing_required_reviews as (
  select t.id
  from tasks t
  left join satisfied_reviews reviewer_gate
    on reviewer_gate.run_id = t.run_id
   and reviewer_gate.task_id = t.task_key
   and reviewer_gate.reviewer_role = 'reviewer'
  left join satisfied_reviews security_gate
    on security_gate.run_id = t.run_id
   and security_gate.task_id = t.task_key
   and security_gate.reviewer_role = 'security_reviewer'
  left join satisfied_reviews qa_gate
    on qa_gate.run_id = t.run_id
   and qa_gate.task_id = t.task_key
   and qa_gate.reviewer_role = 'qa_engineer'
  where t.status = 'approved'
    and (
      coalesce(reviewer_gate.satisfied, false) = false
      or coalesce(security_gate.satisfied, false) = false
      or coalesce(qa_gate.satisfied, false) = false
    )
)
update tasks
set status = 'review_blocked',
    updated_at = now()
where id in (select id from tasks_missing_required_reviews);
