import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDeployment: vi.fn(),
  deployForUser: vi.fn(),
  terminalizeInterrupted: vi.fn(),
}));

vi.mock('~/server-handlers/deployments', () => ({
  createOrReplayDeploymentPlanForUser: mocks.createDeployment,
  deployForUser: mocks.deployForUser,
  terminalizeInterruptedDeploymentForUser: mocks.terminalizeInterrupted,
}));

import {
  deployValidatedRevisionForBuilder,
  terminalizeInterruptedDeploymentForBuilder,
  validatedDeploymentCheckpoint,
} from './builder-deployment-command';

describe('builder deployment command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createDeployment.mockResolvedValue({ id: '11111111-1111-5111-8111-111111111111', status: 'approved' });
    mocks.deployForUser.mockResolvedValue({
      id: '11111111-1111-5111-8111-111111111111',
      status: 'succeeded',
      productionUrl: 'https://app.example.com',
      error: null,
    });
    mocks.terminalizeInterrupted.mockResolvedValue({
      id: '11111111-1111-5111-8111-111111111111',
      status: 'failed',
      productionUrl: null,
      error: { message: 'Deployment was interrupted.' },
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

  it('refuses deployment when the validated revision is stale', async () => {
    const workspace = workspaceStub();
    await expect(
      deployValidatedRevisionForBuilder({
        context: operationContext(),
        workspace: workspace as never,
        toolCallId: 'deploy-command',
        validatedRevision: 'c'.repeat(64),
      }),
    ).rejects.toThrow('changed after validation');
    expect(mocks.createDeployment).not.toHaveBeenCalled();
  });

  it('terminalizes the same deterministic deployment after fiber interruption', async () => {
    const workspace = workspaceStub();
    await terminalizeInterruptedDeploymentForBuilder({
      context: operationContext(),
      workspace: workspace as never,
      toolCallId: 'deploy-command:7:revision',
      validatedRevision: 'a'.repeat(64),
    });

    expect(mocks.terminalizeInterrupted).toHaveBeenCalledWith({
      env: expect.anything(),
      userId: 'user-1',
      deploymentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('accepts recovery before the deterministic deployment row was created', async () => {
    mocks.terminalizeInterrupted.mockResolvedValueOnce(null);

    await expect(
      terminalizeInterruptedDeploymentForBuilder({
        context: operationContext(),
        workspace: workspaceStub() as never,
        toolCallId: 'deploy-command:7:revision',
        validatedRevision: 'a'.repeat(64),
      }),
    ).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('before execution started') });
  });

  it('creates and executes one idempotent exact-revision deployment', async () => {
    const workspace = workspaceStub();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);
    await expect(
      deployValidatedRevisionForBuilder({
        context: operationContext(),
        workspace: workspace as never,
        toolCallId: 'deploy-command',
        validatedRevision: 'a'.repeat(64),
      }),
    ).resolves.toEqual({
      id: '11111111-1111-5111-8111-111111111111',
      status: 'succeeded',
      productionUrl: 'https://app.example.com',
      error: null,
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
    expect(mocks.deployForUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', deploymentId: expect.stringMatching(/^[0-9a-f-]{36}$/) }),
    );
  });
});

function workspaceStub() {
  return {
    projectId: 'workspace-1',
    checkpoint: vi.fn(async () => ({ workspaceRevision: 7, revision: 'a'.repeat(64) })),
    hasSuccessfulValidation: vi.fn(async () => false),
    prepareDeployment: vi.fn(async () => ({
      workspaceRevision: 7,
      revision: 'a'.repeat(64),
      project: { type: 'web_app', bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true } },
    })),
  };
}

function operationContext() {
  return { env: {} as Env, userId: 'user-1', chatInitialId: 'chat-1' };
}
