-- Preserve the authenticated user after the one-time OAuth code exchange so a
-- transient session-write failure can resume without exchanging the code again.
ALTER TABLE cloudflare_oauth_states
ADD COLUMN authenticated_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL;
