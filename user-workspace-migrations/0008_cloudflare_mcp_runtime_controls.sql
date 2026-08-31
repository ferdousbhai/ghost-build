-- Fail-closed rollout controls for the official Cloudflare MCP integration.
-- Documentation and search can ship for provider-confirmed grants. Execute and
-- every high-impact class remain disabled until an operator deliberately enables them.
INSERT INTO runtime_controls (key, enabled, reason, updated_at) VALUES
  ('cloudflare_mcp', 1, NULL, unixepoch() * 1000),
  ('cloudflare_mcp_execute', 0, 'Approval-gated MCP execution is awaiting rollout.', unixepoch() * 1000),
  ('cloudflare_mcp_billable', 0, 'Billable MCP operations are not enabled.', unixepoch() * 1000),
  ('cloudflare_mcp_credentials', 0, 'Credential and identity MCP operations are not enabled.', unixepoch() * 1000),
  ('cloudflare_mcp_registrar', 0, 'Registrar MCP operations are not enabled.', unixepoch() * 1000);
