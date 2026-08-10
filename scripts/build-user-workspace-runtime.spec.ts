import { describe, expect, test } from 'vitest';
import { USER_WORKSPACE_RUNTIME_SOURCE } from '../app/generated/user-workspace-runtime.generated';

describe('user workspace runtime bundle', () => {
  test('uses a stable Worker module URL for Node compatibility', () => {
    expect(USER_WORKSPACE_RUNTIME_SOURCE).toContain(
      'const require = __ghostbuildCreateRequire("file:///bundle/workspace-runtime.mjs")',
    );
    expect(USER_WORKSPACE_RUNTIME_SOURCE).not.toContain('import.meta.url');
    expect(USER_WORKSPACE_RUNTIME_SOURCE).not.toContain('./impl/format');
    expect(USER_WORKSPACE_RUNTIME_SOURCE).not.toContain('node:process');
    expect(USER_WORKSPACE_RUNTIME_SOURCE).not.toMatch(/\b[A-Za-z_$][\w$]*\(["'](?:node:)?process["']\)/);
    expect(USER_WORKSPACE_RUNTIME_SOURCE).not.toContain('fetch-blob');
  });
});
