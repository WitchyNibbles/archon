-- qdrant_collection was required at creation time but Qdrant has been removed.
-- Give the column a safe default so new registrations succeed until phase 3 drops it.
alter table runtime_project_registrations
  alter column qdrant_collection set default '';
