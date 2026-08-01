import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  validate: vi.fn(),
  deploymentId: vi.fn(),
  createDeployment: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock('~/lib/.server/cloudflare/builder-project-sandbox', () => ({
  installBuilderDependencies: mocks.install,
  validateBuilderProject: mocks.validate,
  deterministicDeploymentId: mocks.deploymentId,
}));
vi.mock('~/server-handlers/deployments', () => ({
  createOrReplayDeploymentPlanForUser: mocks.createDeployment,
}));
vi.mock('./builder-workspace-snapshot', () => ({
  createBuilderWorkspaceSnapshot: mocks.snapshot,
}));

import { executeBuilderOperationTool } from './builder-operation-tools';

describe('server Builder operation tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.snapshot.mockResolvedValue({
      workspaceRevision: 7,
      revision: 'a'.repeat(64),
      bytes: new Uint8Array([1, 2, 3]),
    });
    mocks.validate.mockResolvedValue({ durationMs: 123 });
    mocks.deploymentId.mockResolvedValue('11111111-1111-5111-8111-111111111111');
    mocks.createDeployment.mockResolvedValue({
      id: '11111111-1111-5111-8111-111111111111',
      planDigest: 'b'.repeat(64),
      plan: { resources: [{ type: 'worker', logicalName: 'app', proposedName: 'app' }] },
    });
  });

  it('validates the durable snapshot in the server sandbox and records the exact revision', async () => {
    const workspace = workspaceStub();
    const onValidationStage = vi.fn();
    mocks.validate.mockImplementationOnce(async ({ onStage }) => {
      onStage('dependency installation');
      return { durationMs: 123 };
    });
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
        buildEnvironment: 'remote-sandbox',
      },
    });
    expect(mocks.validate).toHaveBeenCalledWith(expect.objectContaining({ snapshot: expect.any(Uint8Array) }));
    expect(workspace.recordSuccessfulValidation).toHaveBeenCalledWith({
      revision: 'a'.repeat(64),
      workspaceRevision: 7,
    });
    expect(onValidationStage.mock.calls).toEqual([
      ['validation-call', 'dependency installation'],
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
    workspace.hasSuccessfulValidation.mockReturnValue(true);
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
        deploymentId: '11111111-1111-5111-8111-111111111111',
        snapshot: expect.any(Blob),
      }),
    );
  });
});

function workspaceStub() {
  const workspace = {
    getState: vi.fn(() => ({ initialized: true, revision: 7 })),
    executeToolOnce: vi.fn(async (_id, _name, _args, execute: () => Promise<unknown>) => execute()),
    recordSuccessfulValidation: vi.fn(),
    hasSuccessfulValidation: vi.fn(() => false),
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
