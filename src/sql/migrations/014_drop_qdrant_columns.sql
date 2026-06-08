-- Complete Qdrant removal: drop legacy columns from runtime_project_registrations.
-- Migration 013 set qdrant_collection default '' to keep existing code safe.
-- Now drop both columns entirely.
alter table runtime_project_registrations
  drop column if exists qdrant_url,
  drop column if exists qdrant_collection;
