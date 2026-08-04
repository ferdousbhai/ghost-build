import { describe, expect, test } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { latestPendingDeploymentPlan } from './deployment-continuation';

const deployment = {
  id: 'deployment-2',
  planDigest: 'c'.repeat(64),
  resources: [] as Array<{ type: string; logicalName: string; proposedName: string }>,
};

describe('latestPendingDeploymentPlan', () => {
  test('stops automatic continuation from the typed deploy output', () => {
    const messages: GhostbuildMessage[] = [
      {
        id: 'assistant-structured',
        role: 'assistant',
        parts: [
          {
            type: 'tool-deploy',
            toolCallId: 'deploy-structured',
            state: 'output-available',
            input: { validatedRevision: 'b'.repeat(64) },
            output: {
              version: 1,
              ok: true,
              summary: 'ready',
              data: { state: 'awaiting-approval', revision: 'b'.repeat(64), deployment },
            },
          },
        ],
      },
    ];

    expect(latestPendingDeploymentPlan(messages)).toEqual(deployment);
  });

  test('does not stop a later user-requested turn', () => {
    const messages: GhostbuildMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-deploy',
            toolCallId: 'deploy-1',
            state: 'output-available',
            input: { validatedRevision: 'b'.repeat(64) },
            output: {
              version: 1,
              ok: true,
              summary: 'ready',
              data: { state: 'awaiting-approval', deployment },
            },
          },
        ],
      },
      { id: 'user-2', role: 'user', parts: [{ type: 'text', text: 'Change the title.' }] },
    ];

    expect(latestPendingDeploymentPlan(messages)).toBeNull();
  });

  test('does not infer deployment state from prose', () => {
    const messages: GhostbuildMessage[] = [
      {
        id: 'assistant-prose',
        role: 'assistant',
        parts: [{ type: 'text', text: `GHOSTBUILD_DEPLOYMENT_PLAN:${JSON.stringify(deployment)}` }],
      },
    ];
    expect(latestPendingDeploymentPlan(messages)).toBeNull();
  });
});
