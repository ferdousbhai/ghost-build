-- Project, chat, deployment, skill, preview, feedback, and quota data now live
-- exclusively in each user's Cloudflare account. Existing central workload
-- data is intentionally discarded; Ghostbuild retains only identity, auth,
-- Cloudflare connection, and user-runtime locator metadata.

DROP TABLE IF EXISTS builder_previews;
DROP TABLE IF EXISTS builder_preview_build_admissions;
DROP TABLE IF EXISTS sandbox_cleanup_candidates;

DROP TABLE IF EXISTS deployment_security_inventory;
DROP TABLE IF EXISTS deployment_resources;
DROP TABLE IF EXISTS deployments;
DROP TABLE IF EXISTS cloudflare_billing_authorizations;

DROP TABLE IF EXISTS agent_gc_candidates;
DROP TABLE IF EXISTS object_gc_candidates;

DROP TABLE IF EXISTS thumbnail_objects;
DROP TABLE IF EXISTS thumbnail_upload_admissions;
DROP TABLE IF EXISTS thumbnail_reconciliation_state;

DROP TABLE IF EXISTS chat_backup_object_attributions;
DROP TABLE IF EXISTS chat_backup_objects;
DROP TABLE IF EXISTS chat_backup_admissions;
DROP TABLE IF EXISTS chat_backup_reconciliation_state;

DROP TABLE IF EXISTS social_shares;
DROP TABLE IF EXISTS shares;
DROP TABLE IF EXISTS chat_message_states;
DROP TABLE IF EXISTS chat_transcripts;
DROP TABLE IF EXISTS chats;

DROP TABLE IF EXISTS skill_sync_entries;
DROP TABLE IF EXISTS skill_sync_state;
DROP TABLE IF EXISTS feedback;

DROP TABLE IF EXISTS ai_usage_reservations;
DROP TABLE IF EXISTS ai_daily_usage;
