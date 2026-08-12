import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDeployment: vi.fn(),
}));

vi.mock('~/server-handlers/deployments', () => ({
  createOrReplayDeploymentPlanForUser: mocks.createDeployment,
}));

import { prepareDeploymentPlanForBuilder, validatedDeploymentCheckpoint } from './builder-deployment-command';

describe('builder deployment command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createDeployment.mockResolvedValue({
      id: '11111111-1111-5111-8111-111111111111',
      planDigest: 'b'.repeat(64),
      plan: { resources: [{ type: 'worker', logicalName: 'app', proposedName: 'app' }] },
    });
  });

  it('reports readiness only for the exact checkpoint with a durable validation receipt', async () => {
    const workspace = workspaceStub();

    await expect(validatedDeploymentCheckpoint(workspace as never)).resolves.toBeNull();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);
    await expect(validatedDeploymentCheckpoint(workspace as never)).resolves.toEqual({
      workspaceRevision: 7,
      revision: 'a'.repeat(64),
    });
  });

  it('refuses a plan when the requested validation revision is stale', async () => {
    const workspace = workspaceStub();
    const result = await prepareDeploymentPlanForBuilder({
      context: operationContext(),
      workspace: workspace as never,
      toolCallId: 'deploy-command',
      validatedRevision: 'c'.repeat(64),
    });

    expect(result).toMatchObject({
      ok: false,
      data: { state: 'validation-stale', currentRevision: 'a'.repeat(64) },
    });
    expect(mocks.createDeployment).not.toHaveBeenCalled();
  });

  it('prepares an idempotent approval plan from exact validated bytes', async () => {
    const workspace = workspaceStub();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);
    const result = await prepareDeploymentPlanForBuilder({
      context: operationContext(),
      workspace: workspace as never,
      toolCallId: 'deploy-command',
      validatedRevision: 'a'.repeat(64),
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
        projectId: 'workspace-1',
        revision: 'a'.repeat(64),
        workspaceRevision: 7,
      }),
    );
  });
});

function workspaceStub() {
  return {
    projectId: 'workspace-1',
    checkpoint: vi.fn(async () => ({ workspaceRevision: 7, revision: 'a'.repeat(64) })),
    executeToolOnce: vi.fn(async (_id, _name, _args, execute: () => Promise<unknown>) => execute()),
    hasSuccessfulValidation: vi.fn(async () => false),
    prepareDeployment: vi.fn(async () => ({
      workspaceRevision: 7,
      revision: 'a'.repeat(64),
      project: { type: 'web_app', bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true } },
    })),
  };
}

function operationContext() {
  return {
    env: {} as Env,
    userId: 'user-1',
    chatInitialId: 'chat-1',
    agentName: 'agent-1',
  };
}
