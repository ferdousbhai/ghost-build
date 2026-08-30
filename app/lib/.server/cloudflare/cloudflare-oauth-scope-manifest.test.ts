import { describe, expect, test } from 'vitest';
import {
  BROAD_CLOUDFLARE_OAUTH_SCOPES,
  capabilitiesFromOAuthScopes,
  cloudflareOAuthScopeGrantStatus,
  CORE_CLOUDFLARE_OAUTH_SCOPES,
  missingCoreOAuthScopes,
  parseReportedOAuthScopes,
  requestedCloudflareOAuthScopes,
} from './cloudflare-oauth-scope-manifest';

describe('cloudflare-oauth-scope-manifest', () => {
  test('requests a stable, deduplicated core-then-broad scope order', () => {
    const requested = requestedCloudflareOAuthScopes();
    expect(requested).toEqual([...new Set(requested)]);
    expect(requested.slice(0, CORE_CLOUDFLARE_OAUTH_SCOPES.length)).toEqual([...CORE_CLOUDFLARE_OAUTH_SCOPES]);
    expect(requested).not.toContain('offline_access');
  });

  test('normalizes a provider-reported scope string and drops offline_access', () => {
    const reported = `offline_access ${CORE_CLOUDFLARE_OAUTH_SCOPES.join('  ')} d1.write`;
    expect(parseReportedOAuthScopes(reported)).toEqual({ granted: [...CORE_CLOUDFLARE_OAUTH_SCOPES] });
  });

  test('rejects scope IDs outside the reviewed manifest instead of storing them', () => {
    expect(parseReportedOAuthScopes('d1.write registrar.write')).toEqual({ unknownScopes: ['registrar.write'] });
  });

  test('names every missing core scope', () => {
    expect(missingCoreOAuthScopes(CORE_CLOUDFLARE_OAUTH_SCOPES.filter((scope) => scope !== 'd1.write'))).toEqual([
      'd1.write',
    ]);
    expect(missingCoreOAuthScopes([...CORE_CLOUDFLARE_OAUTH_SCOPES])).toEqual([]);
  });

  test('grant status is core for a complete grant while the broad profile is empty', () => {
    // 'full' and 'partial' only exist once the Phase 0 preflight lands broad optional scopes.
    expect(BROAD_CLOUDFLARE_OAUTH_SCOPES).toEqual([]);
    expect(cloudflareOAuthScopeGrantStatus([...CORE_CLOUDFLARE_OAUTH_SCOPES])).toBe('core');
    expect(cloudflareOAuthScopeGrantStatus([])).toBe('unknown');
    expect(cloudflareOAuthScopeGrantStatus(['d1.write'])).toBe('unknown');
  });

  test('derives product capabilities only from scopes the grant fully covers', () => {
    expect(capabilitiesFromOAuthScopes([...CORE_CLOUDFLARE_OAUTH_SCOPES])).toEqual([
      'workers',
      'containers',
      'd1',
      'r2',
      'kv',
      'durable_objects',
      'workers_ai',
    ]);
    expect(capabilitiesFromOAuthScopes(['workers-scripts.write', 'ai.read'])).toEqual([
      'workers',
      'durable_objects',
      'workers_ai',
    ]);
    expect(capabilitiesFromOAuthScopes([])).toEqual([]);
  });
});
