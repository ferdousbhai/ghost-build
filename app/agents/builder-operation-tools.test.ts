import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDeployment: vi.fn(),
}));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('~/server-handlers/deployments', () => ({
  createOrReplayDeploymentPlanForUser: mocks.createDeployment,
}));

import { executeBuilderOperationTool } from './builder-operation-tools';

describe('server Builder operation tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createDeployment.mockResolvedValue({
      id: '11111111-1111-5111-8111-111111111111',
      planDigest: 'b'.repeat(64),
      plan: { resources: [{ type: 'worker', logicalName: 'app', proposedName: 'app' }] },
    });
  });

  it('validates the exact durable backup in the user-owned runtime', async () => {
    const workspace = workspaceStub();
    const onValidationStage = vi.fn();
    const result = await executeBuilderOperationTool({
      context: { ...operationContext(), onValidationStage },
      workspace: workspace as never,
      toolCallId: 'validation-call',
      toolName: 'validateProject',
      input: {},
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        revision: 'a'.repeat(64),
        workspaceRevision: 7,
        buildEnvironment: 'user-cloudflare-sandbox',
      },
    });
    expect(workspace.validate).toHaveBeenCalledWith({ toolCallId: 'validation-call', input: {} });
    expect(onValidationStage.mock.calls).toEqual([
      ['validation-call', 'sandbox initialization'],
      ['validation-call', null],
    ]);
  });

  it('refuses deployment when the requested validation revision differs from the durable source', async () => {
    const workspace = workspaceStub();
    const result = await executeBuilderOperationTool({
      context: operationContext(),
      workspace: workspace as never,
      toolCallId: 'deploy-call',
      toolName: 'deploy',
      input: { validatedRevision: 'c'.repeat(64) },
    });

    expect(result).toMatchObject({
      ok: false,
      data: { state: 'validation-stale', currentRevision: 'a'.repeat(64) },
    });
    expect(mocks.createDeployment).not.toHaveBeenCalled();
  });

  it('prepares an idempotent deployment plan from the exact durably validated bytes', async () => {
    const workspace = workspaceStub();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);
    const result = await executeBuilderOperationTool({
      context: operationContext(),
      workspace: workspace as never,
      toolCallId: 'deploy-call',
      toolName: 'deploy',
      input: { validatedRevision: 'a'.repeat(64) },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        state: 'awaiting-approval',
        revision: 'a'.repeat(64),
        deployment: { id: '11111111-1111-5111-8111-111111111111' },
      },
    });
    expect(mocks.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        chatId: 'chat-1',
        deploymentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        projectId: 'agent-1',
        revision: 'a'.repeat(64),
        workspaceRevision: 7,
      }),
    );
  });
});

function workspaceStub() {
  const workspace = {
    getState: vi.fn(() => ({ initialized: true, revision: 7 })),
    checkpoint: vi.fn(async () => ({ workspaceRevision: 7, revision: 'a'.repeat(64) })),
    executeToolOnce: vi.fn(async (_id, _name, _args, execute: () => Promise<unknown>) => execute()),
    validate: vi.fn(async () => ({
      ok: true,
      message: 'validated',
      data: {
        revision: 'a'.repeat(64),
        workspaceRevision: 7,
        buildEnvironment: 'user-cloudflare-sandbox',
      },
    })),
    hasSuccessfulValidation: vi.fn(async () => false),
    prepareDeployment: vi.fn(async () => ({
      workspaceRevision: 7,
      revision: 'a'.repeat(64),
      project: { type: 'web_app', bindings: { ai: true, d1: true, r2: true, appAgent: true } },
    })),
  };
  return workspace;
}

function operationContext() {
  return {
    env: {} as Env,
    userId: 'user-1',
    chatInitialId: 'chat-1',
    agentName: 'agent-1',
  };
}
