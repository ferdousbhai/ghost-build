import { readFileSync } from 'node:fs';
import { createAITools, type CreateAIToolsOptions } from '@cloudflare/computer/tools';
import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import {
  CLOUDFLARE_COMPUTER_VERSION,
  GENERATED_PROJECT_PNPM_VERSION,
  COMPUTER_AI_TOOL_OPTIONS,
  COMPUTER_DEFAULT_SHELL_BACKEND,
  COMPUTER_EXEC_APPLICATION_POLICY,
  COMPUTER_SHELL_BACKEND_IDS,
  COMPUTER_SHELL_TOOL_OPTIONS,
  COMPUTER_TOOL_LIMITS,
  COMPUTER_TOOL_NAMES,
  computerSyncUnconfirmedToolResult,
} from './cloudflare-computer.js';

const EXPECTED_TOOL_SCHEMA = {
  edit: { properties: ['edits', 'path'], required: ['path', 'edits'] },
  exec: { properties: ['backend', 'command', 'cwd'], required: ['command'] },
  ls: { properties: ['path'], required: ['path'] },
  read: { properties: ['limit', 'offset', 'path'], required: ['path'] },
  write: { properties: ['content', 'path'], required: ['path', 'content'] },
} as const;

type SchemaTool = { inputSchema?: unknown };

describe('Cloudflare Computer preview contract', () => {
  it('recognizes both thrown and official wrapped pending-sync failures', () => {
    const message = '[workspace_sync_pending] Computer synchronization is pending.';
    expect(computerSyncUnconfirmedToolResult(new Error(message))).toMatchObject({
      status: 'pending',
      acknowledgement: 'pending',
    });
    expect(computerSyncUnconfirmedToolResult({ error: message })).toMatchObject({
      code: 'workspace_sync_pending',
      error: message,
    });
    expect(computerSyncUnconfirmedToolResult({ error: 'ordinary failure' })).toBeNull();
  });
  it('pins the reviewed preview package in dependency and release-age configuration', () => {
    const rootPackage = jsonFile<{ dependencies?: Record<string, string>; packageManager?: string }>('../package.json');
    const installedPackage = jsonFile<{ version?: string }>('../node_modules/@cloudflare/computer/package.json');
    const workspaceConfig = textFile('../pnpm-workspace.yaml');
    const installedReadme = textFile('../node_modules/@cloudflare/computer/README.md');

    expect(rootPackage.dependencies?.['@cloudflare/computer']).toBe(CLOUDFLARE_COMPUTER_VERSION);
    expect(rootPackage.packageManager).toBe(`pnpm@${GENERATED_PROJECT_PNPM_VERSION}`);
    expect(installedPackage.version).toBe(CLOUDFLARE_COMPUTER_VERSION);
    expect(workspaceConfig).toContain(`'@cloudflare/computer@${CLOUDFLARE_COMPUTER_VERSION}'`);
    expect(installedReadme).toContain('**PREVIEW ONLY.**');
    expect(installedReadme).toContain('production use at this time.');
  });

  it('canaries the published AI SDK tool names and input schemas', () => {
    const tools = createAITools({
      workspace: workspaceStub(),
      ...COMPUTER_AI_TOOL_OPTIONS,
    });

    expect(Object.keys(tools).sort()).toEqual([...COMPUTER_TOOL_NAMES].sort());
    for (const [toolName, expected] of Object.entries(EXPECTED_TOOL_SCHEMA)) {
      const schema = jsonSchema(requireTool(tools[toolName], toolName));
      expect(Object.keys(schema.properties ?? {}).sort(), toolName).toEqual([...expected.properties].sort());
      expect(schema.required, toolName).toEqual(expected.required);
    }

    const execSchema = jsonSchema(requireTool(tools.exec, 'exec'));
    expect(execSchema.properties?.backend?.enum).toEqual(COMPUTER_SHELL_BACKEND_IDS);
  });

  it('keeps backend selection explicit and inspection-only mode non-executable', () => {
    expect(COMPUTER_AI_TOOL_OPTIONS).toMatchObject({
      assets: false,
      read: {
        maxBytes: COMPUTER_TOOL_LIMITS.readMaxBytes,
        maxLines: COMPUTER_TOOL_LIMITS.readMaxLines,
      },
      write: { maxBytes: COMPUTER_TOOL_LIMITS.mutationMaxBytes },
      edit: { maxBytes: COMPUTER_TOOL_LIMITS.mutationMaxBytes },
      shell: { maxBytes: COMPUTER_TOOL_LIMITS.execMaxBytesPerStream },
    });
    expect(COMPUTER_SHELL_TOOL_OPTIONS.defaultBackend).toBe(COMPUTER_DEFAULT_SHELL_BACKEND);
    expect(Object.keys(COMPUTER_SHELL_TOOL_OPTIONS.backends)).toEqual(COMPUTER_SHELL_BACKEND_IDS);
    expect(
      Object.values(COMPUTER_SHELL_TOOL_OPTIONS.backends).every(({ description }) => description.length >= 80),
    ).toBe(true);
    expect(COMPUTER_SHELL_TOOL_OPTIONS.backends['container-shell'].description).toContain('public network access');
    expect(COMPUTER_SHELL_TOOL_OPTIONS.backends['container-shell'].description).toContain('pnpm');
    expect(COMPUTER_EXEC_APPLICATION_POLICY).toContain('Do not start dev, preview, watch');
    expect(COMPUTER_EXEC_APPLICATION_POLICY).toContain('Ghostbuild manages previews after validation');

    const readonlyTools = createAITools({ workspace: workspaceStub(), readonly: true });
    expect(Object.keys(readonlyTools).sort()).toEqual(['ls', 'read']);
  });
});

function workspaceStub(): CreateAIToolsOptions['workspace'] {
  return {} as CreateAIToolsOptions['workspace'];
}

function requireTool<T extends SchemaTool>(tool: T | undefined, name: string): T {
  if (!tool) {
    throw new Error(`Cloudflare Computer did not expose ${name}.`);
  }
  return tool;
}

function jsonSchema(tool: SchemaTool): {
  properties?: Record<string, { enum?: string[] }>;
  required?: string[];
} {
  return schemaJson(tool.inputSchema as ZodType);
}

function schemaJson(schema: ZodType): {
  properties?: Record<string, { enum?: string[] }>;
  required?: string[];
} {
  return z.toJSONSchema(schema) as {
    properties?: Record<string, { enum?: string[] }>;
    required?: string[];
  };
}

function jsonFile<T>(path: string): T {
  return JSON.parse(textFile(path)) as T;
}

function textFile(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}
