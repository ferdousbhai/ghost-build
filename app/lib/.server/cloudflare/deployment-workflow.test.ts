import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({ build: vi.fn(), publish: vi.fn() }));

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class WorkflowEntrypointMock<Env> {
    protected env: Env;
    constructor(_ctx: ExecutionContext, env: Env) {
      this.env = env;
    }
  },
}));
vi.mock('./deployment-executor', () => ({
  buildApprovedDeploymentArtifact: mocks.build,
  publishApprovedDeploymentArtifact: mocks.publish,
}));

import { DeploymentWorkflow } from './deployment-workflow';

describe('DeploymentWorkflow durable boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.build.mockResolvedValue({ objectKey: 'build-key', receiptSha256: 'a'.repeat(64) });
    mocks.publish.mockResolvedValue({ id: 'deployment-1', status: 'succeeded', productionUrl: 'https://example.com' });
  });

  test('uses two non-retrying steps within the project 30-minute operational budget', async () => {
    const step = {
      do: vi.fn(async (_name: string, _config: unknown, callback: () => Promise<unknown>) => callback()),
    } as unknown as WorkflowStep;
    const workflow = new DeploymentWorkflow({} as ExecutionContext, {} as Env);

    const result = await workflow.run(
      {
        payload: {
          deploymentId: 'deployment-1',
          userId: 'user-1',
          connectionId: 'connection-1',
          executionGeneration: 1,
        },
      } as WorkflowEvent<{
        deploymentId: string;
        userId: string;
        connectionId: string;
        executionGeneration: number;
      }>,
      step,
    );

    expect(step.do).toHaveBeenCalledTimes(2);
    expect(vi.mocked(step.do).mock.calls.map((call) => call[1])).toEqual([
      { retries: { limit: 0, delay: '1 second' }, timeout: '1 hour' },
      { retries: { limit: 0, delay: '1 second' }, timeout: '30 minutes' },
    ]);
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        executionGeneration: 1,
        receipt: expect.objectContaining({ objectKey: 'build-key' }),
      }),
    );
    expect(result).toEqual({
      deploymentId: 'deployment-1',
      status: 'succeeded',
      productionUrl: 'https://example.com',
    });
  });

  test('rejects a missing execution generation before starting durable work', async () => {
    const step = { do: vi.fn() } as unknown as WorkflowStep;
    const workflow = new DeploymentWorkflow({} as ExecutionContext, {} as Env);

    await expect(
      workflow.run(
        {
          payload: { deploymentId: 'deployment-1', userId: 'user-1', connectionId: 'connection-1' },
        } as WorkflowEvent<{
          deploymentId: string;
          userId: string;
          connectionId: string;
          executionGeneration: number;
        }>,
        step,
      ),
    ).rejects.toThrow('executionGeneration is invalid');
    expect(step.do).not.toHaveBeenCalled();
  });
});
