ALTER TABLE cloudflare_connections
ADD COLUMN connection_generation INTEGER NOT NULL DEFAULT 1;

ALTER TABLE deployments
ADD COLUMN connection_generation INTEGER NOT NULL DEFAULT 1;
