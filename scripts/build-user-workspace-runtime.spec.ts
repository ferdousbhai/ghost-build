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

  test('tracks the exact non-streaming install command for cancellation', () => {
    const command =
      'pnpm install --lockfile-only --ignore-scripts=true --ignore-pnpmfile --registry=https://registry.npmjs.org/';
    const commandIndex = USER_WORKSPACE_RUNTIME_SOURCE.indexOf(command);
    expect(commandIndex).toBeGreaterThan(0);

    const installBoundary = USER_WORKSPACE_RUNTIME_SOURCE.slice(
      commandIndex - 600,
      commandIndex + command.length + 500,
    );
    expect(installBoundary).toContain('`tool:${');
    expect(installBoundary).toMatch(/\{id:[^,]+,cwd:/);
    expect(installBoundary).toContain('onHandle:');
  });
});
