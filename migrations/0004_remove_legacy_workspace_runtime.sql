-- Clean-break launch migration: Computer is the only workspace runtime.
-- The retired locator table has no production readers or writers.
DROP TABLE user_workspace_runtimes;
