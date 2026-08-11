import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('generated application binding boundary', () => {
  test('exposes only application storage and never the protected agent security database', () => {
    const source = readFileSync('template/src/app-bindings.ts', 'utf8');

    expect(source).toContain('Pick<Env, "DB" | "APP_STORAGE" | "APP_CACHE">');
    expect(source).not.toContain('AGENT_SECURITY_DB');
  });

  test('keeps all agent security state out of application migrations', () => {
    const applicationMigration = readFileSync('template/migrations/0001_app_data.sql', 'utf8');
    const securityMigration = readFileSync('template/agent-security-migrations/0001_agent_security.sql', 'utf8');

    expect(applicationMigration).not.toMatch(/app_agent_(?:sessions|rate_limits)/);
    expect(securityMigration).toContain('CREATE TABLE app_agent_sessions');
    expect(securityMigration).toContain('CREATE TABLE app_agent_rate_limits');
  });
});
