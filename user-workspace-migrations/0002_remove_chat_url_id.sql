-- Chat identity is the immutable initial_id. Remove the unused alternate URL identity.
DROP INDEX idx_chats_active_url;
ALTER TABLE chats DROP COLUMN url_id;
