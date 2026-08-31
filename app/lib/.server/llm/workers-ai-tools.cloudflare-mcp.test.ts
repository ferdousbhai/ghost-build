import { describe, expect, it, vi } from 'vitest';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { CloudflareMcpModelToolContext } from './cloudflare-mcp-model-tools';
import { createWorkersAiTools } from './workers-ai-tools';

// SAFETY: tool construction is under test; no workspace-backed tool is executed in this suite.
const workspace = {} as BuilderWorkspaceApi;
const operationContext = { runWithKeepAlive: <T>(operation: () => Promise<T>) => operation() };

function mcpContext(executeEnabled = true): CloudflareMcpModelToolContext {
  return {
    accountId: 'account-1',
    executeEnabled,
    docs: vi.fn<CloudflareMcpModelToolContext['docs']>(async () => ({
      kind: 'cloudflare_mcp_result',
      operation: 'docs',
      status: 'success',
      accountId: 'account-1',
      content: 'documentation result',
      requestId: 'request-docs',
      httpStatus: 200,
      truncated: false,
    })),
    search: vi.fn<CloudflareMcpModelToolContext['search']>(async () => ({
      kind: 'cloudflare_mcp_result',
      operation: 'search',
      status: 'insufficient_scope',
      accountId: 'account-1',
      content: 'A broader OAuth scope is required.',
      requestId: 'request-search',
      httpStatus: 403,
      truncated: false,
    })),
    proposeExecute: vi.fn<CloudflareMcpModelToolContext['proposeExecute']>(async (input, options) => ({
      kind: 'cloudflare_execute_proposal',
      status: 'awaiting_approval',
      executionId: 'execution-1',
      toolCallId: options.toolCallId,
      accountId: 'account-1',
      code: input.code,
      proposalSha256: 'a'.repeat(64),
      riskNote: 'risk',
      expiresAt: Date.now() + 60_000,
    })),
  };
}

describe('canonical Cloudflare MCP tools', () => {
  it('returns bounded docs success and search insufficient-scope results without the workspace lane', async () => {
    const cloudflareMcp = mcpContext();
    const tools = createWorkersAiTools(workspace, operationContext, undefined, cloudflareMcp);

    await expect(
      tools.cloudflare_docs?.execute?.({ query: 'Durable Objects SQL' }, { toolCallId: 'docs-1' }),
    ).resolves.toMatchObject({ status: 'success', content: 'documentation result' });
    await expect(
      tools.cloudflare_search?.execute?.({ code: 'return await client.listZones()' }, { toolCallId: 'search-1' }),
    ).resolves.toMatchObject({ status: 'insufficient_scope', httpStatus: 403 });
    expect(cloudflareMcp.docs).toHaveBeenCalledOnce();
    expect(cloudflareMcp.search).toHaveBeenCalledOnce();
  });

  it('offers execute only when its runtime controls admit it and rejects model-supplied account references', async () => {
    const disabled = createWorkersAiTools(workspace, operationContext, undefined, mcpContext(false));
    expect(disabled.cloudflare_docs).toBeDefined();
    expect(disabled.cloudflare_search).toBeDefined();
    expect(disabled.cloudflare_execute).toBeUndefined();

    const cloudflareMcp = mcpContext(true);
    const enabled = createWorkersAiTools(workspace, operationContext, undefined, cloudflareMcp);
    await expect(
      enabled.cloudflare_execute?.execute?.(
        { code: 'return await client.deleteZone()', account_id: 'attacker-account' },
        { toolCallId: 'execute-1' },
      ),
    ).rejects.toThrow();
    expect(cloudflareMcp.proposeExecute).not.toHaveBeenCalled();
  });

  it('does not offer any MCP tool when admission is absent', () => {
    const tools = createWorkersAiTools(workspace, operationContext);
    expect(tools.cloudflare_docs).toBeUndefined();
    expect(tools.cloudflare_search).toBeUndefined();
    expect(tools.cloudflare_execute).toBeUndefined();
  });
});
