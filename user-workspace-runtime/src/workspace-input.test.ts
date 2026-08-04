import { describe, expect, it } from 'vitest';
import { requireDeploymentMigrationName, requireWorkspaceFileEncoding } from './workspace-input';

describe('workspace input validation', () => {
  it('defaults an omitted file encoding but rejects invalid explicit values', () => {
    expect(requireWorkspaceFileEncoding(undefined)).toBe('utf8');
    expect(requireWorkspaceFileEncoding('utf8')).toBe('utf8');
    expect(requireWorkspaceFileEncoding('base64')).toBe('base64');
    expect(() => requireWorkspaceFileEncoding('binary')).toThrow('Invalid workspace file encoding');
  });

  it('rejects files that deployment would otherwise omit from a migration directory', () => {
    expect(requireDeploymentMigrationName('0001_app_data.sql')).toBe('0001_app_data.sql');
    expect(() => requireDeploymentMigrationName('README.md')).toThrow('invalid filename');
    expect(() => requireDeploymentMigrationName('nested/0001_app_data.sql')).toThrow('invalid filename');
  });
});
