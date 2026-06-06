update tasks
set required_reviews = array['reviewer', 'security_reviewer', 'qa_engineer']
where required_reviews is distinct from array['reviewer', 'security_reviewer', 'qa_engineer'];

update tasks
set payload = jsonb_set(
  payload,
  '{requiredReviews}',
  '["reviewer","security_reviewer","qa_engineer"]'::jsonb,
  true
)
where coalesce(payload -> 'requiredReviews', 'null'::jsonb) is distinct from '["reviewer","security_reviewer","qa_engineer"]'::jsonb;
