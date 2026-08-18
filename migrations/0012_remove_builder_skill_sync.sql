-- Builder skills are no longer mirrored. Cloudflare's own documentation is retrieved live
-- through the docs_search tool, framework skills are read from the project's installed
-- packages, and the one skill Ghostbuild maintains ships in the Worker bundle, so nothing
-- publishes a generation and there is no lease or run history to keep.
DROP TABLE builder_skill_sync_runs;

DROP TABLE builder_skill_sync_state;

DELETE FROM daily_maintenance_jobs WHERE job = 'builder-skill-sync';
