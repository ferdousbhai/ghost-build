import { describe, expect, it, vi } from 'vitest';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { CloudflareMcpModelToolContext } from './cloudflare-mcp-model-tools';
import { createPiToolBundle } from './pi-tools-adapter';

// SAFETY: tool adaptation is under test; no workspace-backed tool is executed in this suite.
const workspace = {} as BuilderWorkspaceApi;
const operationContext = { runWithKeepAlive: <T>(operation: () => Promise<T>) => operation() };

function context(): CloudflareMcpModelToolContext {
  return {
    accountId: 'account-1',
    executeEnabled: true,
    docs: vi.fn<CloudflareMcpModelToolContext['docs']>(),
    search: vi.fn<CloudflareMcpModelToolContext['search']>(),
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

describe('Pi Cloudflare MCP tool adapter', () => {
  it('adapts only admitted optional tools and preserves the Pi tool-call id in a proposal', async () => {
    const withoutMcp = createPiToolBundle(workspace, operationContext);
    expect(withoutMcp.cloudflare_docs).toBeUndefined();
    expect(withoutMcp.cloudflare_execute).toBeUndefined();

    const cloudflareMcp = context();
    const tools = createPiToolBundle(workspace, operationContext, undefined, cloudflareMcp);
    const execute = tools.cloudflare_execute;
    if (!execute) {
      throw new Error('Expected the admitted Cloudflare execute tool.');
    }
    const result = await execute.execute('pi-tool-call-1', { code: 'return mutate()' });

    expect(result.details).toMatchObject({
      kind: 'cloudflare_execute_proposal',
      toolCallId: 'pi-tool-call-1',
      accountId: 'account-1',
    });
  });
});
